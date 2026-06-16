import { getEnv, tierLimits } from '@dejavue/core';
import { getDb, resolveGuildTier } from '@dejavue/db';

/** The guild's monthly AI-generation quota, derived from its actual tier (Pro 300, Max 1500…). */
export async function guildGenerationQuota(guildId: string): Promise<number> {
  const env = getEnv();
  const tier =
    env.DEV_FORCE_TIER ??
    (await resolveGuildTier(getDb(), guildId, {
      plus: env.SKU_PLUS,
      pro: env.SKU_PRO,
      max: env.SKU_MAX,
    }));
  return tierLimits(tier, env.PRO_MONTHLY_QUOTA).monthlyGenerationQuota;
}
