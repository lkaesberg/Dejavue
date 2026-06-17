import { getEnv, type TierLimits, tierLimits } from '@dejavue/core';
import { getDb, resolveGuildTier } from '@dejavue/db';

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
  return tierLimits(tier, env.PRO_MONTHLY_QUOTA);
}

/** The guild's monthly AI-generation quota (Pro 300, Max 1500…). */
export async function guildGenerationQuota(guildId: string): Promise<number> {
  return (await guildLimits(guildId)).monthlyGenerationQuota;
}
