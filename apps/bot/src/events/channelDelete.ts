import { ChannelType, type DMChannel, type GuildChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { forgetDeletedChannel, getDb, getGuildConfig } from '@dejavue/db';

const log = childLogger({ mod: 'event:channelDelete' });

/**
 * A monitored channel was deleted → purge all its threads/segments from the index,
 * drop its sync + topic state, and untrack it. Handles both forum channels and
 * tracked normal channels, and the delete-and-recreate case (which would otherwise
 * leave the old channel's content as ghosts).
 */
export async function onChannelDelete(channel: DMChannel | GuildChannel): Promise<void> {
  const isForum = channel.type === ChannelType.GuildForum;
  const isText =
    channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
  if (!isForum && !isText) return;
  const guildId = channel.guildId;
  try {
    const db = getDb();
    const cfg = await getGuildConfig(db, guildId);
    // Only purge content for channels we actually monitor (untracking an existing
    // channel keeps its archived answers — same semantics as removing it from the setup hub).
    if (isText && !cfg?.trackedChannelIds.includes(channel.id)) return;

    const removed = await forgetDeletedChannel(db, guildId, channel.id);
    if (removed > 0) {
      log.info({ channelId: channel.id, guildId, removed }, 'purged deleted channel');
    }
  } catch (err) {
    log.warn({ err, channelId: channel.id }, 'failed to purge deleted channel');
  }
}
