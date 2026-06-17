import type { Message } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { channelMode, getDb, getGuildConfig } from '@dejavue/db';
import { scheduleDedup } from '../lib/dedup';
import { forumParent } from '../lib/forum';
import { scheduleKnowledgeArchive } from '../lib/knowledge';

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
  if (!channel.isThread()) return;
  const forum = forumParent(channel);
  if (!forum) return;

  try {
    const cfg = await getGuildConfig(getDb(), channel.guildId);
    if (cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) return;
    if (channelMode(cfg, forum.id) === 'knowledge') {
      // Any message keeps the archived/embedded copy current, not just the starter.
      scheduleKnowledgeArchive(channel);
    } else if (message.id === channel.id) {
      // Question channel: only the starter message (shares the thread's id) triggers dedup.
      scheduleDedup(channel);
    }
  } catch (err) {
    log.warn({ err, threadId: channel.id }, 'messageCreate fallback failed');
  }
}
