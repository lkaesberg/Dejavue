import {
  getEnv,
  isMonitoredForum,
  type MonitoredChannelConfig,
  quotasFromEnv,
  type Tier,
  type TierLimits,
  type TierSkus,
  tierLimits,
} from '@dejavue/core';
import { countIndexedMessages, getDb, resolveGuildTier } from '@dejavue/db';

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
  return { plus: env.SKU_PLUS, pro: env.SKU_PRO, max: env.SKU_MAX };
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
  return tierLimits(tier, quotasFromEnv(getEnv()));
}

/**
 * Tier-aware "should the bot act in this forum" guard for event handlers.
 * Combines the "empty config = all forums" pre-setup rule with the downgrade
 * cap (only the first N configured channels stay active) — see
 * isMonitoredForum in @dejavue/core. Uses the cached tier, so it's hot-path safe.
 */
export async function monitoredForum(
  guildId: string,
  cfg: MonitoredChannelConfig | null | undefined,
  forumId: string,
): Promise<boolean> {
  const limits = limitsFor(await getGuildTier(guildId));
  return isMonitoredForum(cfg, forumId, limits.maxForumChannels);
}

/**
 * Is the guild at or over its unified index cap (total indexed messages)? When true,
 * capture paths stop indexing NEW content (existing entries keep updating).
 */
export async function atIndexCap(guildId: string): Promise<boolean> {
  const limits = limitsFor(await getGuildTier(guildId));
  if (!Number.isFinite(limits.indexCap)) return false;
  return (await countIndexedMessages(getDb(), guildId)) >= limits.indexCap;
}
