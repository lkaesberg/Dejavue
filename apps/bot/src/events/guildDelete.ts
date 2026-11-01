import { capture } from '@dejavue/analytics';
import { childLogger } from '@dejavue/core';
import { getDb, markGuildRemoved } from '@dejavue/db';
import type { Guild } from 'discord.js';

const log = childLogger({ mod: 'event:guildDelete' });

/**
 * Dejavue was removed from a server. Nothing is deleted yet: the server is marked
 * removed, which takes its public KB offline at once, and the worker's daily retention
 * job purges its content after the grace period. Adding the bot back before then
 * restores everything. The departure is also the churn signal the analytics rely on.
 */
export function onGuildDelete(guild: Guild): void {
  capture('guild_left', guild.id);
  markGuildRemoved(getDb(), guild.id).catch((err) =>
    log.warn({ err, guildId: guild.id }, 'failed to mark server removed'),
  );
}
