import type { ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  countPublished,
  ensureGuildConfig,
  getDb,
  setLastEmbedMsgCount,
  setPublished,
  setTranscript,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { fetchStarterWithRetry, fetchTranscript, forumParent } from './forum';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'knowledge' });

const DEBOUNCE_MS = 4000;
// Knowledge threads have no solve point, so they re-capture + re-embed on a
// quadrupling schedule keyed off the thread's message count: at ~1, 4, 16, 64, … msgs.
// Early posts (where the topic is still forming) refresh sooner; once a thread is
// large the content has settled, so re-scans get exponentially rarer and stop
// entirely past the cap. Growth factor 4 keeps the whole-thread coverage but with
// ~half as many scans as plain doubling. Avoids re-embedding on every reply.
const REEMBED_GROWTH = 4;
const REEMBED_MAX_MESSAGES = 256;

/** Is this thread due for a (re-)embed given the count at its last embed? */
export function isReembedDue(currentCount: number, lastEmbedCount: number | null): boolean {
  const last = lastEmbedCount ?? 0;
  if (last <= 0) return true; // never embedded → always capture the first time
  if (last >= REEMBED_MAX_MESSAGES) return false; // settled → stop re-scanning
  return currentCount >= last * REEMBED_GROWTH; // only after the count has doubled
}

/** Threads already scheduled, so threadCreate + messageCreate collapse to one run. */
const scheduled = new Set<string>();

/**
 * Knowledge channels are a pure archive: every new thread is captured, indexed,
 * and (opt-in) published to the public KB — no unsolved tag, control message, or
 * duplicate reminder. Debounced + idempotent-by-thread-id like dedup, so the
 * starter message has time to arrive and both event triggers collapse to one run.
 */
export function scheduleKnowledgeArchive(thread: ThreadChannel): void {
  if (scheduled.has(thread.id)) return;
  scheduled.add(thread.id);
  const timer = setTimeout(() => {
    void archiveKnowledgeThread(thread)
      .catch((err) => log.warn({ err, threadId: thread.id }, 'knowledge archive failed'))
      .finally(() => scheduled.delete(thread.id));
  }, DEBOUNCE_MS);
  timer.unref();
}

async function archiveKnowledgeThread(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  const guildId = thread.guildId;
  const forum = forumParent(thread);
  if (!forum) return;

  const cfg = await ensureGuildConfig(db, guildId);
  // The channel's mode could have changed during the debounce window.
  if (channelMode(cfg, forum.id) !== 'knowledge') return;

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

  // Publish to the public KB (opt-in + page cap). This runs on every archive,
  // independent of the re-embed backoff below, so a thread is published promptly
  // once the guild opts in or the page cap frees up — even between re-embed
  // checkpoints. Skipped when already published (idempotent, avoids re-revalidating).
  if (cfg.kbPublishOptIn && !row.doNotPublish && !row.duplicateOfThreadId && !row.publishedToKb) {
    try {
      const limits = limitsFor(await getGuildTier(guildId));
      if ((await countPublished(db, guildId)) < limits.kbPageCap) {
        await setPublished(db, guildId, thread.id, true);
        await enqueueRevalidateKb({ guildId, threadId: thread.id, action: 'publish' });
      }
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to publish knowledge thread');
    }
  }

  // Exponential backoff: skip the expensive transcript re-capture + re-embed unless
  // the thread has grown enough since the last embed (the cheap upsert above already
  // kept the title/body fresh). The first capture (lastEmbedMsgCount null) always runs.
  const msgCount = thread.totalMessageSent ?? thread.messageCount ?? 0;
  if (!isReembedDue(msgCount, row.lastEmbedMsgCount)) {
    log.debug(
      { threadId: thread.id, msgCount, lastEmbed: row.lastEmbedMsgCount },
      'knowledge thread not yet due for re-embed',
    );
    return;
  }

  // Capture the post body (+ any early replies) for the KB page.
  try {
    const transcript = await fetchTranscript(thread);
    if (transcript.length > 0) await setTranscript(db, row.id, transcript);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to capture knowledge transcript');
  }

  // Index for /dejavue search + MCP (the post body is the content — no answer).
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

  // Advance the backoff watermark ONLY when a re-embed was actually enqueued. If the
  // queue was briefly down we must not move it — otherwise isReembedDue would skip
  // this thread until its count doubles again (possibly never, past the cap), leaving
  // the new content unindexed. pg-boss then guarantees the enqueued job eventually runs.
  // max(.,1) guards against providers that don't report a count.
  if (embedQueued) await setLastEmbedMsgCount(db, row.id, Math.max(msgCount, 1));
}
