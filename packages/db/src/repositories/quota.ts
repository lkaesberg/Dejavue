import { and, asc, eq, gt, gte, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { generationEvent, type GenerationEvent, topUpGrant } from '../schema';

/**
 * Quota is computed over a ledger — never a mutable "remaining" counter.
 * Billing window = calendar month, UTC (documented choice).
 */
export function currentWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Successful generations in the current window. */
export async function generationsUsed(
  db: Database,
  guildId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(generationEvent)
    .where(
      and(
        eq(generationEvent.guildId, guildId),
        eq(generationEvent.success, true),
        gte(generationEvent.createdAt, since),
      ),
    );
  return row?.c ?? 0;
}

export async function topUpCreditsRemaining(db: Database, guildId: string): Promise<number> {
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
  used: number;
  base: number;
  topUp: number;
  limit: number;
  remaining: number;
  allowed: boolean;
}

/** Snapshot the current quota position (base monthly quota + top-up credits). */
export async function checkQuota(
  db: Database,
  guildId: string,
  baseQuota: number,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const used = await generationsUsed(db, guildId, currentWindowStart(now));
  const topUp = await topUpCreditsRemaining(db, guildId);
  const limit = baseQuota + topUp;
  return { used, base: baseQuota, topUp, limit, remaining: Math.max(0, limit - used), allowed: used < limit };
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

export async function recordGeneration(db: Database, input: RecordGenerationInput): Promise<void> {
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

/** Consume one top-up credit (oldest non-expired grant first). Returns false if none. */
export async function consumeTopUpCredit(db: Database, guildId: string): Promise<boolean> {
  const [grant] = await db
    .select()
    .from(topUpGrant)
    .where(
      and(
        eq(topUpGrant.guildId, guildId),
        gt(topUpGrant.creditsRemaining, 0),
        sql`(${topUpGrant.expiresAt} is null or ${topUpGrant.expiresAt} > now())`,
      ),
    )
    .orderBy(asc(topUpGrant.grantedAt))
    .limit(1);
  if (!grant) return false;
  await db
    .update(topUpGrant)
    .set({ creditsRemaining: grant.creditsRemaining - 1 })
    .where(eq(topUpGrant.id, grant.id));
  return true;
}

export async function addTopUpGrant(
  db: Database,
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
 * Commit a successful generation: record it and, if it spilled past the base
 * quota, consume a top-up credit. (Check-then-commit; the tiny race at the
 * boundary can overshoot by a few generations under high concurrency, which is
 * acceptable here.)
 */
export async function commitGeneration(
  db: Database,
  input: RecordGenerationInput & { usedBefore: number; baseQuota: number },
): Promise<void> {
  const spilledToTopUp = input.usedBefore >= input.baseQuota;
  await recordGeneration(db, {
    ...input,
    topUpCreditsConsumed: spilledToTopUp ? 1 : 0,
  });
  if (spilledToTopUp) await consumeTopUpCredit(db, input.guildId);
}
