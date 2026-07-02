import type { Message, ThreadChannel } from 'discord.js';
import { embedContentHash } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import {
  ensureGuildConfig,
  getDb,
  getThreadByDiscordId,
  markThreadSolved,
  setPublished,
  setThreadLabels,
  setThreadStatus,
  setTranscript,
  type Thread,
  type TranscriptMessage,
  upsertThread,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { keyedTrailingDebounce } from './debounce';
import { SOLVE_BUTTON_ID, solvedNotice } from './embeds';
import {
  applyTag,
  fetchTranscript,
  findOrCreateForumTags,
  forumParent,
  getStarterText,
  threadLabels,
} from './forum';
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

// Q&A threads keep their KB transcript current on every message too (not only at
// solve), so the published page always shows the whole chat log. Embedding still
// happens at solve (with the accepted answer) — this only refreshes the transcript.
const QUESTION_DEBOUNCE_MS = 4000;

/** Debounced (trailing-safe) transcript refresh for a question post. */
const debouncedQuestionArchive = keyedTrailingDebounce<ThreadChannel>(
  QUESTION_DEBOUNCE_MS,
  captureQuestionTranscript,
  (err, thread) => log.warn({ err, threadId: thread.id }, 'question transcript capture failed'),
);

export function scheduleQuestionArchive(thread: ThreadChannel): void {
  debouncedQuestionArchive(thread.id, thread);
}

async function captureQuestionTranscript(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  const row = await ensureThreadRow(thread);
  let captured: TranscriptMessage[] = [];
  try {
    captured = await fetchTranscript(thread);
    if (captured.length > 0) await setTranscript(db, row.id, captured);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to capture question transcript');
  }
  await setThreadLabels(db, thread.guildId, thread.id, threadLabels(thread)).catch(() => undefined);

  // A solved post is embedded; if an edit/delete changed its content, re-embed so
  // search stays accurate. (Unsolved posts aren't embedded until solve.)
  if (row.status === 'solved') {
    const transcript = captured.length > 0 ? captured : (row.transcript ?? []);
    const dirty =
      row.embedContentHash !==
      embedContentHash({
        title: row.title,
        questionBody: row.questionBody,
        acceptedAnswerText: row.acceptedAnswerText,
        transcript,
      });
    if (dirty) {
      const cfg = await ensureGuildConfig(db, thread.guildId);
      await enqueueEmbedThread({
        threadRowId: row.id,
        guildId: thread.guildId,
        modelId: cfg.embeddingModel,
        title: row.title,
        question: row.questionBody,
        answer: row.acceptedAnswerText,
      }).catch((err) => log.warn({ err, threadId: thread.id }, 'failed to re-embed edited thread'));
    }
  }
}

/** Apply the per-forum "unsolved" tag to a freshly created post (never to a solved one). */
export async function tagUnsolved(thread: ThreadChannel): Promise<void> {
  const forum = forumParent(thread);
  if (!forum) return;
  const { solvedTagId, unsolvedTagId } = await findOrCreateForumTags(forum, log);
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
  /** The "mark as solved" control message id, when the caller already knows it (modal path). */
  controlMessageId?: string;
}

/** Find the bot's control/prompt message in a thread by its solve button. */
async function findControlMessage(thread: ThreadChannel): Promise<Message | null> {
  try {
    // The control message is posted right after the starter, so the first page suffices.
    const msgs = await thread.messages.fetch({ after: thread.id, limit: 20 });
    for (const m of msgs.values()) {
      if (!m.author.bot) continue;
      for (const row of m.components) {
        const comps = (row as { components?: { customId?: string | null }[] }).components ?? [];
        if (comps.some((c) => c.customId === SOLVE_BUTTON_ID)) return m;
      }
    }
  } catch {
    /* best effort */
  }
  return null;
}

/**
 * Resolve the "select the answer" control prompt once a thread is solved: delete it
 * (default — declutters the thread) or, if the guild turned that off, edit it into a
 * "solved" notice.
 */
async function resolveControlPrompt(
  thread: ThreadChannel,
  removeSolvedPrompt: boolean,
  opts: SolveOptions,
): Promise<void> {
  const msg = opts.controlMessageId
    ? await thread.messages.fetch(opts.controlMessageId).catch(() => null)
    : await findControlMessage(thread);
  if (!msg) return;
  if (removeSolvedPrompt) {
    await msg.delete().catch(() => undefined);
    return;
  }
  const showBranding = !limitsFor(await getGuildTier(thread.guildId)).removeBranding;
  const answerAuthorId = opts.answer?.author.id ?? opts.answerAuthorId ?? opts.solverId;
  await msg
    .edit(solvedNotice({ showBranding, solverId: opts.solverId, answerAuthorId }))
    .catch(() => undefined);
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
    // Creates the tags on the fly if missing — otherwise the DB would say
    // "solved" while the visible thread tag stayed "unsolved".
    const { solvedTagId, unsolvedTagId } = await findOrCreateForumTags(forum, log);
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
  // Capture the thread's custom forum labels for the KB + filtering.
  await setThreadLabels(db, guildId, thread.id, threadLabels(thread)).catch(() => undefined);

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

  // Everything indexed is auto-published (online). The public site itself is gated by
  // kbPublishOptIn + the passphrase. Duplicates are never published on their own —
  // they're folded under the canonical thread.
  if (!row.doNotPublish && !row.duplicateOfThreadId) {
    try {
      await setPublished(db, guildId, thread.id, true);
      await enqueueRevalidateKb({ guildId, threadId: thread.id, action: 'publish' });
    } catch (err) {
      log.warn({ err, threadId: thread.id }, 'failed to publish to KB');
    }
  }

  // Declutter: remove the "select the answer" control prompt (or, if disabled, mark it).
  await resolveControlPrompt(thread, cfg.removeSolvedPrompt, opts).catch(() => undefined);

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
    const { solvedTagId, unsolvedTagId } = await findOrCreateForumTags(forum, log);
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
