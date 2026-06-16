import {
  ChannelType,
  type ForumChannel,
  type GuildForumTagData,
  type ThreadChannel,
} from 'discord.js';
import type { TranscriptMessage } from '@dejavue/db';

/** True when this thread is a post inside a forum channel. */
export function isForumThread(thread: ThreadChannel): boolean {
  return thread.parent?.type === ChannelType.GuildForum;
}

/** Narrow a thread's parent to a ForumChannel, or null. */
export function forumParent(thread: ThreadChannel): ForumChannel | null {
  const parent = thread.parent;
  return parent && parent.type === ChannelType.GuildForum ? (parent as ForumChannel) : null;
}

export interface StarterText {
  content: string;
  authorId?: string;
  messageId?: string;
}

/** Best-effort fetch of a forum post's starter message (may race on creation). */
export async function getStarterText(thread: ThreadChannel): Promise<StarterText | null> {
  try {
    const msg = await thread.fetchStarterMessage();
    if (!msg) return null;
    return { content: msg.content ?? '', authorId: msg.author?.id, messageId: msg.id };
  } catch {
    return null;
  }
}

/** Resolve the per-forum solved/unsolved tag ids by name (robust across forums). */
export function findForumTags(forum: ForumChannel): {
  solvedTagId?: string;
  unsolvedTagId?: string;
} {
  const solved = forum.availableTags.find((t) => t.name.toLowerCase() === 'solved');
  const unsolved = forum.availableTags.find((t) => t.name.toLowerCase() === 'unsolved');
  return { solvedTagId: solved?.id, unsolvedTagId: unsolved?.id };
}

/** Find a forum tag id by (case-insensitive) name, e.g. "duplicate". */
export function findTagByName(forum: ForumChannel, name: string): string | undefined {
  return forum.availableTags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id;
}

/** Ensure "solved" + "unsolved" tags exist on the forum, creating any missing ones. */
export async function ensureForumTags(
  forum: ForumChannel,
): Promise<{ solvedTagId: string; unsolvedTagId: string }> {
  let { solvedTagId, unsolvedTagId } = findForumTags(forum);
  if (solvedTagId && unsolvedTagId) return { solvedTagId, unsolvedTagId };

  const existing: GuildForumTagData[] = forum.availableTags.map((t) => ({
    id: t.id,
    name: t.name,
    moderated: t.moderated,
    emoji: t.emoji ? { id: t.emoji.id, name: t.emoji.name } : null,
  }));
  const additions: GuildForumTagData[] = [];
  if (!solvedTagId) additions.push({ name: 'solved', moderated: false, emoji: null });
  if (!unsolvedTagId) additions.push({ name: 'unsolved', moderated: false, emoji: null });

  const updated = await forum.setAvailableTags([...existing, ...additions]);
  ({ solvedTagId, unsolvedTagId } = findForumTags(updated));
  if (!solvedTagId || !unsolvedTagId) {
    throw new Error('failed to ensure forum tags');
  }
  return { solvedTagId, unsolvedTagId };
}

/** Apply a tag to a thread (idempotent), respecting the 5-tag forum limit. */
export async function applyTag(thread: ThreadChannel, tagId: string): Promise<void> {
  if (thread.appliedTags.includes(tagId)) return;
  await thread.setAppliedTags([...thread.appliedTags, tagId].slice(0, 5));
}

/**
 * Fetch the full human conversation of a thread (oldest → newest), excluding bot
 * messages. Paginates up to `max` messages. Best-effort.
 */
export async function fetchTranscript(
  thread: ThreadChannel,
  max = 300,
): Promise<TranscriptMessage[]> {
  const collected: TranscriptMessage[] = [];
  let before: string | undefined;
  try {
    while (collected.length < max) {
      const batch = await thread.messages.fetch(
        before ? { limit: 100, before } : { limit: 100 },
      );
      if (batch.size === 0) break;
      for (const msg of batch.values()) {
        if (msg.author?.bot) continue;
        const content = msg.content?.trim();
        if (!content) continue;
        collected.push({
          authorId: msg.author.id,
          content,
          createdAt: new Date(msg.createdTimestamp).toISOString(),
        });
      }
      before = batch.last()?.id; // collection is newest-first, so last() is oldest
      if (!before || batch.size < 100) break;
    }
  } catch {
    /* best effort */
  }
  collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return collected.slice(0, max);
}
