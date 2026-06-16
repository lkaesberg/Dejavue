import type { AnyThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { deleteThreadByDiscordId, getDb } from '@dejavue/db';

const log = childLogger({ mod: 'event:threadDelete' });

/**
 * A forum post was deleted → drop it from the index immediately so it can't
 * ghost the KB / search. A no-op if we weren't tracking it.
 */
export async function onThreadDelete(thread: AnyThreadChannel): Promise<void> {
  if (!thread.guildId) return;
  try {
    const removed = await deleteThreadByDiscordId(getDb(), thread.guildId, thread.id);
    if (removed > 0) {
      log.info({ threadId: thread.id, guildId: thread.guildId }, 'purged deleted thread');
    }
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to purge deleted thread');
  }
}
