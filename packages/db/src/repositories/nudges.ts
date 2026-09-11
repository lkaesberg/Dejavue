import { and, eq, isNull, or, sql } from 'drizzle-orm';
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

/** Open/unsolved threads older than N hours that haven't been nudged yet. */
export async function getStaleUnansweredThreads(
  db: Database,
  guildId: string,
  olderThanHours: number,
  limit = 20,
): Promise<StaleThread[]> {
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
        or(eq(thread.status, 'open'), eq(thread.status, 'unsolved')),
        // A folded duplicate (accepted, hand-tagged, or moved to another forum) isn't
        // a question waiting for help — nudging it would ping helpers at a dead thread.
        isNull(thread.duplicateOfThreadId),
        eq(thread.markedDuplicate, false),
        isNull(thread.lastNudgedAt),
        sql`${thread.createdAt} < now() - (${olderThanHours} * interval '1 hour')`,
      ),
    )
    .limit(limit);
}

export async function markThreadNudged(db: Database, threadRowId: string): Promise<void> {
  await db.update(thread).set({ lastNudgedAt: new Date() }).where(eq(thread.id, threadRowId));
}
