import { ChannelType, type DMChannel, type GuildChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  deleteChannelSync,
  deleteChannelTopic,
  deleteThreadsByChannel,
  getDb,
  getGuildConfig,
  updateGuildConfig,
} from '@dejavue/db';

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
    const tracked = !!cfg?.trackedChannelIds.includes(channel.id);
    const monitoredForum = !!cfg?.forumChannelIds.includes(channel.id);
    // Only purge content for channels we actually monitor (untracking an existing
    // channel keeps its archived answers — same semantics as removing it from the setup hub).
    if (isText && !tracked) return;

    const removed = await deleteThreadsByChannel(db, guildId, channel.id);
    await deleteChannelTopic(db, guildId, channel.id).catch(() => undefined);
    await deleteChannelSync(db, guildId, channel.id).catch(() => undefined);

    if (monitoredForum) {
      const channelModes = { ...(cfg?.channelModes ?? {}) };
      delete channelModes[channel.id];
      await updateGuildConfig(db, guildId, {
        forumChannelIds: (cfg?.forumChannelIds ?? []).filter((id) => id !== channel.id),
        channelModes,
      });
    }
    if (tracked) {
      await updateGuildConfig(db, guildId, {
        trackedChannelIds: (cfg?.trackedChannelIds ?? []).filter((id) => id !== channel.id),
      });
    }
    if (removed > 0) {
      log.info({ channelId: channel.id, guildId, removed }, 'purged deleted channel');
    }
  } catch (err) {
    log.warn({ err, channelId: channel.id }, 'failed to purge deleted channel');
  }
}
