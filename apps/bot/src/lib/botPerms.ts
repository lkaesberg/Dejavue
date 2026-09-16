import { type Guild, type GuildBasedChannel, PermissionFlagsBits } from 'discord.js';

// The permissions Dejavue actually needs to operate in a channel, with the exact
// names Discord shows in Server Settings → Roles. Surfaced to admins at setup and
// on the dashboard so a misconfigured invite doesn't leave a silently dead bot
// (it posts prompts, tags solved posts, and archives threads).
//
// Every user-facing "I can't do that" must name the permission from this table —
// "I need permission to do X" tells an admin nothing they can act on.
const FORUM_PERMS: readonly [bigint, string][] = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.ManageThreads, 'Manage Threads'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
];

const TEXT_PERMS: readonly [bigint, string][] = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];

/** Friendly names of the permissions Dejavue is missing in this channel (empty = all good). */
export function missingBotPermissions(channel: GuildBasedChannel, kind: 'forum' | 'text'): string[] {
  const me = channel.guild.members.me;
  if (!me) return [];
  const perms = channel.permissionsFor(me);
  if (!perms) return [];
  const required = kind === 'forum' ? FORUM_PERMS : TEXT_PERMS;
  return required.filter(([bit]) => !perms.has(bit)).map(([, label]) => label);
}

/** A ready-to-append warning line, or '' when nothing is missing. */
export function botPermissionWarning(channel: GuildBasedChannel, kind: 'forum' | 'text'): string {
  const missing = missingBotPermissions(channel, kind);
  if (missing.length === 0) return '';
  return `\n⚠️ I'm missing **${missing.join(', ')}** in <#${channel.id}> — grant them or I can't post prompts, tag solved posts, and archive threads here.`;
}

/** Does Dejavue hold this server-wide permission? Named so callers can quote it. */
export function hasGuildPermission(guild: Guild, permission: bigint): boolean {
  return guild.members.me?.permissions.has(permission) ?? false;
}

/**
 * The dashboard's permission audit: one line per watched channel that is missing
 * something, naming each permission exactly as Discord does.
 *
 * The dashboard is what every "something went wrong" message points at, so this
 * has to be a real, readable list — not a vague nudge to "check my permissions".
 */
export function permissionReport(
  guild: Guild,
  forumChannelIds: readonly string[],
  trackedChannelIds: readonly string[],
): string {
  const lines: string[] = [];
  const check = (ids: readonly string[], kind: 'forum' | 'text'): void => {
    for (const id of ids) {
      const channel = guild.channels.cache.get(id);
      if (!channel) continue;
      const missing = missingBotPermissions(channel, kind);
      if (missing.length > 0) lines.push(`⚠️ <#${id}> — missing **${missing.join(', ')}**`);
    }
  };
  check(forumChannelIds, 'forum');
  check(trackedChannelIds, 'text');
  if (lines.length === 0) {
    return forumChannelIds.length + trackedChannelIds.length === 0
      ? '_Nothing watched yet — add one with_ `/dejavue setup #channel`_. In a forum I need_ **View Channel, Send Messages in Threads, Embed Links, Read Message History, Manage Threads** _and_ **Manage Channels**.'
      : '✅ I have everything I need in every watched channel.';
  }
  lines.push('_Grant these in Server Settings → Roles → Dejavue, or on the channel itself._');
  return lines.join('\n');
}
