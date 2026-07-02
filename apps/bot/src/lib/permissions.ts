import { PermissionFlagsBits, type PermissionsBitField, type ThreadChannel } from 'discord.js';

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
