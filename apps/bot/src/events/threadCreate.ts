import type { AnyThreadChannel, ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getGuildConfig, getThreadByDiscordId } from '@dejavue/db';
import { scheduleDedup } from '../lib/dedup';
import { controlMessage } from '../lib/embeds';
import { forumParent } from '../lib/forum';
import { ensureThreadRow, tagUnsolved } from '../lib/solve';
import { getGuildTier, limitsFor } from '../lib/tier';

const log = childLogger({ mod: 'event:threadCreate' });

export async function onThreadCreate(
  thread: AnyThreadChannel,
  newlyCreated: boolean,
): Promise<void> {
  // `newlyCreated` is false when the bot is merely added to an existing thread.
  if (!newlyCreated) return;
  const forum = forumParent(thread);
  if (!forum) return;

  const guildId = thread.guildId;
  const db = getDb();
  const cfg = await getGuildConfig(db, guildId);
  // Only act on configured forums (once any are configured).
  if (cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) return;

  // Already-solved threads (demo seeds / re-triggers) need no control message or unsolved tag.
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing?.status === 'solved') return;

  const t = thread as ThreadChannel;
  try {
    await ensureThreadRow(t);
    await tagUnsolved(t);
    const showBranding = !limitsFor(await getGuildTier(guildId)).removeBranding;
    await t.send(controlMessage(showBranding));
    // Debounced duplicate detection (handles the starter-message race in-process).
    scheduleDedup(t);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'threadCreate handling failed');
  }
}
