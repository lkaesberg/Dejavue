import { childLogger, getEnv, notifyAsync, quotasFromEnv, type TierLimits, tierLimits } from '@dejavue/core';
import {
  countIndexedMessages,
  currentWindowStart,
  embeddingTokensUsed,
  getDb,
  resolveGuildTier,
} from '@dejavue/db';

const log = childLogger({ mod: 'worker:quota' });

/** Resolve a guild's full tier limits from its actual entitlements. */
export async function guildLimits(guildId: string): Promise<TierLimits> {
  const env = getEnv();
  const tier =
    env.DEV_FORCE_TIER ??
    (await resolveGuildTier(getDb(), guildId, {
      plus: env.SKU_PLUS,
      pro: env.SKU_PRO,
      max: env.SKU_MAX,
    }));
  return tierLimits(tier, quotasFromEnv(env));
}

/** The guild's monthly AI-credit budget (Plus 25, Pro 1,000, Max 5,000…). */
export async function guildCreditBudget(guildId: string): Promise<number> {
  return (await guildLimits(guildId)).monthlyCredits;
}

/** Is the guild at or over its unified index cap (total indexed messages)? */
export async function atIndexCap(guildId: string): Promise<boolean> {
  const limits = await guildLimits(guildId);
  if (!Number.isFinite(limits.indexCap)) return false;
  return (await countIndexedMessages(getDb(), guildId)) >= limits.indexCap;
}

/**
 * May this guild spend more embedding tokens this month?
 *
 * The index cap is what bounds how much a guild *indexes*; this is the runaway guard for
 * churn that re-embeds the same content over and over. Free fails CLOSED — indexing stops
 * while keyword search and the published KB keep working — because an unpaid guild must
 * never be able to run up an open-ended bill. Paid tiers fail OPEN: we alert and keep
 * serving, since interrupting a paying customer's index is the worse failure.
 */
export async function canEmbed(guildId: string, tier?: TierLimits): Promise<boolean> {
  const limits = tier ?? (await guildLimits(guildId));
  const ceiling = limits.monthlyEmbedTokens;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return true;

  const used = await embeddingTokensUsed(getDb(), guildId, currentWindowStart());
  if (used < ceiling) return true;

  const paid = limits.monthlyCredits > 0 || limits.removeBranding;
  log.warn({ guildId, used, ceiling, paid }, 'monthly embedding-token ceiling reached');
  notifyAsync({
    title: paid ? 'Embedding ceiling reached (paid — allowed)' : 'Embedding ceiling reached (free — blocked)',
    description: `Guild ${guildId} used ${used.toLocaleString()} of ${ceiling.toLocaleString()} embedding tokens this month.`,
  });
  return paid;
}

/**
 * A memoized {@link canEmbed} for bulk jobs. A backfill or reindex touches thousands of
 * threads; re-running the tier lookup and the ledger aggregate for each one would cost
 * more queries than the work itself. Re-checks at most once per `ttlMs`, which is ample
 * for a guard whose job is to stop a runaway within a window, not within a second.
 */
export function embedBudgetGate(guildId: string, ttlMs = 30_000): () => Promise<boolean> {
  let checkedAt = 0;
  let allowed = true;
  return async () => {
    const now = Date.now();
    if (now - checkedAt < ttlMs) return allowed;
    allowed = await canEmbed(guildId);
    checkedAt = now;
    return allowed;
  };
}
