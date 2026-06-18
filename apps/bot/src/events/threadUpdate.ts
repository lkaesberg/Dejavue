import type { ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getGuildConfig, getThreadByDiscordId, setThreadLabels } from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import { forumParent, threadLabels } from '../lib/forum';

const log = childLogger({ mod: 'event:threadUpdate' });

const sortedTags = (t: ThreadChannel): string => [...(t.appliedTags ?? [])].sort().join(',');
const sameLabels = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/**
 * Keep the KB in sync when a moderator changes a thread's forum tags (custom labels)
 * without posting a message — otherwise the published page would show stale labels
 * until the thread was next touched. We compare the freshly-derived labels against the
 * labels stored on the row (the source of truth), so this is robust even when the
 * cached `oldThread` is partial, and only writes when the custom labels actually change
 * (managed solved/unsolved/duplicate/wrong-channel flips don't move the stored labels).
 */
export async function onThreadUpdate(
  oldThread: ThreadChannel,
  newThread: ThreadChannel,
): Promise<void> {
  const forum = forumParent(newThread);
  if (!forum) return;
  // Fast path: skip the non-tag updates (archive, lock, rename, auto-archive…).
  if (sortedTags(oldThread) === sortedTags(newThread)) return;

  try {
    const db = getDb();
    const guildId = newThread.guildId;
    const cfg = await getGuildConfig(db, guildId);
    if (cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) return;

    // Only update threads we've already indexed.
    const existing = await getThreadByDiscordId(db, guildId, newThread.id);
    if (!existing) return;

    const after = threadLabels(newThread);
    if (sameLabels(existing.labels, after)) return; // custom labels unchanged

    await setThreadLabels(db, guildId, newThread.id, after);
    // SSR reads labels live, so the next page load already reflects this; revalidate
    // anyway so a future CDN/edge cache gets purged.
    if (existing.publishedToKb) {
      await enqueueRevalidateKb({ guildId, threadId: newThread.id, action: 'publish' }).catch(
        () => undefined,
      );
    }
    log.debug({ threadId: newThread.id, after }, 'synced thread labels');
  } catch (err) {
    log.warn({ err, threadId: newThread.id }, 'threadUpdate label sync failed');
  }
}
