import type { ThreadChannel } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  setMarkedDuplicate,
  setPublished,
  setThreadLabels,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import { findTagByName, forumParent, threadLabels } from '../lib/forum';
import { closeThread } from '../lib/solve';
import { monitoredForum } from '../lib/tier';

const log = childLogger({ mod: 'event:threadUpdate' });

const sortedTags = (t: ThreadChannel): string => [...(t.appliedTags ?? [])].sort().join(',');
const sameLabels = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

/** Is the forum's managed `duplicate` tag currently applied to this post? */
function hasDuplicateTag(thread: ThreadChannel): boolean {
  const forum = forumParent(thread);
  if (!forum) return false;
  const tagId = findTagByName(forum, 'duplicate');
  return tagId != null && thread.appliedTags.includes(tagId);
}

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
    if (!(await monitoredForum(guildId, cfg, forum.id))) return;

    // Only update threads we've already indexed.
    const existing = await getThreadByDiscordId(db, guildId, newThread.id);
    if (!existing) return;

    // Hand-folding: a moderator applying the managed `duplicate` tag is saying "this
    // isn't the canonical answer", so honour it exactly like an accepted duplicate —
    // out of duplicate suggestions and search, and no KB page of its own. Removing the
    // tag puts a solved post back (unless it's also folded onto a canonical thread).
    const marked = hasDuplicateTag(newThread);
    if (marked !== existing.markedDuplicate) {
      await setMarkedDuplicate(db, guildId, newThread.id, marked);
      const publish = !marked && existing.status === 'solved' && !existing.doNotPublish && !existing.duplicateOfThreadId;
      if (marked ? existing.publishedToKb : publish) {
        const action = marked ? 'unpublish' : 'publish';
        await setPublished(db, guildId, newThread.id, !marked);
        await enqueueRevalidateKb({ guildId, threadId: newThread.id, action }).catch(() => undefined);
      }
      // Close it like the accept button does — the answer is on the canonical post, so
      // there's nothing to add here. Removing the tag reopens an unsolved post (a
      // solved one stays closed, which is where solving left it).
      if (marked) {
        await closeThread(newThread);
      } else if (existing.status !== 'solved') {
        if (newThread.archived) await newThread.setArchived(false).catch(() => undefined);
        if (newThread.locked) await newThread.setLocked(false).catch(() => undefined);
      }
      log.debug({ threadId: newThread.id, marked }, 'synced hand-applied duplicate tag');
    }

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
