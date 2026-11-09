import type { Entitlement } from 'discord.js';
import { childLogger, getEnv, isTopUpSku, notifyAsync, topUpTiers } from '@dejavue/core';
import {
  clearPurchaseIntent,
  getDb,
  getEntitlement,
  hasOtherLiveEntitlement,
  resolvePurchaseIntent,
  revokeTopUpGrant,
  updateGuildConfig,
  upsertEntitlement,
} from '@dejavue/db';
import { grantCustomDomain } from './customDomain';
import { mapEntitlement } from './entitlementMap';
import { grantTopUp } from './topUp';

const log = childLogger({ mod: 'one-time-purchase' });

/** SKUs Discord delivers as USER-owned one-time purchases (the entitlement has no guildId). */
export function isOneTimeSku(skuId: string): boolean {
  const env = getEnv();
  return isTopUpSku(env, skuId) || skuId === env.SKU_CUSTOM_DOMAIN || skuId === env.SKU_BACKFILL;
}

/**
 * Store an entitlement and fulfil it if it is a one-time purchase. Returns the guild
 * the stored row is bound to.
 *
 * One-time purchases (top-up, custom domain) are USER-owned: Discord sends them with
 * a user_id and no guild_id. A first sighting is bridged to the guild the buyer
 * launched the purchase from (the pending intent recorded with the buy button); the
 * intent is dropped once the row holds that guild so it bridges exactly one purchase.
 * A redelivered CREATE, an UPDATE or a reconcile pass finds the guild on the stored
 * row instead. Grants are idempotent per entitlement id, so this is safe to repeat.
 *
 * A purchase we cannot bind to any guild is never silently dropped: it is stored
 * unbridged and (with `alertUnbridged`, i.e. on CREATE) raised to ops, who can bind
 * it by hand; the next reconcile pass then fulfils it. A refunded (deleted)
 * entitlement is stored but never granted.
 */
export async function storeAndFulfil(
  ent: Entitlement,
  opts: { alertUnbridged?: boolean } = {},
): Promise<string | null> {
  const db = getDb();
  const row = mapEntitlement(ent);
  const oneTime = isOneTimeSku(row.skuId);
  let bridged: string | undefined;
  // Bridge only a purchase that isn't bound yet: an UPDATE / redelivery / reconcile of
  // an already-bound one must not consume a newer intent the buyer made for another
  // guild (that would steal the next purchase's binding).
  if (!row.guildId && row.userId && oneTime && !(await getEntitlement(db, row.id))?.guildId) {
    bridged = await resolvePurchaseIntent(db, row.userId, row.skuId);
    if (bridged) row.guildId = bridged;
  }
  const guildId = await upsertEntitlement(db, row);
  if (bridged && row.userId && guildId === bridged) {
    // The top-up ladder recorded an intent for every pack; the buyer picked one.
    const skuIds = isTopUpSku(getEnv(), row.skuId)
      ? [row.skuId, ...topUpTiers(getEnv()).map((t) => t.skuId)]
      : [row.skuId];
    await clearPurchaseIntent(db, { userId: row.userId, skuIds, guildId: bridged });
    log.info({ id: ent.id, skuId: ent.skuId, guildId }, 'bridged user-owned purchase to guild');
  }
  if (!oneTime || ent.deleted) return guildId;
  if (!guildId) {
    if (opts.alertUnbridged && !ent.consumed) {
      log.error(
        { id: ent.id, skuId: ent.skuId, userId: row.userId },
        'one-time purchase with no guild intent — cannot resolve target guild',
      );
      notifyAsync({
        level: 'error',
        title: '🚨 Unfulfilled one-time purchase',
        description:
          'Paid purchase with no guild to apply it to (no purchase intent). Resolve by hand: ' +
          'set entitlement.guild_id, then the next reconcile grants it.',
        fields: [
          { name: 'Entitlement', value: ent.id },
          { name: 'SKU', value: ent.skuId },
          { name: 'User', value: row.userId ?? '—' },
        ],
      });
    }
    return null;
  }
  await grantTopUp(ent, guildId);
  await grantCustomDomain(ent, guildId);
  return guildId;
}

/**
 * Reverse what a refunded one-time purchase granted: the unused credits of a top-up,
 * and the custom-domain unlock unless the guild still holds another live purchase of
 * it. Only call once per entitlement (on the deleted false → true flip).
 */
export async function revokeOneTimePurchase(
  entitlementId: string,
  skuId: string,
  guildId: string,
): Promise<void> {
  const env = getEnv();
  const db = getDb();
  if (isTopUpSku(env, skuId)) {
    await revokeTopUpGrant(db, entitlementId);
    log.info({ id: entitlementId, guildId }, 'refunded top-up — remaining credits revoked');
  }
  if (env.SKU_CUSTOM_DOMAIN && skuId === env.SKU_CUSTOM_DOMAIN) {
    if (await hasOtherLiveEntitlement(db, guildId, skuId, entitlementId)) return;
    await updateGuildConfig(db, guildId, { customDomainUnlocked: false });
    log.info({ id: entitlementId, guildId }, 'refunded custom domain — unlock revoked');
  }
}
