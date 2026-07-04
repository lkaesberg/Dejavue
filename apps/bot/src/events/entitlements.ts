import type { Entitlement } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, markEntitlementDeleted, upsertEntitlement } from '@dejavue/db';
import { mapEntitlement } from '../lib/entitlementMap';
import { invalidateTier } from '../lib/tier';
import { grantTopUp } from '../lib/topUp';
import { checkTierUpgrade } from '../lib/upgrade';

const log = childLogger({ mod: 'event:entitlement' });

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
  await upsertEntitlement(getDb(), mapEntitlement(ent));
  await grantTopUp(ent);
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId);
  }
  log.info({ id: ent.id, skuId: ent.skuId, guildId: ent.guildId }, 'entitlement created');
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
}
