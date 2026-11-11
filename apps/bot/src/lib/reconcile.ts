import type { Client } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, type NewEntitlement, reconcileGuildEntitlements } from '@dejavue/db';
import { mapEntitlement } from './entitlementMap';
import { isOneTimeSku, storeAndFulfil } from './oneTimePurchase';
import { invalidateTier } from './tier';
import { grantTopUp } from './topUp';
import { checkTierUpgrade } from './upgrade';

const log = childLogger({ mod: 'reconcile' });

/** Ascending by entitlement id (a Discord snowflake, so by creation time). */
export function byPurchaseTime(a: { id: string }, b: { id: string }): number {
  const x = /^\d+$/.test(a.id) ? BigInt(a.id) : 0n;
  const y = /^\d+$/.test(b.id) ? BigInt(b.id) : 0n;
  return x < y ? -1 : x > y ? 1 : a.id.localeCompare(b.id);
}

/**
 * Pull the authoritative entitlement set from Discord (LIST) and reconcile local
 * rows. This heals tier drift from gateway events missed during reconnects /
 * deploys. Runs on ClientReady and hourly. (Reconcile lives in the bot — not a
 * pg-boss cron — because it needs the gateway client's application API.)
 */
export async function reconcileAllEntitlements(client: Client): Promise<void> {
  const app = client.application;
  if (!app) return;
  try {
    const fetched = await app.entitlements.fetch();
    const byGuild = new Map<string, NewEntitlement[]>();
    // User-owned one-time purchases are healed oldest purchase first (snowflake order):
    // a top-up showing's first pack bridges however late and later packs are judged
    // against the earlier ones, so two missed CREATEs must be replayed in purchase order.
    for (const ent of [...fetched.values()].filter((e) => !e.guildId).sort(byPurchaseTime)) {
      // Heal a missed CREATE (bridges from a still pending intent) or fulfil one ops
      // bound to a guild by hand. Idempotent.
      if (isOneTimeSku(ent.skuId) && !ent.consumed && !ent.deleted) {
        await storeAndFulfil(ent).catch((err) =>
          log.warn({ err, id: ent.id }, 'one-time purchase heal failed'),
        );
      }
    }
    for (const ent of fetched.values()) {
      if (!ent.guildId) continue;
      const rows = byGuild.get(ent.guildId) ?? [];
      rows.push(mapEntitlement(ent));
      byGuild.set(ent.guildId, rows);
      // Heal top-up purchases whose CREATE event we missed (grant is idempotent).
      if (!ent.consumed) await grantTopUp(ent).catch((err) => log.warn({ err }, 'top-up heal failed'));
    }
    for (const [guildId, rows] of byGuild) {
      await reconcileGuildEntitlements(getDb(), guildId, rows);
      invalidateTier(guildId);
      // Catch upgrades that happened while we were offline (heals missed events).
      await checkTierUpgrade(guildId);
    }
    log.info({ guilds: byGuild.size, total: fetched.size }, 'reconciled entitlements');
  } catch (err) {
    log.error({ err }, 'entitlement reconcile failed');
  }
}
