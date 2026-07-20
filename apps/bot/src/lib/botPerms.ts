import { type GuildBasedChannel, PermissionFlagsBits } from 'discord.js';

// The permissions Dejavue actually needs to operate in a channel, with friendly
// labels. Surfaced to admins at setup so a misconfigured invite doesn't leave a
// silently dead bot (it posts prompts, tags solved posts, and archives threads).
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
