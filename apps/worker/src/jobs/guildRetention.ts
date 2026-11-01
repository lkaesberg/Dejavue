import { childLogger } from '@dejavue/core';
import { getDb, listGuildsDueForPurge, purgeGuildContent, reconcileGuildPresence } from '@dejavue/db';
import { fetchBotGuilds } from '../lib/discordRest';

const log = childLogger({ mod: 'job:guild-retention' });

/**
 * How long a removed server's content is kept so re-adding the bot restores it. The
 * privacy policy (PlatformPrivacy.astro, "Retention") states this number — change both.
 */
export const REMOVED_GUILD_GRACE_DAYS = 30;

/**
 * Daily retention pass. First line the removal marks up with the servers Discord says
 * the bot is in (catching removals while the bot was offline, and re-adds), then purge
 * every server that has been gone longer than the grace period.
 *
 * Without a server list there is nothing safe to act on, so a failed fetch throws and
 * the job is retried rather than purging on a guess.
 */
export async function handleGuildRetention(): Promise<void> {
  const db = getDb();
  const present = await fetchBotGuilds();
  const { removed, restored } = await reconcileGuildPresence(
    db,
    present.map((g) => g.id),
  );

  const cutoff = new Date(Date.now() - REMOVED_GUILD_GRACE_DAYS * 24 * 60 * 60 * 1000);
  let purged = 0;
  for (const guildId of await listGuildsDueForPurge(db, cutoff)) {
    if (await purgeGuildContent(db, guildId)) {
      purged++;
      log.info({ guildId }, 'purged content of removed server');
    }
  }
  log.info({ present: present.length, removed, restored, purged }, 'guild retention pass done');
}
