import { childLogger, type Tier, TIER_RANK } from '@dejavue/core';
import {
  createBackfillJob,
  getActiveBackfillJob,
  getDb,
  getGuildConfig,
  swapLastTier,
  transitionBackfillJob,
} from '@dejavue/db';
import { enqueueBackfill } from '@dejavue/queue';
import { getGuildTier } from './tier';

const log = childLogger({ mod: 'upgrade' });

export interface TierUpgradeDeps {
  getConfig: (guildId: string) => Promise<{ lastTier: string | null; forumChannelIds: string[] } | undefined>;
  getTier: (guildId: string) => Promise<Tier>;
  /** Compare-and-set guild_config.last_tier; true when this caller moved it. */
  swapLastTier: (guildId: string, from: Tier | null, to: Tier) => Promise<boolean>;
  hasActiveImport: (guildId: string, channelId: string) => Promise<boolean>;
  createJob: (guildId: string, channelId: string) => Promise<{ id: string }>;
  enqueue: (jobId: string) => Promise<unknown>;
  /** pending → failed for a job row that never reached the queue. */
  failPendingJob: (jobId: string) => Promise<unknown>;
}

const defaultDeps = (): TierUpgradeDeps => {
  const db = getDb();
  return {
    getConfig: (guildId) => getGuildConfig(db, guildId),
    getTier: (guildId) => getGuildTier(guildId),
    swapLastTier: (guildId, from, to) => swapLastTier(db, guildId, from, to),
    hasActiveImport: async (guildId, channelId) => !!(await getActiveBackfillJob(db, guildId, channelId)),
    createJob: (guildId, channelId) => createBackfillJob(db, { guildId, channelId, entitlementId: null }),
    enqueue: (jobId) => enqueueBackfill({ backfillJobId: jobId }),
    failPendingJob: (jobId) => transitionBackfillJob(db, jobId, ['pending'], 'failed'),
  };
};

/**
 * When a guild's tier increases, auto-import the extra forum history its larger
 * archive cap now allows. The import is idempotent and skips already-imported
 * threads, so this only pulls in the new room (and folds/publishes it like setup).
 *
 * Tracked via guild_config.lastTier — a change-detection marker, NOT a gating
 * source (gating always derives the tier from entitlement rows). Safe to call on
 * every entitlement event and on reconcile: only a genuine increase enqueues work,
 * and only once — the marker is moved by compare-and-set BEFORE enqueueing, so of
 * concurrent callers (CREATE + UPDATE + reconcile) exactly one wins the upgrade. If
 * enqueueing then fails, the orphan job row is failed and the marker is set back so
 * the next event retries; forums already queued are skipped by the active-import check.
 */
export async function checkTierUpgrade(
  guildId: string,
  deps: TierUpgradeDeps = defaultDeps(),
): Promise<void> {
  let claimed: { from: Tier; to: Tier } | null = null;
  try {
    const cfg = await deps.getConfig(guildId);
    if (!cfg) return;
    const tier = await deps.getTier(guildId);
    const last = (cfg.lastTier as Tier | null) ?? null;

    // First sighting → record a baseline without backfilling (avoids a spurious
    // import for guilds that are already on a paid tier when we first see them).
    if (last === null) {
      await deps.swapLastTier(guildId, null, tier);
      return;
    }

    if (TIER_RANK[tier] <= TIER_RANK[last]) {
      if (tier !== last) await deps.swapLastTier(guildId, last, tier);
      return;
    }

    // Claim the upgrade; a concurrent caller that already moved the marker owns it.
    if (!(await deps.swapLastTier(guildId, last, tier))) return;
    claimed = { from: last, to: tier };

    for (const channelId of cfg.forumChannelIds) {
      // An import already queued/running for this forum picks up the new cap itself
      // (it re-reads limits before stopping at the cap) — a second one would only race
      // it over the same threads.
      if (await deps.hasActiveImport(guildId, channelId)) continue;
      const job = await deps.createJob(guildId, channelId);
      try {
        await deps.enqueue(job.id);
      } catch (err) {
        // The row would otherwise count as an active import and block the retry.
        await deps.failPendingJob(job.id).catch(() => undefined);
        throw err;
      }
    }
    log.info(
      { guildId, from: last, to: tier, channels: cfg.forumChannelIds.length },
      'tier upgrade → auto-importing more history',
    );
  } catch (err) {
    log.warn({ err, guildId }, 'tier-upgrade check failed');
    // Release the claim so the next event retries the forums that didn't get queued.
    if (claimed) {
      const { from, to } = claimed;
      await deps
        .swapLastTier(guildId, to, from)
        .catch((e) => log.warn({ err: e, guildId }, 'failed to release tier-upgrade claim'));
    }
  }
}
