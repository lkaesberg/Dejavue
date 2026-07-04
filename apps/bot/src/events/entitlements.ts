import type { Entitlement } from 'discord.js';
import { childLogger, getEnv, notifyAsync } from '@dejavue/core';
import { getDb, markEntitlementDeleted, upsertEntitlement } from '@dejavue/db';
import { mapEntitlement } from '../lib/entitlementMap';
import { invalidateTier } from '../lib/tier';
import { grantTopUp } from '../lib/topUp';
import { checkTierUpgrade } from '../lib/upgrade';

const log = childLogger({ mod: 'event:entitlement' });

/** Human-readable product name for a SKU, for ops alerts. */
function productLabel(skuId: string): string {
  const env = getEnv();
  if (env.SKU_MAX && skuId === env.SKU_MAX) return 'Max subscription';
  if (env.SKU_PRO && skuId === env.SKU_PRO) return 'Pro subscription';
  if (env.SKU_PLUS && skuId === env.SKU_PLUS) return 'Plus subscription';
  if (env.SKU_TOPUP && skuId === env.SKU_TOPUP) return 'Credit top-up';
  if (env.SKU_BACKFILL && skuId === env.SKU_BACKFILL) return 'History backfill';
  if (env.SKU_CUSTOM_DOMAIN && skuId === env.SKU_CUSTOM_DOMAIN) return 'Custom domain';
  return `SKU ${skuId}`;
}

/** Guild / user id fields shared across subscription alerts. */
function whoFields(ent: Entitlement) {
  return [
    { name: 'Guild', value: ent.guildId ?? '—' },
    { name: 'User', value: ent.userId ?? '—' },
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
  const row = mapEntitlement(ent);
  await upsertEntitlement(getDb(), row);
  await grantTopUp(ent);
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId);
  }
  log.info({ id: ent.id, skuId: ent.skuId, guildId: ent.guildId }, 'entitlement created');
  notifyAsync({
    level: 'success',
    title: `🎉 New ${productLabel(ent.skuId)}`,
    fields: [...whoFields(ent), { name: 'Type', value: row.type ?? 'unknown' }],
  });
}

export async function onEntitlementUpdate(ent: Entitlement): Promise<void> {
  probe('UPDATE', ent);
  // A lapsing subscription arrives as UPDATE with endsTimestamp set — NOT delete.
  await upsertEntitlement(getDb(), mapEntitlement(ent));
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId);
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
  await markEntitlementDeleted(getDb(), ent.id);
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId); // records the downgrade; never backfills down
  }
  log.info({ id: ent.id }, 'entitlement deleted');
  notifyAsync({
    level: 'error',
    title: `❌ ${productLabel(ent.skuId)} removed`,
    description: 'Refund, manual removal, or test-entitlement deletion.',
    fields: whoFields(ent),
  });
}
