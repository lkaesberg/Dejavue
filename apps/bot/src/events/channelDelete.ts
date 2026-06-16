import { ChannelType, type DMChannel, type GuildChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { deleteThreadsByChannel, getDb, getGuildConfig, updateGuildConfig } from '@dejavue/db';

const log = childLogger({ mod: 'event:channelDelete' });

/**
 * A forum channel was deleted → purge all its threads from the index and untrack
 * it (drop from forumChannelIds + channelModes). Handles delete-and-recreate,
 * which otherwise leaves the old channel's threads as ghosts.
 */
export async function onChannelDelete(channel: DMChannel | GuildChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildForum) return;
  const guildId = channel.guildId;
  try {
    const db = getDb();
    const removed = await deleteThreadsByChannel(db, guildId, channel.id);

    const cfg = await getGuildConfig(db, guildId);
    if (cfg?.forumChannelIds.includes(channel.id)) {
      const channelModes = { ...(cfg.channelModes ?? {}) };
      delete channelModes[channel.id];
      await updateGuildConfig(db, guildId, {
        forumChannelIds: cfg.forumChannelIds.filter((id) => id !== channel.id),
        channelModes,
      });
    }
    if (removed > 0) {
      log.info({ channelId: channel.id, guildId, removed }, 'purged deleted forum channel');
    }
  } catch (err) {
    log.warn({ err, channelId: channel.id }, 'failed to purge deleted channel');
  }
}
