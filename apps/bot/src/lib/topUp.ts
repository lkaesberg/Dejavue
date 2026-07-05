import type { Entitlement } from 'discord.js';
import { childLogger, getEnv, topUpCreditsForSku, topUpTiers } from '@dejavue/core';
import { addTopUpGrant, getDb, recordPurchaseIntent } from '@dejavue/db';

const log = childLogger({ mod: 'topup' });

/**
 * Convert a purchased top-up consumable into AI credits. The credit amount is
 * derived from which pack SKU was bought (see @dejavue/core `topUpTiers`).
 * Idempotent: the grant is keyed by the entitlement id (insert is
 * onConflictDoNothing), so a re-delivered event or a reconcile re-run can never
 * double-credit. Consuming the entitlement tells Discord the purchase was
 * fulfilled and allows repurchase; if consume() fails the credits are already
 * granted and the next reconcile pass retries the consume.
 */
export async function grantTopUp(
  ent: Entitlement,
  guildId: string | null | undefined = ent.guildId,
): Promise<void> {
  const credits = topUpCreditsForSku(getEnv(), ent.skuId);
  if (credits === undefined || !guildId) return;
  await addTopUpGrant(getDb(), { id: ent.id, guildId, credits });
  try {
    if (!ent.consumed) await ent.consume();
  } catch (err) {
    log.warn({ err, id: ent.id }, 'failed to consume top-up entitlement (credits granted)');
  }
  log.info({ id: ent.id, guildId, credits }, 'top-up credits granted');
}

/**
 * Prepare the native Premium buy buttons for the top-up ladder: record a purchase
 * intent for every configured pack (a one-time purchase is user-owned and carries
 * no guildId, so we must remember which guild the user launched it from — whichever
 * pack they pick) and return the pack SKU ids in ascending order for the buttons.
 */
export async function prepareTopUpSkus(userId: string, guildId: string): Promise<string[]> {
  const tiers = topUpTiers(getEnv());
  for (const tier of tiers) {
    await recordPurchaseIntent(getDb(), { userId, skuId: tier.skuId, guildId });
  }
  return tiers.map((tier) => tier.skuId);
}
