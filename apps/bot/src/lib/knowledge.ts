import type { ThreadChannel } from 'discord.js';
import { embedContentHash } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  countIndexedMessagesInChannel,
  ensureChannelSync,
  ensureGuildConfig,
  getDb,
  getThreadByDiscordId,
  markChannelStale,
  markChannelSynced,
  setLastEmbedMsgCount,
  setPublished,
  setThreadLabels,
  setTranscript,
  type TranscriptMessage,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { keyedTrailingDebounce } from './debounce';
import { fetchStarterWithRetry, fetchTranscript, forumParent, threadLabels } from './forum';
import { atIndexCap } from './tier';

const log = childLogger({ mod: 'knowledge' });

const DEBOUNCE_MS = 4000;
// The KB *page* always shows the full chat log (we re-capture the transcript on
// every message). EMBEDDING for search re-runs whenever the embed-source text changes
// (an edit/delete/answer change — see embedContentHash) and, while a thread is still
// forming, on a quadrupling growth schedule keyed off the message count (~1, 4, 16, 64,
// …) so a long, settled thread isn't re-scanned on every reply.
const REEMBED_GROWTH = 4;
const REEMBED_MAX_MESSAGES = 256;

/**
 * Is this thread due for a (re-)embed?
 *
 * Growth follows a backoff: re-embed on the first index, then progressively rarer as the
 * thread grows (~1, 4, 16, 64, …), stopping once it's settled — so an active thread isn't
 * re-embedded on every message.
 *
 * Edits/deletes still propagate: when the embed-source text changed (`hashDirty`) WITHOUT
 * the thread growing (count didn't increase — a message was edited or removed), we
 * re-embed immediately regardless of the backoff. Pure growth never trips this branch, so
 * it stays on the backoff cadence.
 */
export function isReembedDue(
  currentCount: number,
  lastEmbedCount: number | null,
  hashDirty = false,
): boolean {
  const last = lastEmbedCount ?? 0;
  if (last <= 0) return true; // never embedded → always index the first time
  if (hashDirty && currentCount <= last) return true; // in-place change (edit/delete)
  if (last >= REEMBED_MAX_MESSAGES) return false; // settled → stop re-scanning
  return currentCount >= last * REEMBED_GROWTH; // only after the count has quadrupled
}

/**
 * Knowledge channels are a pure archive: every new thread is captured, indexed, and
 * published to the public KB — no unsolved tag, control message, or duplicate
 * reminder. Debounced (trailing-safe) so the starter message has time to arrive,
 * threadCreate + messageCreate collapse to one run, and a message landing while a
 * capture is in flight still triggers a follow-up capture.
 */
const debouncedKnowledgeArchive = keyedTrailingDebounce<ThreadChannel>(
  DEBOUNCE_MS,
  archiveKnowledgeThread,
  (err, thread) => log.warn({ err, threadId: thread.id }, 'knowledge archive failed'),
);

export function scheduleKnowledgeArchive(thread: ThreadChannel): void {
  debouncedKnowledgeArchive(thread.id, thread);
}

async function archiveKnowledgeThread(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  const guildId = thread.guildId;
  const forum = forumParent(thread);
  if (!forum) return;

  const cfg = await ensureGuildConfig(db, guildId);
  // The channel's mode could have changed during the debounce window.
  if (channelMode(cfg, forum.id) !== 'knowledge') return;

  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  // Stop indexing NEW threads once at the unified index cap (existing keep updating).
  if (!existing && (await atIndexCap(guildId))) {
    await markChannelStale(db, guildId, forum.id, 'forum', 'cap');
    return;
  }

  const body = await fetchStarterWithRetry(thread);
  const row = await upsertThread(db, {
    guildId,
    channelId: thread.parentId ?? '',
    channelName: forum.name,
    threadId: thread.id,
    title: thread.name,
    questionBody: body,
    opUserId: thread.ownerId ?? null,
    status: 'open',
  });

  // Everything indexed is auto-published (the public site itself is gated by
  // kbPublishOptIn + passphrase, but the row is always marked published).
  if (!row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
    try {
      await setPublished(db, guildId, thread.id, true);
      await enqueueRevalidateKb({ guildId, threadId: thread.id, action: 'publish' });
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to publish knowledge thread');
    }
  }

  // The KB page must always show every message: re-capture the full transcript on
  // each new message (the 4s debounce collapses bursts so this isn't per-keystroke).
  let captured: TranscriptMessage[] = [];
  try {
    captured = await fetchTranscript(thread);
    if (captured.length > 0) await setTranscript(db, row.id, captured);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to capture knowledge transcript');
  }
  // Keep custom forum labels current for the KB + filtering.
  await setThreadLabels(db, guildId, thread.id, threadLabels(thread)).catch(() => undefined);

  // Re-index for search/MCP when the embed-source text changed (edit/delete) or on the
  // growth backoff. If the capture failed, compare against the stored transcript so a
  // transient empty read doesn't look like a content change.
  const transcript = captured.length > 0 ? captured : (row.transcript ?? []);
  // Count from the captured human messages (decreases on delete, so the edit/delete
  // branch in isReembedDue fires), not the lifetime totalMessageSent.
  const msgCount = transcript.length;
  const dirty =
    row.embedContentHash !==
    embedContentHash({ title: row.title, questionBody: row.questionBody, transcript });
  if (isReembedDue(msgCount, row.lastEmbedMsgCount, dirty)) {
    let embedQueued = false;
    try {
      await enqueueEmbedThread({
        threadRowId: row.id,
        guildId,
        modelId: cfg.embeddingModel,
        title: row.title,
        question: row.questionBody,
        answer: null,
      });
      embedQueued = true;
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to enqueue knowledge embed');
    }
    // Advance the watermark only when an embed was actually enqueued (so a brief queue
    // outage doesn't strand new content unindexed until the count quadruples again).
    if (embedQueued) await setLastEmbedMsgCount(db, row.id, Math.max(msgCount, 1));
  }

  // Keep per-channel freshness current for the /dejavue setup hub (don't clobber a reindex).
  const sync = await ensureChannelSync(db, guildId, forum.id, 'forum');
  if (sync.state !== 'reindexing') {
    const count = await countIndexedMessagesInChannel(db, guildId, forum.id);
    await markChannelSynced(db, guildId, forum.id, 'forum', null, count);
  }
}
