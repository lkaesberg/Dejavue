import type { Entitlement } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, markEntitlementDeleted, upsertEntitlement } from '@dejavue/db';
import { mapEntitlement } from '../lib/entitlementMap';
import { invalidateTier } from '../lib/tier';
import { grantTopUp } from '../lib/topUp';
import { checkTierUpgrade } from '../lib/upgrade';

const log = childLogger({ mod: 'event:entitlement' });

export async function onEntitlementCreate(ent: Entitlement): Promise<void> {
  await upsertEntitlement(getDb(), mapEntitlement(ent));
  await grantTopUp(ent);
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId);
  }
  log.info({ id: ent.id, skuId: ent.skuId, guildId: ent.guildId }, 'entitlement created');
}

export async function onEntitlementUpdate(ent: Entitlement): Promise<void> {
  // A lapsing subscription arrives as UPDATE with endsTimestamp set — NOT delete.
  await upsertEntitlement(getDb(), mapEntitlement(ent));
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId);
  }
  log.info({ id: ent.id, endsAt: ent.endsTimestamp }, 'entitlement updated');
}

export async function onEntitlementDelete(ent: Entitlement): Promise<void> {
  // DELETE only fires on refund / manual removal / test-entitlement deletion.
  await markEntitlementDeleted(getDb(), ent.id);
  if (ent.guildId) {
    invalidateTier(ent.guildId);
    await checkTierUpgrade(ent.guildId); // records the downgrade; never backfills down
  }
  log.info({ id: ent.id }, 'entitlement deleted');
}
