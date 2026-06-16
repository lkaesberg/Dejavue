import type { ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  countPublished,
  ensureGuildConfig,
  getDb,
  setPublished,
  setTranscript,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { fetchStarterWithRetry, fetchTranscript, forumParent } from './forum';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'knowledge' });

const DEBOUNCE_MS = 4000;

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

  // Capture the post body (+ any early replies) for the KB page.
  try {
    const transcript = await fetchTranscript(thread);
    if (transcript.length > 0) await setTranscript(db, row.id, transcript);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to capture knowledge transcript');
  }

  // Index for /dejavue search + MCP (the post body is the content — no answer).
  try {
    await enqueueEmbedThread({
      threadRowId: row.id,
      guildId,
      modelId: cfg.embeddingModel,
      title: row.title,
      question: row.questionBody,
      answer: null,
    });
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to enqueue knowledge embed');
  }

  // Publish to the public KB (opt-in + page cap), just like a solved thread.
  if (cfg.kbPublishOptIn && !row.doNotPublish && !row.duplicateOfThreadId) {
    try {
      const limits = limitsFor(await getGuildTier(guildId));
      const published = await countPublished(db, guildId);
      if (published < limits.kbPageCap) {
        await setPublished(db, guildId, thread.id, true);
        await enqueueRevalidateKb({ guildId, threadId: thread.id, action: 'publish' });
      }
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to publish knowledge thread');
    }
  }
}
