import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, thread, type NewThread, type Thread, type TranscriptMessage } from '../schema';

/**
 * Whether a thread may have a standalone KB page: not opted out, and not folded as a
 * duplicate — neither onto a canonical thread nor by hand (the managed `duplicate`
 * tag). Every publish path checks this one predicate.
 */
export function isPublishable(
  row: Pick<Thread, 'doNotPublish' | 'duplicateOfThreadId' | 'markedDuplicate'>,
): boolean {
  return !row.doNotPublish && !row.duplicateOfThreadId && !row.markedDuplicate;
}

/** SQL twin of {@link isPublishable}, for bulk publish queries. */
export const publishableSql = and(
  eq(thread.doNotPublish, false),
  isNull(thread.duplicateOfThreadId),
  eq(thread.markedDuplicate, false),
);

/**
 * Insert or update a thread, keyed by (guildId, discord threadId).
 *
 * `status: 'solved'` is taken as the caller's authoritative view (the importers read
 * it from the forum's solved tag): a new row is inserted solved with `solvedAt`
 * stamped (the caller's value, else now), and an existing 'open' row is promoted to
 * solved the same way — the tag was applied while we weren't watching. Nothing else
 * changes status here: 'unsolved' was an explicit reopen, and demotion is left to the
 * solve/unsolve flows.
 */
export async function upsertThread(db: Database, values: NewThread): Promise<Thread> {
  const solved = values.status === 'solved';
  const promote = sql`(excluded.status = 'solved' and ${thread.status} = 'open')`;
  // Stamped here (ms precision) rather than with now(), so the value matches what
  // readers hold as a JS Date (claimCanonicalSummary compares it).
  const now = new Date().toISOString();
  const [row] = await db
    .insert(thread)
    .values(solved && !values.solvedAt ? { ...values, solvedAt: new Date() } : values)
    .onConflictDoUpdate({
      target: [thread.guildId, thread.threadId],
      set: {
        title: values.title,
        questionBody: values.questionBody ?? '',
        opUserId: values.opUserId,
        channelName: values.channelName,
        status: sql`case when ${promote} then 'solved'::thread_status else ${thread.status} end`,
        // With an explicit solve time (an import's archive timestamp) a solved row
        // that predates solvedAt stamping is repaired too.
        solvedAt: values.solvedAt
          ? sql`case when ${promote} or (${thread.status} = 'solved' and ${thread.solvedAt} is null) then excluded.solved_at else ${thread.solvedAt} end`
          : sql`case when ${promote} then coalesce(excluded.solved_at, ${now}::timestamptz) else ${thread.solvedAt} end`,
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
      // A (re-)solve may carry a different answer: the old summary no longer matches.
      canonicalSummary: null,
      solvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(thread.guildId, input.guildId), eq(thread.threadId, input.discordThreadId)))
    .returning();
  return row;
}

/**
 * Move a thread to a non-solved status (reopen). Solving goes through
 * markThreadSolved, which records the answer. Leaving 'solved' drops everything that
 * belonged to the solve — solvedAt, the accepted answer and its AI summary — so a
 * stale answer is never served for a reopened question or carried into its next solve.
 */
export async function setThreadStatus(
  db: Database,
  guildId: string,
  discordThreadId: string,
  status: Exclude<Thread['status'], 'solved'>,
): Promise<void> {
  await db
    .update(thread)
    .set({
      status,
      solvedAt: null,
      acceptedAnswerMessageId: null,
      acceptedAnswerText: null,
      acceptedAnswerAuthorId: null,
      canonicalSummary: null,
      // A solved post that is reopened is a new wait for help: make it nudgeable again.
      // Only on a real solved -> open/unsolved move, so re-applying the same status
      // doesn't re-arm a nudge that already went out.
      lastNudgedAt: sql`case when ${thread.status} = 'solved' then null else ${thread.lastNudgedAt} end`,
      updatedAt: new Date(),
    })
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
 * Count indexed conversation segments captured from tracked normal channels.
 * (Kept for analytics/status; the index cap is now message-based — see
 * `countIndexedMessages`.)
 */
export async function countTracked(db: Database, guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.kind, 'channel')));
  return row?.count ?? 0;
}

// Messages an online thread contributes to the index: its transcript length, but at
// least 1 (a backfilled thread has only the question and no captured transcript yet).
const indexMsgCount = sql<number>`coalesce(sum(greatest(case when jsonb_typeof(${thread.transcript}) = 'array' then jsonb_array_length(${thread.transcript}) else 0 end, 1)), 0)::int`;

/**
 * The single source of truth for the unified index cap: total messages across all
 * online (published) forum + tracked content in a guild. Published = in the index =
 * what the cap limits; this naturally excludes duplicates and do-not-publish rows
 * (both unpublished) and unsolved question threads (published only on solve).
 */
export async function countIndexedMessages(db: Database, guildId: string): Promise<number> {
  const [row] = await db
    .select({ count: indexMsgCount })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.publishedToKb, true)));
  return row?.count ?? 0;
}

/** Per-channel indexed message count (feeds channel_sync.indexedMessageCount + status). */
export async function countIndexedMessagesInChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: indexMsgCount })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.channelId, channelId),
        eq(thread.publishedToKb, true),
      ),
    );
  return row?.count ?? 0;
}

/** Record the content hash of the embed-source text at the last successful embed. */
export async function setEmbedContentHash(
  db: Database,
  threadRowId: string,
  hash: string,
): Promise<void> {
  await db
    .update(thread)
    .set({ embedContentHash: hash, updatedAt: new Date() })
    .where(eq(thread.id, threadRowId));
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

/**
 * Store the canonical summary only if none exists yet AND the thread is still in the
 * solve the summary was generated from (`solvedAt` read before generating; NULL for
 * rows that were never solved, e.g. knowledge posts). A reopen or re-solve while the
 * model was running clears the summary and moves solvedAt, so the stale text is
 * dropped instead of being served for the new answer. Returns whether it was stored.
 */
export async function claimCanonicalSummary(
  db: Database,
  threadRowId: string,
  summary: string,
  solvedAt: Date | null,
): Promise<boolean> {
  const rows = await db
    .update(thread)
    .set({ canonicalSummary: summary, updatedAt: new Date() })
    .where(
      and(
        eq(thread.id, threadRowId),
        isNull(thread.canonicalSummary),
        // JS Dates carry milliseconds, timestamptz microseconds: compare at ms precision
        // so a solve stamped by the database (now()) still matches what the worker read.
        solvedAt
          ? sql`date_trunc('milliseconds', ${thread.solvedAt}) = ${solvedAt.toISOString()}::timestamptz`
          : isNull(thread.solvedAt),
      ),
    )
    .returning({ id: thread.id });
  return rows.length > 0;
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
/**
 * Flag/unflag a thread hand-folded via the managed `duplicate` forum tag. Unlike
 * setDuplicateOf there is no canonical thread to point at, so this only records that
 * the post was judged a duplicate; callers handle unpublishing.
 */
export async function setMarkedDuplicate(
  db: Database,
  guildId: string,
  discordThreadId: string,
  marked: boolean,
): Promise<void> {
  await db
    .update(thread)
    .set({ markedDuplicate: marked, updatedAt: new Date() })
    .where(and(eq(thread.guildId, guildId), eq(thread.threadId, discordThreadId)));
}

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

/**
 * Patch for un-folding duplicates whose canonical is being deleted: drop the pointer
 * and put a solved, otherwise-publishable post straight back on the KB (it was only
 * unpublished because it was folded). Knowledge-channel posts come back through the
 * channel publish pass, which knows the channel mode.
 */
const unfoldPatch = () => ({
  duplicateOfThreadId: null,
  publishedToKb: sql`case when ${thread.status} = 'solved' and ${thread.doNotPublish} = false and ${thread.markedDuplicate} = false then true else ${thread.publishedToKb} end`,
  updatedAt: new Date(),
});

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
    .set(unfoldPatch())
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
    .set(unfoldPatch())
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
    .set(unfoldPatch())
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

/** Each indexed thread's stored labels in a channel (to heal offline tag edits on boot). */
export async function listThreadLabelsByChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<{ threadId: string; labels: string[] }[]> {
  return db
    .select({ threadId: thread.threadId, labels: thread.labels })
    .from(thread)
    .where(and(eq(thread.guildId, guildId), eq(thread.channelId, channelId)));
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
