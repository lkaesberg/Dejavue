import { ChannelType, type DMChannel, type ForumChannel, type GuildChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getGuildConfig, setChannelGuidelines, updateChannelName } from '@dejavue/db';
import { refreshChannelTopic } from '../lib/channelFit';

const log = childLogger({ mod: 'event:channelUpdate' });

/**
 * Keep a tracked forum's name and post-guidelines (its topic) in sync when they
 * change in Discord — the KB categories and channel pages reflect the latest.
 */
export async function onChannelUpdate(
  oldChannel: DMChannel | GuildChannel,
  newChannel: DMChannel | GuildChannel,
): Promise<void> {
  if (newChannel.type !== ChannelType.GuildForum) return;
  const forum = newChannel as ForumChannel;
  const old = oldChannel.type === ChannelType.GuildForum ? (oldChannel as ForumChannel) : null;
  const guildId = forum.guildId;
  try {
    const db = getDb();
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg?.forumChannelIds.includes(forum.id)) return;

    const nameChanged = !old || old.name !== forum.name;
    const topicChanged = !old || (old.topic ?? null) !== (forum.topic ?? null);
    if (!nameChanged && !topicChanged) return;

    if (nameChanged) await updateChannelName(db, guildId, forum.id, forum.name);
    if (topicChanged) await setChannelGuidelines(db, guildId, forum.id, forum.topic ?? null);
    // The channel's name/description feed its topic embedding — rebuild it so the
    // channel-fit check stays accurate after a rename or guideline edit.
    if (cfg.channelFitCheck) {
      await refreshChannelTopic(guildId, forum, cfg.embeddingModel, forum.topic).catch((err) =>
        log.warn({ err, channelId: forum.id }, 'failed to refresh channel topic'),
      );
    }
    log.info({ channelId: forum.id, guildId, nameChanged, topicChanged }, 'synced forum metadata');
  } catch (err) {
    log.warn({ err, channelId: forum.id }, 'failed to sync forum metadata');
  }
}
