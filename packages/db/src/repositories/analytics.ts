import { and, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { entitlement, generationEvent, guildConfig, thread } from '../schema';

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

// ---------------------------------------------------------------------------
// Operator-facing rollup (the daily stats_snapshot event). Unlike the functions
// above — which serve a guild its OWN numbers — this aggregates across the whole
// instance, so it is the only thing here that is not guild-scoped.
// ---------------------------------------------------------------------------

export interface InstanceStats {
  guildsInstalled: number;
  threadsIndexed: number;
  threadsSolved: number;
  messagesIndexed: number;
  /** Active (non-deleted, non-expired) subscription entitlements, keyed by SKU id. */
  activeSkus: Record<string, number>;
  embeddingTokens30d: number;
  creditTokens30d: number;
}

/** One pass over the instance for the daily snapshot. */
export async function instanceStats(db: Database): Promise<InstanceStats> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [[guilds], [threads], [msgs], skuRows, [embed], [credits]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(guildConfig),
    db
      .select({
        total: sql<number>`count(*)::int`,
        solved: sql<number>`count(*) filter (where ${thread.status} = 'solved')::int`,
      })
      .from(thread),
    db
      .select({
        n: sql<number>`coalesce(sum(greatest(case when jsonb_typeof(${thread.transcript}) = 'array' then jsonb_array_length(${thread.transcript}) else 0 end, 1)), 0)::int`,
      })
      .from(thread)
      .where(eq(thread.publishedToKb, true)),
    db
      .select({ skuId: entitlement.skuId, n: sql<number>`count(*)::int` })
      .from(entitlement)
      .where(
        and(
          eq(entitlement.deleted, false),
          sql`(${entitlement.endsAt} is null or ${entitlement.endsAt} > now())`,
        ),
      )
      .groupBy(entitlement.skuId),
    db
      .select({ n: sql<number>`coalesce(sum(${generationEvent.promptTokens} + ${generationEvent.completionTokens}), 0)::int` })
      .from(generationEvent)
      .where(and(eq(generationEvent.feature, 'embedding'), gte(generationEvent.createdAt, since))),
    db
      .select({ n: sql<number>`coalesce(sum(${generationEvent.promptTokens} + ${generationEvent.completionTokens}), 0)::int` })
      .from(generationEvent)
      .where(and(ne(generationEvent.feature, 'embedding'), gte(generationEvent.createdAt, since))),
  ]);

  return {
    guildsInstalled: guilds?.n ?? 0,
    threadsIndexed: threads?.total ?? 0,
    threadsSolved: threads?.solved ?? 0,
    messagesIndexed: msgs?.n ?? 0,
    activeSkus: Object.fromEntries(skuRows.map((r) => [r.skuId, r.n])),
    embeddingTokens30d: embed?.n ?? 0,
    creditTokens30d: credits?.n ?? 0,
  };
}
