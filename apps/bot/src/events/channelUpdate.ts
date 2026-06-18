import { ChannelType, type DMChannel, type ForumChannel, type GuildChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getGuildConfig, setChannelGuidelines, updateChannelName } from '@dejavue/db';
import { refreshChannelTopic } from '../lib/channelFit';

const log = childLogger({ mod: 'event:channelUpdate' });

/** Read a channel's topic/description if it has one (forum, text, announcement). */
function topicOf(channel: GuildChannel | DMChannel | null): string | null {
  if (channel && 'topic' in channel) return (channel as { topic: string | null }).topic ?? null;
  return null;
}

/**
 * Keep a tracked channel's name and description in sync when they change in Discord,
 * so the KB categories / channel pages reflect the latest. Handles both monitored
 * forums and tracked normal (text / announcement) channels.
 */
export async function onChannelUpdate(
  oldChannel: DMChannel | GuildChannel,
  newChannel: DMChannel | GuildChannel,
): Promise<void> {
  const type = newChannel.type;
  const isForum = type === ChannelType.GuildForum;
  const isText = type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;
  if (!isForum && !isText) return;

  const channel = newChannel as GuildChannel;
  const guildId = channel.guildId;
  try {
    const db = getDb();
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg) return;
    const tracked = isForum
      ? cfg.forumChannelIds.includes(channel.id)
      : cfg.trackedChannelIds.includes(channel.id);
    if (!tracked) return;

    const oldName = oldChannel.type === type ? (oldChannel as GuildChannel).name : undefined;
    const nameChanged = oldName !== channel.name;
    const newTopic = topicOf(channel);
    const topicChanged = topicOf(oldChannel) !== newTopic;
    if (!nameChanged && !topicChanged) return;

    if (nameChanged) await updateChannelName(db, guildId, channel.id, channel.name);
    if (topicChanged) await setChannelGuidelines(db, guildId, channel.id, newTopic);

    // A forum's name/description feed its topic embedding — rebuild it so the
    // channel-fit check / guard stays accurate after a rename or guideline edit.
    if (isForum && (cfg.channelFitCheck || cfg.guardEnabled)) {
      await refreshChannelTopic(guildId, channel as ForumChannel, cfg.embeddingModel, newTopic).catch(
        (err) => log.warn({ err, channelId: channel.id }, 'failed to refresh channel topic'),
      );
    }
    log.info({ channelId: channel.id, guildId, nameChanged, topicChanged }, 'synced channel metadata');
  } catch (err) {
    log.warn({ err, channelId: channel.id }, 'failed to sync channel metadata');
  }
}
