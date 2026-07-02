import { and, eq, gte, sql } from 'drizzle-orm';
import { computeSpill, creditsToTokens, tokensToCredits } from '@dejavue/core';
import type { Database } from '../client';
import { generationEvent, type GenerationEvent, topUpGrant } from '../schema';

/** A plain db handle or a transaction handle — repo functions accept both. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

/**
 * Quota is computed over a ledger — never a mutable "remaining" counter.
 * Metering is token-based (prompt + completion, weighted equally), surfaced to
 * users as AI credits (1 credit = 1,000 tokens; see @dejavue/core).
 * Billing window = calendar month, UTC (documented choice).
 */
export function currentWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Tokens consumed by successful generations in the current window. */
export async function tokensUsed(db: Executor, guildId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({
      t: sql<number>`coalesce(sum(${generationEvent.promptTokens} + ${generationEvent.completionTokens}), 0)::int`,
    })
    .from(generationEvent)
    .where(
      and(
        eq(generationEvent.guildId, guildId),
        eq(generationEvent.success, true),
        gte(generationEvent.createdAt, since),
      ),
    );
  return row?.t ?? 0;
}

export async function topUpCreditsRemaining(db: Executor, guildId: string): Promise<number> {
  const [row] = await db
    .select({ s: sql<number>`coalesce(sum(${topUpGrant.creditsRemaining}), 0)::int` })
    .from(topUpGrant)
    .where(
      and(
        eq(topUpGrant.guildId, guildId),
        sql`(${topUpGrant.expiresAt} is null or ${topUpGrant.expiresAt} > now())`,
      ),
    );
  return row?.s ?? 0;
}

export interface QuotaStatus {
  /** Tokens consumed this window (successful generations only). */
  usedTokens: number;
  /** Same usage in whole credits, rounded up — the display value. */
  usedCredits: number;
  /** The tier's monthly credit budget. */
  baseCredits: number;
  /** Unexpired top-up credits still available. */
  topUpCredits: number;
  /** baseCredits + topUpCredits. */
  limitCredits: number;
  remainingCredits: number;
  /**
   * Fail-open boundary: any remaining budget lets the next generation run (its
   * cost is unknown until after the call); it may finish past the limit, then
   * everything blocks. Overshoot is bounded by a single generation.
   */
  allowed: boolean;
}

/** Snapshot the current quota position (base monthly credits + top-up credits). */
export async function checkQuota(
  db: Executor,
  guildId: string,
  baseCredits: number,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const usedTokens = await tokensUsed(db, guildId, currentWindowStart(now));
  const topUpCredits = await topUpCreditsRemaining(db, guildId);
  const limitCredits = baseCredits + topUpCredits;
  const usedCredits = tokensToCredits(usedTokens);
  return {
    usedTokens,
    usedCredits,
    baseCredits,
    topUpCredits,
    limitCredits,
    remainingCredits: Math.max(0, limitCredits - usedCredits),
    allowed: usedTokens < creditsToTokens(limitCredits),
  };
}

export interface RecordGenerationInput {
  guildId: string;
  feature: GenerationEvent['feature'];
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  success?: boolean;
  threadId?: string | null;
  topUpCreditsConsumed?: number;
}

export async function recordGeneration(db: Executor, input: RecordGenerationInput): Promise<void> {
  await db.insert(generationEvent).values({
    guildId: input.guildId,
    feature: input.feature,
    model: input.model,
    promptTokens: input.promptTokens ?? 0,
    completionTokens: input.completionTokens ?? 0,
    success: input.success ?? true,
    threadId: input.threadId ?? null,
    topUpCreditsConsumed: input.topUpCreditsConsumed ?? 0,
  });
}

/**
 * Atomically consume up to `credits` top-up credits, oldest non-expired grant
 * first. Each round locks one grant row (FOR UPDATE — waiting, not skipping:
 * concurrent spenders of the same guild must serialize on the oldest grant
 * rather than give up while credits remain) and decrements it in a single
 * UPDATE, so a stale read can never double-spend. Grants are always locked
 * oldest-first, so concurrent spenders cannot deadlock. Returns the number of
 * credits actually consumed (less than requested only when grants run dry).
 */
export async function consumeTopUpCredits(
  db: Executor,
  guildId: string,
  credits: number,
): Promise<number> {
  let consumed = 0;
  while (consumed < credits) {
    const rows = await db.execute<{ consumed: number }>(sql`
      with pick as (
        select id, credits_remaining
        from top_up_grant
        where guild_id = ${guildId}
          and credits_remaining > 0
          and (expires_at is null or expires_at > now())
        order by granted_at asc
        limit 1
        for update
      )
      update top_up_grant g
      set credits_remaining = g.credits_remaining - least(g.credits_remaining, ${credits - consumed})
      from pick
      where g.id = pick.id
      returning least(pick.credits_remaining, ${credits - consumed})::int as consumed
    `);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || !row.consumed) break;
    consumed += Number(row.consumed);
  }
  return consumed;
}

export async function addTopUpGrant(
  db: Executor,
  input: { id: string; guildId: string; credits: number; expiresAt?: Date | null },
): Promise<void> {
  await db
    .insert(topUpGrant)
    .values({
      id: input.id,
      guildId: input.guildId,
      credits: input.credits,
      creditsRemaining: input.credits,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Commit a successful generation in one transaction: record it in the ledger
 * and, for the portion that spilled past the base monthly budget, consume
 * top-up credits (see computeSpill in @dejavue/core for the boundary math).
 * Check-then-commit: the tiny race at the boundary can overshoot by one
 * generation under high concurrency, which is acceptable here.
 */
export async function commitGeneration(
  db: Database,
  input: RecordGenerationInput & { usedTokensBefore: number; baseCredits: number },
): Promise<void> {
  const costTokens = (input.promptTokens ?? 0) + (input.completionTokens ?? 0);
  const spillCredits = computeSpill(input.usedTokensBefore, costTokens, input.baseCredits);
  await db.transaction(async (tx) => {
    const consumed =
      spillCredits > 0 ? await consumeTopUpCredits(tx, input.guildId, spillCredits) : 0;
    await recordGeneration(tx, { ...input, topUpCreditsConsumed: consumed });
  });
}
