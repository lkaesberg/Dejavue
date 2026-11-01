import { and, eq, inArray, isNotNull, isNull, lt, notInArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  attachment,
  backfillJob,
  channelSync,
  channelTopic,
  faqEntry,
  guildConfig,
  knowledgeGapCluster,
  purchaseIntent,
  reindexJob,
  thread,
} from '../schema';

// ---------------------------------------------------------------------------
// Retention after the bot is removed from a server. The privacy policy promises that a
// server's content goes when the bot does; the grace period lets an accidental kick be
// undone by adding the bot back. A purge removes content, not billing: entitlement,
// top-up and generation-ledger rows (token counts only) stay, as the policy states.
// ---------------------------------------------------------------------------

/** Record that the bot left a server. Keeps the first date if it was already marked. */
export async function markGuildRemoved(db: Database, guildId: string, at = new Date()): Promise<void> {
  await db
    .update(guildConfig)
    .set({ removedAt: at, updatedAt: new Date() })
    .where(and(eq(guildConfig.guildId, guildId), isNull(guildConfig.removedAt)));
}

/** The bot is in these servers: cancel any pending removal. Returns how many were restored. */
export async function markGuildsPresent(db: Database, guildIds: string[]): Promise<number> {
  if (guildIds.length === 0) return 0;
  const rows = await db
    .update(guildConfig)
    .set({ removedAt: null, purgedAt: null, updatedAt: new Date() })
    .where(and(inArray(guildConfig.guildId, guildIds), isNotNull(guildConfig.removedAt)))
    .returning({ guildId: guildConfig.guildId });
  return rows.length;
}

/**
 * Bring removal marks in line with the full list of servers the bot is in: anything
 * configured but absent is marked removed, anything present is restored. Catches a
 * removal that happened while the bot was offline and never produced a guildDelete.
 */
export async function reconcileGuildPresence(
  db: Database,
  presentIds: string[],
): Promise<{ removed: number; restored: number }> {
  // An empty list would mark every server removed — a broken API response, not reality.
  if (presentIds.length === 0) throw new Error('refusing to reconcile against an empty server list');
  const restored = await markGuildsPresent(db, presentIds);
  const marked = await db
    .update(guildConfig)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(isNull(guildConfig.removedAt), notInArray(guildConfig.guildId, presentIds)))
    .returning({ guildId: guildConfig.guildId });
  return { removed: marked.length, restored };
}

/** Servers removed before `cutoff` whose content hasn't been purged yet. */
export async function listGuildsDueForPurge(db: Database, cutoff: Date): Promise<string[]> {
  const rows = await db
    .select({ guildId: guildConfig.guildId })
    .from(guildConfig)
    .where(and(lt(guildConfig.removedAt, cutoff), isNull(guildConfig.purgedAt)));
  return rows.map((r) => r.guildId);
}

/**
 * Delete everything a server's content produced: threads (embeddings cascade), re-hosted
 * attachments, topic vectors, FAQ and gap clusters, sync and job state, and the config
 * itself (imprint, branding, slug, channel guidelines). The config row is recreated with
 * only the purchased custom-domain unlock and the removal dates.
 *
 * Returns false when the server came back between listing and purging.
 */
export async function purgeGuildContent(db: Database, guildId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cfg] = await tx
      .select({
        removedAt: guildConfig.removedAt,
        purgedAt: guildConfig.purgedAt,
        customDomainUnlocked: guildConfig.customDomainUnlocked,
      })
      .from(guildConfig)
      .where(eq(guildConfig.guildId, guildId))
      .for('update');
    if (!cfg?.removedAt || cfg.purgedAt) return false;

    await tx.delete(faqEntry).where(eq(faqEntry.guildId, guildId));
    await tx.delete(knowledgeGapCluster).where(eq(knowledgeGapCluster.guildId, guildId));
    await tx.delete(thread).where(eq(thread.guildId, guildId));
    await tx.delete(attachment).where(eq(attachment.guildId, guildId));
    await tx.delete(channelTopic).where(eq(channelTopic.guildId, guildId));
    await tx.delete(channelSync).where(eq(channelSync.guildId, guildId));
    await tx.delete(backfillJob).where(eq(backfillJob.guildId, guildId));
    await tx.delete(reindexJob).where(eq(reindexJob.guildId, guildId));
    await tx.delete(purchaseIntent).where(eq(purchaseIntent.guildId, guildId));
    await tx.delete(guildConfig).where(eq(guildConfig.guildId, guildId));
    await tx.insert(guildConfig).values({
      guildId,
      customDomainUnlocked: cfg.customDomainUnlocked,
      removedAt: cfg.removedAt,
      purgedAt: new Date(),
    });
    return true;
  });
}
