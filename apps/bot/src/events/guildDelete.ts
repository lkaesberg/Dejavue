import { capture } from '@dejavue/analytics';
import type { Guild } from 'discord.js';

/**
 * Dejavue was removed from a server. There is nothing to clean up here — rows are kept so
 * a re-add restores the archive — but the departure itself is the churn signal the
 * activation/retention analytics are built on, so it must be recorded.
 */
export function onGuildDelete(guild: Guild): void {
  capture('guild_left', guild.id);
}
