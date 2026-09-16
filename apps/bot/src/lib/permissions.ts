import { PermissionFlagsBits, type PermissionsBitField, type ThreadChannel } from 'discord.js';
import { getDb, getThreadByDiscordId } from '@dejavue/db';

// The permissions that let someone resolve a post they didn't open — any one of
// them counts. (Administrator implies the rest, so admins always pass.)
//
// Each carries the name Discord itself shows in Server Settings → Roles: a
// refusal that says "you must be a moderator" names a role that may not exist,
// leaving the member with nothing to ask their admin for.
const MOD_PERMS: readonly [bigint, string][] = [
  [PermissionFlagsBits.ManageThreads, 'Manage Threads'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  [PermissionFlagsBits.ManageGuild, 'Manage Server'],
  [PermissionFlagsBits.Administrator, 'Administrator'],
];

/** "Manage Threads, Timeout Members, Manage Server or Administrator" — bolded. */
const MOD_PERM_LIST = ((names: string[]) =>
  `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`)(
  MOD_PERMS.map(([, label]) => `**${label}**`),
);

/** Only the thread creator, or someone holding one of MOD_PERMS, may resolve a thread. */
export function canResolveThread(
  perms: Readonly<PermissionsBitField> | null,
  isOriginalPoster: boolean,
): boolean {
  if (isOriginalPoster) return true;
  if (!perms) return false;
  return MOD_PERMS.some(([bit]) => perms.has(bit));
}

/** The one-line "who may resolve a post", for help text. */
export const RESOLVE_PERMISSION_HINT =
  `The person who asked can always resolve their own post; anyone else needs the ${MOD_PERM_LIST} permission.`;

export const NO_PERMISSION_MESSAGE =
  `Only the person who asked can mark this post solved — or anyone with the ${MOD_PERM_LIST} permission. Dejavue uses no roles of its own.`;

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
