import { getEnv, type Tier, type TierLimits, type TierSkus, tierLimits } from '@dejavue/core';
import { getDb, resolveGuildTier } from '@dejavue/db';

interface CacheEntry {
  tier: Tier;
  expires: number;
}

// Per-process tier cache so hot paths (threadCreate, interactions) don't hit
// Postgres. Invalidated immediately on ENTITLEMENT_* events; repopulated by the
// hourly LIST reconcile.
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export function tierSkus(): TierSkus {
  const env = getEnv();
  return { plus: env.SKU_PLUS, pro: env.SKU_PRO };
}

export async function getGuildTier(guildId: string): Promise<Tier> {
  const env = getEnv();
  if (env.DEV_FORCE_TIER) return env.DEV_FORCE_TIER;

  const now = Date.now();
  const hit = cache.get(guildId);
  if (hit && hit.expires > now) return hit.tier;

  const tier = await resolveGuildTier(getDb(), guildId, tierSkus());
  cache.set(guildId, { tier, expires: now + TTL_MS });
  return tier;
}

export function invalidateTier(guildId: string): void {
  cache.delete(guildId);
}

export function limitsFor(tier: Tier): TierLimits {
  return tierLimits(tier, getEnv().PRO_MONTHLY_QUOTA);
}
