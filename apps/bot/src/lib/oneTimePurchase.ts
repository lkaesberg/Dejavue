import type { Entitlement } from 'discord.js';
import { childLogger, getEnv, isTopUpSku, notifyAsync } from '@dejavue/core';
import {
  bridgeAndStoreEntitlement,
  getDb,
  getEntitlement,
  hasOtherLiveEntitlement,
  revokeTopUpGrant,
  TOP_UP_INTENT_TTL_MS,
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
 * launched the purchase from: the intent recorded per (user, SKU) with the buy button.
 * Bridging consumes the intent for the purchased SKU only, atomically with storing the
 * row (bridgeAndStoreEntitlement), so each intent bridges exactly one purchase.
 * A ladder click records an intent for every top-up pack, valid for
 * TOP_UP_INTENT_TTL_MS (30 min) after the click: several different packs bought from
 * one ladder message each bridge, while buying the SAME pack again needs a fresh click
 * (the second purchase finds no intent and is handled as unbridged, below). A top-up
 * intent is used only for a purchase made within 30 minutes of the click (purchase
 * time = the entitlement's snowflake, so a late-healed missed CREATE still bridges). The custom-domain intent has no age
 * limit. Each entitlement is bridged at most once: only while its stored row is unbound.
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
  let guildId: string | null;
  // Bridge only a purchase that isn't bound yet: an UPDATE / redelivery / reconcile of
  // an already-bound one must not consume a newer intent the buyer made for another
  // guild (that would steal the next purchase's binding).
  const userId = row.userId;
  // A refunded (deleted) purchase is never granted, so it must not use up an intent
  // either: that intent belongs to the buyer's next purchase of this SKU.
  if (!row.guildId && userId && oneTime && !ent.deleted && !(await getEntitlement(db, row.id))?.guildId) {
    const topUp = isTopUpSku(getEnv(), row.skuId);
    const res = await bridgeAndStoreEntitlement(
      db,
      { ...row, userId },
      { maxAgeMs: topUp ? TOP_UP_INTENT_TTL_MS : undefined },
    );
    guildId = res.guildId;
    if (res.bridged)
      log.info({ id: ent.id, skuId: ent.skuId, guildId }, 'bridged user-owned purchase to guild');
  } else {
    guildId = await upsertEntitlement(db, row);
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
          'Paid purchase with no guild to apply it to (no unused purchase intent for this SKU: ' +
          'never clicked, a top-up bought more than 30 min after the click, or the same pack bought twice from one click). ' +
          'Resolve by hand: ' +
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
