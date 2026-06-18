import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, thread, type NewThread, type Thread, type TranscriptMessage } from '../schema';

/** Insert or update a thread, keyed by (guildId, discord threadId). */
export async function upsertThread(db: Database, values: NewThread): Promise<Thread> {
  const [row] = await db
    .insert(thread)
    .values(values)
    .onConflictDoUpdate({
      target: [thread.guildId, thread.threadId],
      set: {
        title: values.title,
        questionBody: values.questionBody ?? '',
        opUserId: values.opUserId,
        channelName: values.channelName,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('upsertThread returned no row');
  return row;
}

export async function getThreadByDiscordId(
  db: Database,
  guildId: string,
  discordThreadId: string,
): Promise<Thread | undefined> {
  const [row] = await db
    .select()
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)))
    .limit(1);
  return row;
}

/** Fetch a thread by its row uuid (used by the embed job to read the transcript). */
export async function getThreadByRowId(db: Database, id: string): Promise<Thread | undefined> {
  const [row] = await db.select().from(thread).where(eq(thread.id, id)).limit(1);
  return row;
}

export interface MarkSolvedInput {
  guildId: string;
  discordThreadId: string;
  /** The accepted answer, when one was explicitly chosen (context menu). */
  answerMessageId?: string | null;
  answerText?: string | null;
  answerAuthorId?: string | null;
}

export async function markThreadSolved(
  db: Database,
  input: MarkSolvedInput,
): Promise<Thread | undefined> {
  const [row] = await db
    .update(thread)
    .set({
      status: 'solved',
      acceptedAnswerMessageId: input.answerMessageId ?? null,
      acceptedAnswerText: input.answerText ?? null,
      acceptedAnswerAuthorId: input.answerAuthorId ?? null,
      solvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(thread.guildId, input.guildId), eq(thread.threadId, input.discordThreadId)))
    .returning();
  return row;
}

export async function setThreadStatus(
  db: Database,
  guildId: string,
  discordThreadId: string,
  status: Thread['status'],
): Promise<void> {
  await db
    .update(thread)
    .set({ status, updatedAt: new Date(), ...(status !== 'solved' ? { solvedAt: null } : {}) })
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)));
}

export type StatusCounts = { open: number; solved: number; unsolved: number };

export async function countByStatus(db: Database, guildId: string): Promise<StatusCounts> {
  // Forum posts only — tracked normal-channel segments have their own quota/count.
  const rows = await db
    .select({ status: thread.status, count: sql<number>`count(*)::int` })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.kind, 'forum')))
    .groupBy(thread.status);
  const out: StatusCounts = { open: 0, solved: 0, unsolved: 0 };
  for (const r of rows) out[r.status] = r.count;
  return out;
}

/** Count solved threads already indexed in the archive (for the Free archive cap). */
export async function countSolved(db: Database, guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.kind, 'forum'), eq(thread.status, 'solved')));
  return row?.count ?? 0;
}

/**
 * Count indexed conversation segments captured from tracked normal channels
 * (separate from the forum archive). Used to enforce the tier's `trackedDocCap`.
 */
export async function countTracked(db: Database, guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.kind, 'channel')));
  return row?.count ?? 0;
}

/** Fetch title + accepted answer for a set of thread row ids (for AI drafting). */
export async function getThreadsByRowIds(
  db: Database,
  ids: string[],
): Promise<{ id: string; title: string; acceptedAnswerText: string | null }[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: thread.id,
      title: thread.title,
      acceptedAnswerText: thread.acceptedAnswerText,
    })
    .from(thread)
    .where(inArray(thread.id, ids));
}

/** Store the AI-summarized canonical answer (Pro). */
export async function setCanonicalSummary(
  db: Database,
  threadRowId: string,
  summary: string,
): Promise<void> {
  await db
    .update(thread)
    .set({ canonicalSummary: summary, updatedAt: new Date() })
    .where(eq(thread.id, threadRowId));
}

/**
 * Mark a thread as a duplicate of a canonical thread (folded in the KB). Folding
 * also unpublishes it: a duplicate is never a standalone KB page, so leaving it
 * published would waste the tier's page cap and orphan a no-longer-reachable URL.
 * Callers should enqueue a KB revalidation (unpublish/410) if a page may have existed.
 */
export async function setDuplicateOf(
  db: Database,
  guildId: string,
  discordThreadId: string,
  originalThreadId: string,
): Promise<void> {
  await db
    .update(thread)
    .set({ duplicateOfThreadId: originalThreadId, publishedToKb: false, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)));
}

/** Record the thread message count at the last (re-)embed (knowledge backoff schedule). */
export async function setLastEmbedMsgCount(
  db: Database,
  threadRowId: string,
  count: number,
): Promise<void> {
  await db
    .update(thread)
    .set({ lastEmbedMsgCount: count, updatedAt: new Date() })
    .where(eq(thread.id, threadRowId));
}

/**
 * Solved threads that lack an embedding produced by `activeModelId` — i.e. they
 * have no embedding at all, or only one from a different model (so a model/
 * provider switch surfaces them all for re-embedding). Used to catch up on startup.
 */
export async function getSolvedThreadsMissingEmbedding(
  db: Database,
  guildId: string,
  activeModelId: string,
  limit = 500,
): Promise<{ id: string; guildId: string; title: string; questionBody: string; acceptedAnswerText: string | null }[]> {
  return db
    .select({
      id: thread.id,
      guildId: thread.guildId,
      title: thread.title,
      questionBody: thread.questionBody,
      acceptedAnswerText: thread.acceptedAnswerText,
    })
    .from(thread)
    .leftJoin(
      embedding,
      and(eq(embedding.threadId, thread.id), eq(embedding.modelId, activeModelId)),
    )
    .where(and(eq(thread.guildId, guildId), eq(thread.status, 'solved'), isNull(embedding.id)))
    .limit(limit);
}

/**
 * Threads in a channel lacking an `activeModelId` embedding, regardless of status
 * (knowledge channels). Catches both never-embedded and stale-model threads.
 */
export async function getThreadsMissingEmbeddingInChannel(
  db: Database,
  guildId: string,
  channelId: string,
  activeModelId: string,
  limit = 500,
): Promise<{ id: string; guildId: string; title: string; questionBody: string; acceptedAnswerText: string | null }[]> {
  return db
    .select({
      id: thread.id,
      guildId: thread.guildId,
      title: thread.title,
      questionBody: thread.questionBody,
      acceptedAnswerText: thread.acceptedAnswerText,
    })
    .from(thread)
    .leftJoin(
      embedding,
      and(eq(embedding.threadId, thread.id), eq(embedding.modelId, activeModelId)),
    )
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId), isNull(embedding.id)))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Deletion / reconciliation — keep the index in sync with Discord reality.
// Embeddings cascade (FK onDelete: cascade); generation_event / cluster medoid
// FKs are set null, so deleting a thread never orphans or errors.
// ---------------------------------------------------------------------------

/** Delete a thread (and its embeddings) by discord thread id. Returns rows removed. */
export async function deleteThreadByDiscordId(
  db: Database,
  guildId: string,
  discordThreadId: string,
): Promise<number> {
  // Un-fold any duplicates that pointed at this (soon-deleted) canonical so they
  // don't stay hidden under a thread that no longer exists.
  await db
    .update(thread)
    .set({ duplicateOfThreadId: null, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.duplicateOfThreadId, discordThreadId)));
  const rows = await db
    .delete(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)))
    .returning({ id: thread.id });
  return rows.length;
}

/** Delete every thread (and embeddings) belonging to a forum channel. Returns rows removed. */
export async function deleteThreadsByChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<number> {
  await db
    .update(thread)
    .set({ duplicateOfThreadId: null, updatedAt: new Date() })
    .where(
      and(
        eq(thread.guildId, guildId),
        sql`${thread.duplicateOfThreadId} in (select thread_id from thread where guild_id = ${guildId} and channel_id = ${channelId})`,
      ),
    );
  const rows = await db
    .delete(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId)))
    .returning({ id: thread.id });
  return rows.length;
}

/** Delete a set of threads by discord thread id (bulk prune). Returns rows removed. */
export async function deleteThreadsByDiscordIds(
  db: Database,
  guildId: string,
  discordThreadIds: string[],
): Promise<number> {
  if (discordThreadIds.length === 0) return 0;
  await db
    .update(thread)
    .set({ duplicateOfThreadId: null, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), inArray(thread.duplicateOfThreadId, discordThreadIds)));
  const rows = await db
    .delete(thread)
    .where(and(eq(thread.guildId, guildId), inArray(thread.threadId, discordThreadIds)))
    .returning({ id: thread.id });
  return rows.length;
}

/** All discord thread ids we have indexed for a channel (to diff against Discord). */
export async function listThreadIdsByChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<string[]> {
  const rows = await db
    .select({ threadId: thread.threadId })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId)));
  return rows.map((r) => r.threadId);
}

/** Keep the denormalized channel name on threads current after a forum rename. */
export async function updateChannelName(
  db: Database,
  guildId: string,
  channelId: string,
  name: string,
): Promise<void> {
  await db
    .update(thread)
    .set({ channelName: name, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId)));
}

/** Discord thread ids in a channel already embedded with `modelId` (skip on re-import). */
export async function listEmbeddedThreadIdsInChannel(
  db: Database,
  guildId: string,
  channelId: string,
  modelId: string,
): Promise<string[]> {
  const rows = await db
    .select({ threadId: thread.threadId })
    .from(thread)
    .innerJoin(embedding, and(eq(embedding.threadId, thread.id), eq(embedding.modelId, modelId)))
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId)));
  return rows.map((r) => r.threadId);
}

/** Distinct forum channel ids we have threads for (to catch orphaned channels). */
export async function listChannelIdsForGuild(db: Database, guildId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ channelId: thread.channelId })
    .from(thread)
    .where(eq(thread.guildId, guildId));
  return rows.map((r) => r.channelId);
}

/** Store the custom forum labels (tags) applied to a thread, for the KB + filtering. */
export async function setThreadLabels(
  db: Database,
  guildId: string,
  discordThreadId: string,
  labels: string[],
): Promise<void> {
  await db
    .update(thread)
    .set({ labels, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)));
}

/** Store the full human transcript of a thread (for the public KB). */
export async function setTranscript(
  db: Database,
  threadRowId: string,
  transcript: TranscriptMessage[],
): Promise<void> {
  await db
    .update(thread)
    .set({ transcript, updatedAt: new Date() })
    .where(eq(thread.id, threadRowId));
}
