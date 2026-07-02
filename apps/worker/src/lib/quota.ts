import { getEnv, quotasFromEnv, type TierLimits, tierLimits } from '@dejavue/core';
import { countIndexedMessages, getDb, resolveGuildTier } from '@dejavue/db';

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
