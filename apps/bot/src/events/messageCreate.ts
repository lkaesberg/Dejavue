import type { Message } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { channelMode, getDb, getGuildConfig } from '@dejavue/db';
import { scheduleDedup } from '../lib/dedup';
import { forumParent } from '../lib/forum';
import { scheduleKnowledgeArchive } from '../lib/knowledge';

const log = childLogger({ mod: 'event:messageCreate' });

/**
 * Fallback trigger for duplicate detection: if the starter message lands before
 * (or instead of) a usable threadCreate, schedule dedup. Collapses onto the same
 * thread-id-keyed run as threadCreate via the scheduled set.
 */
export async function onMessageCreate(message: Message): Promise<void> {
  if (message.author.bot) return;
  const channel = message.channel;
  if (!channel.isThread()) return;
  const forum = forumParent(channel);
  if (!forum) return;
  // The starter message of a forum post shares the thread's id.
  if (message.id !== channel.id) return;

  try {
    const cfg = await getGuildConfig(getDb(), channel.guildId);
    if (cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) return;
    if (channelMode(cfg, forum.id) === 'knowledge') {
      scheduleKnowledgeArchive(channel);
    } else {
      scheduleDedup(channel);
    }
  } catch (err) {
    log.warn({ err, threadId: channel.id }, 'messageCreate fallback failed');
  }
}
