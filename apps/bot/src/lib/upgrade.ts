import { childLogger, type Tier, TIER_RANK } from '@dejavue/core';
import { createBackfillJob, getDb, getGuildConfig, updateGuildConfig } from '@dejavue/db';
import { enqueueBackfill } from '@dejavue/queue';
import { getGuildTier } from './tier';

const log = childLogger({ mod: 'upgrade' });

/**
 * When a guild's tier increases, auto-import the extra forum history its larger
 * archive cap now allows. The import is idempotent and skips already-imported
 * threads, so this only pulls in the new room (and folds/publishes it like setup).
 *
 * Tracked via guild_config.lastTier — a change-detection marker, NOT a gating
 * source (gating always derives the tier from entitlement rows). Safe to call on
 * every entitlement event and on reconcile: only a genuine increase enqueues work.
 */
export async function checkTierUpgrade(guildId: string): Promise<void> {
  try {
    const db = getDb();
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg) return;
    const tier = await getGuildTier(guildId);
    const last = (cfg.lastTier as Tier | null) ?? null;

    // First sighting → record a baseline without backfilling (avoids a spurious
    // import for guilds that are already on a paid tier when we first see them).
    if (last === null) {
      await updateGuildConfig(db, guildId, { lastTier: tier });
      return;
    }

    if (TIER_RANK[tier] <= TIER_RANK[last]) {
      if (tier !== last) await updateGuildConfig(db, guildId, { lastTier: tier });
      return;
    }

    for (const channelId of cfg.forumChannelIds) {
      const job = await createBackfillJob(db, { guildId, channelId, entitlementId: null });
      await enqueueBackfill({ backfillJobId: job.id });
    }
    await updateGuildConfig(db, guildId, { lastTier: tier });
    log.info(
      { guildId, from: last, to: tier, channels: cfg.forumChannelIds.length },
      'tier upgrade → auto-importing more history',
    );
  } catch (err) {
    log.warn({ err, guildId }, 'tier-upgrade check failed');
  }
}
