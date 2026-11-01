import { and, arrayOverlaps, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import {
  attachment,
  faqEntry,
  knowledgeGapCluster,
  thread,
  type TranscriptMessage,
  userOptOut,
} from '../schema';
import { deleteThreadsByDiscordIds } from './threads';

// ---------------------------------------------------------------------------
// Per-user opt-out (`/privacy opt-out`). Capture paths ask `optedOutAmong` before they
// store anything, so an opted-out member's posts are never archived and their replies
// never enter another thread's transcript. `purgeUserContent` removes what was stored
// before they opted out.
// ---------------------------------------------------------------------------

export async function isOptedOut(db: Database, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ userId: userOptOut.userId })
    .from(userOptOut)
    .where(eq(userOptOut.userId, userId))
    .limit(1);
  return Boolean(row);
}

/** Which of these users have opted out. One query for a whole transcript's authors. */
export async function optedOutAmong(db: Database, userIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: userOptOut.userId })
    .from(userOptOut)
    .where(inArray(userOptOut.userId, ids));
  return new Set(rows.map((r) => r.userId));
}

/**
 * Drop opted-out authors' messages from a fetched batch, and the images queued for
 * re-hosting with them. Every capture path runs its batch through this before storing;
 * if the lookup fails it throws, so nothing unfiltered is ever written.
 */
export async function withoutOptedOut<
  M extends { authorId: string; attachments?: { id: string }[] },
  I extends { id: string },
>(db: Database, messages: M[], images: I[] = []): Promise<{ messages: M[]; images: I[] }> {
  const out = await optedOutAmong(
    db,
    messages.map((m) => m.authorId),
  );
  if (out.size === 0) return { messages, images };
  const dropped = new Set(
    messages.filter((m) => out.has(m.authorId)).flatMap((m) => (m.attachments ?? []).map((a) => a.id)),
  );
  return {
    messages: messages.filter((m) => !out.has(m.authorId)),
    images: images.filter((i) => !dropped.has(i.id)),
  };
}

export async function setOptedOut(db: Database, userId: string, optedOut: boolean): Promise<void> {
  if (optedOut) await db.insert(userOptOut).values({ userId }).onConflictDoNothing();
  else await db.delete(userOptOut).where(eq(userOptOut.userId, userId));
}

/** A thread a purge changed or removed, for the caller to re-embed or unpublish. */
export interface PurgedThreadRef {
  id: string;
  guildId: string;
  threadId: string;
}

export interface PurgedUserContent {
  /** Threads the user started — deleted outright. */
  deleted: PurgedThreadRef[];
  /** Threads the user replied in — their messages removed; need a re-embed. */
  edited: (PurgedThreadRef & {
    title: string;
    questionBody: string;
    acceptedAnswerText: string | null;
    publishedToKb: boolean;
  })[];
}

/**
 * Remove everything stored from one user, in every server: threads they started, their
 * messages and attachments in other threads, an accepted answer they wrote, and AI text
 * derived from any of those (summaries, auto-FAQ entries, gap clusters — all rebuilt on
 * their next run). Admin-written FAQ overrides are the admin's text and are kept.
 */
export async function purgeUserContent(db: Database, userId: string): Promise<PurgedUserContent> {
  // Their accepted answers, read before anything is deleted: "use top answer & close"
  // copies an answer into the duplicate without an author, so copies are matched by text.
  const answered = await db
    .select({ text: thread.acceptedAnswerText })
    .from(thread)
    .where(eq(thread.acceptedAnswerAuthorId, userId));
  const theirAnswers = [...new Set(answered.map((r) => r.text).filter((x): x is string => Boolean(x)))];

  const started = await db
    .select({ id: thread.id, guildId: thread.guildId, threadId: thread.threadId })
    .from(thread)
    .where(eq(thread.opUserId, userId));
  const byGuild = new Map<string, string[]>();
  for (const t of started) byGuild.set(t.guildId, [...(byGuild.get(t.guildId) ?? []), t.threadId]);
  for (const [guildId, ids] of byGuild) await deleteThreadsByDiscordIds(db, guildId, ids);

  const touched = await db
    .select({
      id: thread.id,
      guildId: thread.guildId,
      threadId: thread.threadId,
      title: thread.title,
      questionBody: thread.questionBody,
      acceptedAnswerText: thread.acceptedAnswerText,
      acceptedAnswerAuthorId: thread.acceptedAnswerAuthorId,
      publishedToKb: thread.publishedToKb,
      transcript: thread.transcript,
    })
    .from(thread)
    .where(
      or(
        sql`${thread.transcript} @> ${JSON.stringify([{ authorId: userId }])}::jsonb`,
        eq(thread.acceptedAnswerAuthorId, userId),
        theirAnswers.length > 0
          ? and(isNull(thread.acceptedAnswerAuthorId), inArray(thread.acceptedAnswerText, theirAnswers))
          : undefined,
      ),
    );

  const edited: PurgedUserContent['edited'] = [];
  for (const t of touched) {
    const theirs = (t.transcript ?? []).filter((m) => m.authorId === userId);
    const transcript: TranscriptMessage[] = (t.transcript ?? []).filter((m) => m.authorId !== userId);
    const attachmentIds = theirs.flatMap((m) => (m.attachments ?? []).map((a) => a.id));
    const ownAnswer =
      t.acceptedAnswerAuthorId === userId ||
      (!t.acceptedAnswerAuthorId &&
        t.acceptedAnswerText !== null &&
        theirAnswers.includes(t.acceptedAnswerText));
    await db
      .update(thread)
      .set({
        transcript,
        ...(ownAnswer
          ? { acceptedAnswerText: null, acceptedAnswerAuthorId: null, acceptedAnswerMessageId: null }
          : {}),
        canonicalSummary: null,
        embedContentHash: null,
        updatedAt: new Date(),
      })
      .where(eq(thread.id, t.id));
    if (attachmentIds.length > 0) {
      await db
        .delete(attachment)
        .where(and(eq(attachment.guildId, t.guildId), inArray(attachment.id, attachmentIds)));
    }
    edited.push({
      id: t.id,
      guildId: t.guildId,
      threadId: t.threadId,
      title: t.title,
      questionBody: t.questionBody,
      acceptedAnswerText: ownAnswer ? null : t.acceptedAnswerText,
      publishedToKb: t.publishedToKb,
    });
  }

  const affected = [...started.map((t) => t.threadId), ...edited.map((t) => t.threadId)];
  if (affected.length > 0) {
    await db
      .delete(faqEntry)
      .where(and(eq(faqEntry.manualOverride, false), arrayOverlaps(faqEntry.sourceThreadIds, affected)));
    await db.delete(knowledgeGapCluster).where(arrayOverlaps(knowledgeGapCluster.memberThreadIds, affected));
  }

  return { deleted: started, edited };
}
