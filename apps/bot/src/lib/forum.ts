import {
  ChannelType,
  type ForumChannel,
  type GuildForumTagData,
  type ThreadChannel,
} from 'discord.js';
import type { TranscriptMessage } from '@dejavue/db';
import type { IngestAttachmentItem } from '@dejavue/queue';
import { mapAttachments, queueImageRehost } from './attachments';

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

/** The starter message can arrive after threadCreate fires — retry a few times. */
export async function fetchStarterWithRetry(
  thread: ThreadChannel,
  attempts = 3,
  delayMs = 1500,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const starter = await getStarterText(thread);
    if (starter && starter.content.trim()) return starter.content;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return '';
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

/** Tag names Dejavue manages itself — never surfaced as user "labels" on the KB. */
const MANAGED_TAG_NAMES = new Set(['solved', 'unsolved', 'duplicate', 'wrong-channel']);

/**
 * The custom labels (forum tags) a thread carries — the applied tags minus our
 * managed ones — resolved to their display names. Empty for non-forum threads.
 */
export function threadLabels(thread: ThreadChannel): string[] {
  const forum = forumParent(thread);
  if (!forum) return [];
  const nameById = new Map(forum.availableTags.map((t) => [t.id, t.name]));
  const labels: string[] = [];
  for (const id of thread.appliedTags) {
    const name = nameById.get(id);
    if (name && !MANAGED_TAG_NAMES.has(name.toLowerCase())) labels.push(name);
  }
  return labels;
}

/**
 * Our managed forum tags. Each carries an emoji and is `moderated: true`, so only
 * members with Manage Threads — and the bot — can apply or remove them (regular
 * posters can't flip their own thread to "solved").
 */
const MANAGED_TAGS: { name: string; emoji: string }[] = [
  { name: 'solved', emoji: '✅' },
  { name: 'unsolved', emoji: '❓' },
  { name: 'duplicate', emoji: '🔁' },
];

/**
 * Ensure the solved / unsolved / duplicate tags exist on the forum, each with its
 * emoji + `moderated: true`. Reconciles existing tags too (re-running setup, or a
 * bot restart, upgrades tags that predate the emoji / moderated flags). Writes to
 * Discord only when something actually differs. Needs the Manage Channels permission.
 */
export async function ensureForumTags(
  forum: ForumChannel,
): Promise<{ solvedTagId: string; unsolvedTagId: string; duplicateTagId: string }> {
  const specByName = new Map(MANAGED_TAGS.map((s) => [s.name, s]));

  // Rebuild the full tag list, forcing our managed tags to the desired spec and
  // leaving every other tag untouched.
  const desired: GuildForumTagData[] = forum.availableTags.map((t) => {
    const spec = specByName.get(t.name.toLowerCase());
    if (spec) return { id: t.id, name: t.name, moderated: true, emoji: { id: null, name: spec.emoji } };
    return {
      id: t.id,
      name: t.name,
      moderated: t.moderated,
      emoji: t.emoji ? { id: t.emoji.id, name: t.emoji.name } : null,
    };
  });

  // Append any managed tag the forum doesn't have yet.
  const present = new Set(forum.availableTags.map((t) => t.name.toLowerCase()));
  for (const s of MANAGED_TAGS) {
    if (!present.has(s.name)) desired.push({ name: s.name, moderated: true, emoji: { id: null, name: s.emoji } });
  }

  // Only call the API when a managed tag is missing or out of spec.
  const changed =
    desired.length !== forum.availableTags.length ||
    forum.availableTags.some((t) => {
      const spec = specByName.get(t.name.toLowerCase());
      return spec ? !t.moderated || t.emoji?.name !== spec.emoji : false;
    });

  const updated = changed ? await forum.setAvailableTags(desired) : forum;

  const { solvedTagId, unsolvedTagId } = findForumTags(updated);
  const duplicateTagId = findTagByName(updated, 'duplicate');
  if (!solvedTagId || !unsolvedTagId || !duplicateTagId) {
    throw new Error('failed to ensure forum tags');
  }
  return { solvedTagId, unsolvedTagId, duplicateTagId };
}

/**
 * Ensure a moderated "wrong-channel" tag exists on the forum, creating it on demand.
 * Used by the off-topic guard's auto-close (kept off MANAGED_TAGS so guilds that never
 * enable the guard don't grow an extra tag). Needs the Manage Channels permission.
 */
export async function ensureWrongChannelTag(forum: ForumChannel): Promise<string> {
  const existing = findTagByName(forum, 'wrong-channel');
  if (existing) return existing;
  const desired: GuildForumTagData[] = forum.availableTags.map((t) => ({
    id: t.id,
    name: t.name,
    moderated: t.moderated,
    emoji: t.emoji ? { id: t.emoji.id, name: t.emoji.name } : null,
  }));
  desired.push({ name: 'wrong-channel', moderated: true, emoji: { id: null, name: '🚫' } });
  const updated = await forum.setAvailableTags(desired);
  const id = findTagByName(updated, 'wrong-channel');
  if (!id) throw new Error('failed to ensure wrong-channel tag');
  return id;
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
  const images: IngestAttachmentItem[] = [];
  let before: string | undefined;
  try {
    while (collected.length < max) {
      const batch = await thread.messages.fetch(
        before ? { limit: 100, before } : { limit: 100 },
      );
      if (batch.size === 0) break;
      for (const msg of batch.values()) {
        if (msg.author?.bot) continue;
        const content = msg.content?.trim() ?? '';
        const { attachments, images: imgs } = mapAttachments(msg.attachments.values());
        if (!content && attachments.length === 0) continue; // nothing to keep
        images.push(...imgs);
        collected.push({
          id: msg.id,
          authorId: msg.author.id,
          content,
          createdAt: new Date(msg.createdTimestamp).toISOString(),
          ...(attachments.length ? { attachments } : {}),
        });
      }
      before = batch.last()?.id; // collection is newest-first, so last() is oldest
      if (!before || batch.size < 100) break;
    }
  } catch {
    /* best effort */
  }
  collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Re-host images while their Discord urls are fresh (deduped in the worker).
  await queueImageRehost(thread.guildId, images);
  return collected.slice(0, max);
}
