import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { type GuildConfig, guildConfig, thread } from '../schema';

export interface StaleThread {
  threadRowId: string;
  threadId: string;
  channelId: string;
  title: string;
}

export async function listGuildsWithNudges(db: Database): Promise<GuildConfig[]> {
  return db.select().from(guildConfig).where(eq(guildConfig.nudgeEnabled, true));
}

/**
 * The channels whose posts can be nudged: monitored forums in question mode. Knowledge
 * channels are an archive (nothing waits for an answer), tracked text channels hold
 * conversation segments whose thread id is a message id, not a thread to post in, and a
 * forum removed from monitoring keeps its old threads but must not be pinged about.
 */
export function nudgeableChannelIds(
  cfg: Pick<GuildConfig, 'forumChannelIds' | 'channelModes'>,
): string[] {
  return cfg.forumChannelIds.filter((id) => cfg.channelModes?.[id] !== 'knowledge');
}

/**
 * Open/unsolved forum posts in `channelIds`, older than N hours, not nudged yet. Oldest
 * first, so a row that keeps failing for a transient reason can't hide newer ones behind
 * an unordered LIMIT forever.
 */
export async function getStaleUnansweredThreads(
  db: Database,
  guildId: string,
  channelIds: string[],
  olderThanHours: number,
  limit = 20,
): Promise<StaleThread[]> {
  if (channelIds.length === 0) return [];
  return db
    .select({
      threadRowId: thread.id,
      threadId: thread.threadId,
      channelId: thread.channelId,
      title: thread.title,
    })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.kind, 'forum'),
        inArray(thread.channelId, channelIds),
        or(eq(thread.status, 'open'), eq(thread.status, 'unsolved')),
        // A folded duplicate (accepted, hand-tagged, or moved to another forum) isn't
        // a question waiting for help — nudging it would ping helpers at a dead thread.
        isNull(thread.duplicateOfThreadId),
        eq(thread.markedDuplicate, false),
        isNull(thread.lastNudgedAt),
        sql`${thread.createdAt} < now() - (${olderThanHours} * interval '1 hour')`,
      ),
    )
    .orderBy(asc(thread.createdAt))
    .limit(limit);
}

/**
 * Settle a thread's nudge: after it was posted, or after Discord refused it for good
 * (thread gone, no access) — a permanent refusal retried every hour would otherwise sit
 * in the batch forever. Cleared again when the thread is reopened (setThreadStatus).
 */
export async function markThreadNudged(db: Database, threadRowId: string): Promise<void> {
  await db.update(thread).set({ lastNudgedAt: new Date() }).where(eq(thread.id, threadRowId));
}
