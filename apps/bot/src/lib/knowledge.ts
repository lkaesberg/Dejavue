import type { ThreadChannel } from 'discord.js';
import { embedContentHash } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  ensureGuildConfig,
  getDb,
  getThreadByDiscordId,
  markChannelStale,
  setPublished,
  setThreadLabels,
  setTranscript,
  type TranscriptMessage,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { refreshForumFreshness } from './channelFreshness';
import { keyedTrailingDebounce } from './debounce';
import { fetchStarterWithRetry, fetchTranscript, forumParent, threadLabels } from './forum';
import { atIndexCap } from './tier';

const log = childLogger({ mod: 'knowledge' });

const DEBOUNCE_MS = 4000;
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

  // Re-index for search/MCP whenever the thread's content changed at all. There is no
  // growth backoff any more: the embed job diffs chunk hashes and only re-embeds the ones
  // that actually moved, so an extra reply costs a chunk rather than a whole thread. If
  // the capture failed, compare against the stored transcript so a transient empty read
  // doesn't look like a content change.
  const transcript = captured.length > 0 ? captured : (row.transcript ?? []);
  const dirty =
    row.embedContentHash !==
    embedContentHash({ title: row.title, questionBody: row.questionBody, transcript });
  if (dirty) {
    await enqueueEmbedThread({
      threadRowId: row.id,
      guildId,
      modelId: cfg.embeddingModel,
      title: row.title,
      question: row.questionBody,
      answer: null,
    }).catch((err) => log.warn({ err, threadId: thread.id }, 'failed to enqueue knowledge embed'));
  }

  // Keep per-channel freshness current for the /dejavue setup hub (don't clobber a
  // running reindex or first-setup import).
  await refreshForumFreshness(guildId, forum.id);
}
