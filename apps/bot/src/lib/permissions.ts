import { PermissionFlagsBits, type PermissionsBitField, type ThreadChannel } from 'discord.js';
import { getDb, getThreadByDiscordId } from '@dejavue/db';

// "Moderator group or admin" — any of these permissions counts. (Administrator
// implies the rest, so admins always pass.)
const MOD_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ModerateMembers,
] as const;

/** Only the thread creator, a moderator, or an admin may resolve a thread. */
export function canResolveThread(
  perms: Readonly<PermissionsBitField> | null,
  isOriginalPoster: boolean,
): boolean {
  if (isOriginalPoster) return true;
  if (!perms) return false;
  return MOD_PERMS.some((p) => perms.has(p));
}

export const NO_PERMISSION_MESSAGE =
  'Only the original poster, a moderator, or an admin can mark this solved.';

/**
 * Is this user the thread's original poster? `ownerId` can be null on a thread
 * that isn't fully hydrated (e.g. resurfaced from a cold cache) — a naive
 * `ownerId === userId` would then wrongly block the legitimate OP, so re-fetch
 * before giving up.
 */
export async function isThreadOp(thread: ThreadChannel, userId: string): Promise<boolean> {
  if (thread.ownerId) return thread.ownerId === userId;
  try {
    const fresh = await thread.fetch();
    return fresh.ownerId === userId;
  } catch {
    return false;
  }
}

/**
 * Is this user the person who asked? Discord makes *the bot* the owner of a post it
 * created, which is how a moved question arrives in its new forum, so fall back to the
 * asker recorded on the archive row — otherwise moving a question would strip the
 * person who asked it of the right to resolve it.
 */
export async function isThreadAsker(thread: ThreadChannel, userId: string): Promise<boolean> {
  if (await isThreadOp(thread, userId)) return true;
  try {
    const row = await getThreadByDiscordId(getDb(), thread.guildId, thread.id);
    return row?.opUserId === userId;
  } catch {
    return false;
  }
}
