import type { Entitlement } from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import { ensureGuildConfig, getDb, updateGuildConfig } from '@dejavue/db';

const log = childLogger({ mod: 'custom-domain' });

/**
 * Fulfil a custom-domain **consumable** purchase: permanently unlock the feature for
 * the guild in our own DB, then consume the entitlement so the buyer can purchase it
 * again for another server. We can't rely on the live entitlement (a consumed
 * consumable disappears), so the unlock lives on guildConfig. Idempotent: the flag is
 * simply re-set if the event is redelivered.
 */
export async function grantCustomDomain(
  ent: Entitlement,
  guildId: string | null | undefined,
): Promise<void> {
  const env = getEnv();
  if (!env.SKU_CUSTOM_DOMAIN || ent.skuId !== env.SKU_CUSTOM_DOMAIN || !guildId) return;
  const db = getDb();
  await ensureGuildConfig(db, guildId);
  await updateGuildConfig(db, guildId, { customDomainUnlocked: true });
  try {
    if (!ent.consumed) await ent.consume();
  } catch (err) {
    log.warn({ err, id: ent.id }, 'failed to consume custom-domain entitlement (unlock granted)');
  }
  log.info({ id: ent.id, guildId }, 'custom domain unlocked');
}
