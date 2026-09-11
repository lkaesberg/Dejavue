import { capture } from '@dejavue/analytics';
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
  const capped = (await countIndexedMessages(getDb(), guildId)) >= limits.indexCap;
  if (capped) reportCapped(guildId, limits.indexCap);
  return capped;
}

/**
 * "This server is turning content away" is the demand signal that says the index cap is
 * doing the converting. But atIndexCap runs on every capture, so a capped guild would
 * emit on every message — record it at most hourly per guild instead.
 */
const CAP_REPORT_INTERVAL_MS = 60 * 60 * 1000;
const capReportedAt = new Map<string, number>();

function reportCapped(guildId: string, cap: number): void {
  const now = Date.now();
  const last = capReportedAt.get(guildId) ?? 0;
  if (now - last < CAP_REPORT_INTERVAL_MS) return;
  capReportedAt.set(guildId, now);
  capture('index_cap_reached', guildId, { cap });
}
