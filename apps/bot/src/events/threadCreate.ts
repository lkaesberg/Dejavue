import type { AnyThreadChannel, ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { channelMode, getDb, getGuildConfig, getThreadByDiscordId } from '@dejavue/db';
import { scheduleDedup } from '../lib/dedup';
import { showBrandingFor } from '../lib/branding';
import { controlMessage } from '../lib/embeds';
import { forumParent } from '../lib/forum';
import { scheduleKnowledgeArchive } from '../lib/knowledge';
import { ensureThreadRow, tagUnsolved } from '../lib/solve';
import { monitoredForum } from '../lib/tier';

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
  // Only act on monitored forums (configured + within the tier's channel cap).
  if (!(await monitoredForum(guildId, cfg, forum.id))) return;

  // Already-solved threads (demo seeds / re-triggers) need no control message or unsolved tag.
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing?.status === 'solved') return;

  const t = thread as ThreadChannel;
  try {
    // Knowledge channels are a pure archive — no Q&A workflow, just capture it.
    if (channelMode(cfg, forum.id) === 'knowledge') {
      scheduleKnowledgeArchive(t);
      return;
    }
    await ensureThreadRow(t);
    await tagUnsolved(t);
    const showBranding = await showBrandingFor(guildId);
    await t.send(controlMessage(showBranding));
    // Debounced duplicate detection (handles the starter-message race in-process).
    scheduleDedup(t);
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'threadCreate handling failed');
  }
}
