import type { Entitlement } from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import { addTopUpGrant, getDb } from '@dejavue/db';

const log = childLogger({ mod: 'topup' });

/**
 * Convert a purchased top-up consumable into AI credits. Idempotent: the grant
 * is keyed by the entitlement id (insert is onConflictDoNothing), so a
 * re-delivered event or a reconcile re-run can never double-credit. Consuming
 * the entitlement tells Discord the purchase was fulfilled and allows
 * repurchase; if consume() fails the credits are already granted and the next
 * reconcile pass retries the consume.
 */
export async function grantTopUp(
  ent: Entitlement,
  guildId: string | null | undefined = ent.guildId,
): Promise<void> {
  const env = getEnv();
  if (!env.SKU_TOPUP || ent.skuId !== env.SKU_TOPUP || !guildId) return;
  await addTopUpGrant(getDb(), { id: ent.id, guildId, credits: env.TOPUP_CREDITS });
  try {
    if (!ent.consumed) await ent.consume();
  } catch (err) {
    log.warn({ err, id: ent.id }, 'failed to consume top-up entitlement (credits granted)');
  }
  log.info({ id: ent.id, guildId, credits: env.TOPUP_CREDITS }, 'top-up credits granted');
}
