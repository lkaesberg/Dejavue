import { capture } from '@dejavue/analytics';
import type { Entitlement } from 'discord.js';
import { childLogger, getEnv, notifyAsync, topUpCreditsForSku } from '@dejavue/core';
import { getDb, markEntitlementDeleted } from '@dejavue/db';
import { isOneTimeSku, revokeOneTimePurchase, storeAndFulfil } from '../lib/oneTimePurchase';
import { invalidateTier } from '../lib/tier';
import { checkTierUpgrade } from '../lib/upgrade';

const log = childLogger({ mod: 'event:entitlement' });

/** Human-readable product name for a SKU, for ops alerts. */
function productLabel(skuId: string): string {
  const env = getEnv();
  if (env.SKU_MAX && skuId === env.SKU_MAX) return 'Max subscription';
  if (env.SKU_PRO && skuId === env.SKU_PRO) return 'Pro subscription';
  if (env.SKU_PLUS && skuId === env.SKU_PLUS) return 'Plus subscription';
  const topUpCredits = topUpCreditsForSku(env, skuId);
  if (topUpCredits !== undefined) return `Credit top-up (+${topUpCredits.toLocaleString('en-US')})`;
  if (env.SKU_BACKFILL && skuId === env.SKU_BACKFILL) return 'History backfill';
  if (env.SKU_CUSTOM_DOMAIN && skuId === env.SKU_CUSTOM_DOMAIN) return 'Custom domain';
  return `SKU ${skuId}`;
}

/** Guild / user id fields shared across subscription alerts. */
function whoFields(e: { guildId?: string | null; userId?: string | null }) {
  return [
    { name: 'Guild', value: e.guildId ?? '—' },
    { name: 'User', value: e.userId ?? '—' },
  ];
}

/**
 * Full-field dump of an entitlement so we can see exactly what Discord delivers —
 * in particular whether one-time purchases (durable/consumable) arrive with a
 * `guildId` or only a `userId`. Grep the logs for `entitlement-probe`.
 */
function probe(event: 'CREATE' | 'UPDATE' | 'DELETE', ent: Entitlement): void {
  let raw: unknown = null;
  try {
    raw = ent.toJSON();
  } catch {
    /* toJSON can throw on partials; the explicit fields below are the signal */
  }
  log.info(
    {
      probe: 'entitlement-probe',
      event,
      id: ent.id,
      skuId: ent.skuId,
      applicationId: ent.applicationId,
      type: ent.type,
      userId: ent.userId ?? null,
      guildId: ent.guildId ?? null,
      hasUserId: ent.userId != null,
      hasGuildId: ent.guildId != null,
      deleted: ent.deleted,
      consumed: (ent as { consumed?: boolean | null }).consumed ?? null,
      startsTimestamp: ent.startsTimestamp ?? null,
      endsTimestamp: ent.endsTimestamp ?? null,
      raw,
    },
    `entitlement-probe ${event}`,
  );
}

export async function onEntitlementCreate(ent: Entitlement): Promise<void> {
  probe('CREATE', ent);
  // Bridges user-owned one-time purchases to their guild and fulfils them.
  const guildId = await storeAndFulfil(ent, { alertUnbridged: true });
  const row = { guildId, userId: ent.userId ?? null, skuId: ent.skuId, type: ent.type };
  if (guildId) {
    invalidateTier(guildId);
    await checkTierUpgrade(guildId);
    capture('entitlement_created', guildId, {
      sku_id: row.skuId,
      product_label: productLabel(ent.skuId),
    });
  }
  log.info({ id: ent.id, skuId: ent.skuId, guildId: row.guildId }, 'entitlement created');
  notifyAsync({
    level: 'success',
    title: `🎉 New ${productLabel(ent.skuId)}`,
    fields: [...whoFields(row), { name: 'Type', value: String(row.type ?? 'unknown') }],
  });
}

export async function onEntitlementUpdate(ent: Entitlement): Promise<void> {
  probe('UPDATE', ent);
  // A lapsing subscription arrives as UPDATE with endsTimestamp set — NOT delete.
  // A user-owned purchase keeps the guild it was bridged to (the payload has none).
  const guildId = await storeAndFulfil(ent);
  if (guildId) {
    invalidateTier(guildId);
    await checkTierUpgrade(guildId);
    capture('entitlement_updated', guildId, {
      sku_id: ent.skuId,
      product_label: productLabel(ent.skuId),
      // Discord signals a cancellation as an UPDATE that sets an end date, not a delete.
      reason: ent.endsTimestamp ? 'ending' : 'renewed',
    });
  }
  log.info({ id: ent.id, endsAt: ent.endsTimestamp }, 'entitlement updated');
  // Active subs & renewals keep endsTimestamp null (see tier.ts semantics), so a
  // set end date means the subscription is cancelled / not renewing — the churn
  // signal worth alerting on. Renewals produce no noise here.
  if (ent.endsTimestamp) {
    notifyAsync({
      level: 'warning',
      title: `⚠️ ${productLabel(ent.skuId)} ending`,
      description: `Ends <t:${Math.floor(ent.endsTimestamp / 1000)}:R>`,
      fields: whoFields(ent),
    });
  }
}

export async function onEntitlementDelete(ent: Entitlement): Promise<void> {
  probe('DELETE', ent);
  // DELETE only fires on refund / manual removal / test-entitlement deletion.
  const marked = await markEntitlementDeleted(getDb(), ent.id);
  // User-owned purchases carry no guild in the payload; the stored row knows it.
  const guildId = ent.guildId ?? marked?.row.guildId ?? null;
  if (guildId) {
    // Reverse what a refunded one-time purchase granted — once, on the flip.
    if (marked?.flipped && isOneTimeSku(ent.skuId)) {
      await revokeOneTimePurchase(ent.id, ent.skuId, guildId);
    }
    capture('entitlement_deleted', guildId, {
      sku_id: ent.skuId,
      product_label: productLabel(ent.skuId),
    });
    invalidateTier(guildId);
    await checkTierUpgrade(guildId); // records the downgrade; never backfills down
  }
  log.info({ id: ent.id }, 'entitlement deleted');
  notifyAsync({
    level: 'error',
    title: `❌ ${productLabel(ent.skuId)} removed`,
    description: 'Refund, manual removal, or test-entitlement deletion.',
    fields: whoFields({ guildId, userId: ent.userId }),
  });
}
