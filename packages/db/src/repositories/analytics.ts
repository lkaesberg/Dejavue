import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { thread } from '../schema';

export interface ResolutionStats {
  total: number;
  solved: number;
  rate: number;
  /** Average time-to-resolution in seconds (null if no solved threads). */
  avgTtrSeconds: number | null;
}

export async function resolutionStats(db: Database, guildId: string): Promise<ResolutionStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      solved: sql<number>`(count(*) filter (where ${thread.status} = 'solved'))::int`,
      avgTtr: sql<number | null>`(avg(extract(epoch from (${thread.solvedAt} - ${thread.createdAt}))) filter (where ${thread.status} = 'solved' and ${thread.solvedAt} is not null))::float8`,
    })
    .from(thread)
    .where(eq(thread.guildId, guildId));

  const total = row?.total ?? 0;
  const solved = row?.solved ?? 0;
  return {
    total,
    solved,
    rate: total > 0 ? solved / total : 0,
    avgTtrSeconds: row?.avgTtr != null ? Number(row.avgTtr) : null,
  };
}

export interface HelperStat {
  userId: string;
  solved: number;
}

export async function topHelpers(
  db: Database,
  guildId: string,
  limit = 5,
): Promise<HelperStat[]> {
  const rows = await db
    .select({
      userId: thread.acceptedAnswerAuthorId,
      solved: sql<number>`count(*)::int`,
    })
    .from(thread)
    .where(
      and(
        eq(thread.guildId, guildId),
        eq(thread.status, 'solved'),
        isNotNull(thread.acceptedAnswerAuthorId),
      ),
    )
    .groupBy(thread.acceptedAnswerAuthorId)
    .orderBy(sql`count(*) desc`)
    .limit(limit);

  return rows
    .filter((r): r is { userId: string; solved: number } => Boolean(r.userId))
    .map((r) => ({ userId: r.userId, solved: r.solved }));
}
