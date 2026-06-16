import type { Message, ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  countPublished,
  ensureGuildConfig,
  getDb,
  getThreadByDiscordId,
  markThreadSolved,
  setPublished,
  setThreadStatus,
  setTranscript,
  upsertThread,
  type Thread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { applyTag, fetchTranscript, findForumTags, forumParent, getStarterText } from './forum';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'solve' });

/** Get-or-create the archive row for a forum thread, hydrating from the starter message. */
export async function ensureThreadRow(thread: ThreadChannel): Promise<Thread> {
  const db = getDb();
  const guildId = thread.guildId;
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing) return existing;

  const starter = await getStarterText(thread);
  return upsertThread(db, {
    guildId,
    channelId: thread.parentId ?? '',
    channelName: forumParent(thread)?.name ?? null,
    threadId: thread.id,
    title: thread.name,
    questionBody: starter?.content ?? '',
    opUserId: starter?.authorId ?? thread.ownerId ?? null,
    status: 'open',
  });
}

/** Apply the per-forum "unsolved" tag to a freshly created post (never to a solved one). */
export async function tagUnsolved(thread: ThreadChannel): Promise<void> {
  const forum = forumParent(thread);
  if (!forum) return;
  const { solvedTagId, unsolvedTagId } = findForumTags(forum);
  if (!unsolvedTagId) return;
  // Never mark an already-solved post unsolved (avoids both tags at once).
  if (solvedTagId && thread.appliedTags.includes(solvedTagId)) return;
  try {
    await applyTag(thread, unsolvedTagId);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to apply unsolved tag');
  }
}

export interface SolveOptions {
  /** The accepted answer as a Discord message (context menu "Mark as Answer"). */
  answer?: Message;
  /** Or the accepted answer as raw text (typed in a modal / borrowed from a duplicate). */
  answerText?: string;
  answerAuthorId?: string;
  solverId: string;
}

/** Swap solved/unsolved tags, persist the accepted answer, archive + index + (opt-in) publish. */
export async function solveThread(
  thread: ThreadChannel,
  opts: SolveOptions,
): Promise<Thread | undefined> {
  const db = getDb();
  const guildId = thread.guildId;
  const cfg = await ensureGuildConfig(db, guildId);
  await ensureThreadRow(thread);

  const forum = forumParent(thread);
  if (forum) {
    const { solvedTagId, unsolvedTagId } = findForumTags(forum);
    try {
      // Rebuild the tag set explicitly so solved/unsolved are never both present.
      const tags = new Set(thread.appliedTags);
      if (unsolvedTagId) tags.delete(unsolvedTagId);
      if (solvedTagId) tags.add(solvedTagId);
      await thread.setAppliedTags([...tags].slice(0, 5));
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to swap tags on solve');
    }
  }

  const row = await markThreadSolved(db, {
    guildId,
    discordThreadId: thread.id,
    answerMessageId: opts.answer?.id ?? null,
    answerText: opts.answer?.content ?? opts.answerText ?? null,
    answerAuthorId: opts.answer?.author.id ?? opts.answerAuthorId ?? opts.solverId,
  });
  if (!row) return undefined;

  // Capture the full conversation for the public KB (best effort).
  try {
    const transcript = await fetchTranscript(thread);
    if (transcript.length > 0) await setTranscript(db, row.id, transcript);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to capture transcript');
  }

  const limits = limitsFor(await getGuildTier(guildId));

  // Index the solved post for semantic search (heavy embedding → worker).
  try {
    await enqueueEmbedThread({
      threadRowId: row.id,
      guildId,
      modelId: cfg.embeddingModel,
      title: row.title,
      question: row.questionBody,
      answer: row.acceptedAnswerText,
    });
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to enqueue embed-thread');
  }

  // AI summaries are generated lazily — only when a KB page is actually opened
  // (see apps/web) — so we never pay to summarize threads nobody reads.

  // Public KB (all tiers, opt-in, capped). Duplicates are never published on
  // their own — they're folded under the canonical thread.
  if (cfg.kbPublishOptIn && !row.doNotPublish && !row.duplicateOfThreadId) {
    try {
      const published = await countPublished(db, guildId);
      if (published < limits.kbPageCap) {
        await setPublished(db, guildId, thread.id, true);
        await enqueueRevalidateKb({ guildId, threadId: thread.id, action: 'publish' });
      }
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to publish to KB');
    }
  }

  return row;
}

/** Close a resolved thread: lock + archive it (Discord's "done" state). */
export async function closeThread(thread: ThreadChannel): Promise<void> {
  try {
    if (!thread.locked) await thread.setLocked(true);
    if (!thread.archived) await thread.setArchived(true);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to close thread');
  }
}

/** Re-open a thread (unarchive + unlock + unpublish its KB page). */
export async function unsolveThread(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  try {
    if (thread.archived) await thread.setArchived(false);
    if (thread.locked) await thread.setLocked(false);
  } catch {
    /* best effort */
  }
  await setThreadStatus(db, thread.guildId, thread.id, 'unsolved');
  await setPublished(db, thread.guildId, thread.id, false);
  await enqueueRevalidateKb({ guildId: thread.guildId, threadId: thread.id, action: 'unpublish' }).catch(
    () => undefined,
  );
  const forum = forumParent(thread);
  if (forum) {
    const { solvedTagId, unsolvedTagId } = findForumTags(forum);
    try {
      const tags = new Set(thread.appliedTags);
      if (solvedTagId) tags.delete(solvedTagId);
      if (unsolvedTagId) tags.add(unsolvedTagId);
      await thread.setAppliedTags([...tags].slice(0, 5));
    } catch {
      /* best effort */
    }
  }
}
