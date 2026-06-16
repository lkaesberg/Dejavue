import type { Entitlement as DiscordEntitlement } from 'discord.js';
import { getEnv } from '@dejavue/core';
import type { NewEntitlement } from '@dejavue/db';

/** Map a discord.js Entitlement to our DB row. */
export function mapEntitlement(ent: DiscordEntitlement): NewEntitlement {
  const env = getEnv();
  let type: NewEntitlement['type'] = 'unknown';
  if (env.SKU_BACKFILL && ent.skuId === env.SKU_BACKFILL) type = 'durable';
  else if (env.SKU_TOPUP && ent.skuId === env.SKU_TOPUP) type = 'consumable';
  else if (ent.guildId) type = 'guild_subscription';
  else if (ent.userId) type = 'user_subscription';

  return {
    id: ent.id,
    skuId: ent.skuId,
    guildId: ent.guildId ?? null,
    userId: ent.userId ?? null,
    type,
    // Active subscriptions + test entitlements have null timestamps → treated as active.
    startsAt: ent.startsTimestamp ? new Date(ent.startsTimestamp) : null,
    endsAt: ent.endsTimestamp ? new Date(ent.endsTimestamp) : null,
    deleted: ent.deleted,
  };
}
