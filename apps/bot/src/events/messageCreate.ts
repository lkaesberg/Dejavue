import { ChannelType, type Message } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { channelMode, getDb, getGuildConfig } from '@dejavue/db';
import { scheduleDedup } from '../lib/dedup';
import { forumParent } from '../lib/forum';
import { scheduleKnowledgeArchive } from '../lib/knowledge';
import { scheduleQuestionArchive } from '../lib/solve';
import { scheduleTrackedCapture, scheduleTrackedThread } from '../lib/trackedChannel';

const log = childLogger({ mod: 'event:messageCreate' });

/**
 * Two roles, by channel mode:
 *  - Question channels: fallback trigger for duplicate detection — if the starter
 *    message lands before (or instead of) a usable threadCreate, schedule dedup.
 *    Only the starter message matters; later replies don't re-run dedup. Collapses
 *    onto the same thread-id-keyed run as threadCreate via the scheduled set.
 *  - Knowledge channels: re-archive on *any* message. There is no solve point, so
 *    each new reply re-captures the transcript and re-embeds — otherwise a thread
 *    would be indexed with only its opening post. Debounced in scheduleKnowledgeArchive.
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  const channel = message.channel;

  // Tracked normal (non-forum) channels: capture conversation segments for the KB.
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    try {
      const cfg = await getGuildConfig(getDb(), channel.guildId);
      if (cfg?.trackedChannelIds?.includes(channel.id)) scheduleTrackedCapture(channel);
    } catch (err) {
      log.warn({ err, channelId: channel.id }, 'tracked-channel capture failed');
    }
    return;
  }

  if (!channel.isThread()) return;

  // A thread inside a tracked normal channel → capture it as its own KB entry
  // (sub-conversation), grouped under the parent channel.
  const parent = channel.parent;
  if (
    parent &&
    (parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildAnnouncement)
  ) {
    try {
      const cfg = await getGuildConfig(getDb(), channel.guildId);
      if (cfg?.trackedChannelIds?.includes(parent.id)) scheduleTrackedThread(channel);
    } catch (err) {
      log.warn({ err, threadId: channel.id }, 'tracked-thread capture failed');
    }
    return;
  }

  const forum = forumParent(channel);
  if (!forum) return;

  try {
    const cfg = await getGuildConfig(getDb(), channel.guildId);
    if (cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) return;
    if (channelMode(cfg, forum.id) === 'knowledge') {
      // Any message keeps the archived/embedded copy current, not just the starter.
      scheduleKnowledgeArchive(channel);
    } else {
      // Question channel: keep the KB transcript current on every message (the whole
      // chat log), and run dedup once — when the starter (shares the thread id) lands.
      scheduleQuestionArchive(channel);
      if (message.id === channel.id) scheduleDedup(channel);
    }
  } catch (err) {
    log.warn({ err, threadId: channel.id }, 'messageCreate fallback failed');
  }
}
