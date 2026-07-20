import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import { COLOR } from '../lib/embeds';

const log = childLogger({ mod: 'event:guildCreate' });

/**
 * Post a one-time welcome when Dejavue joins a server, so an admin isn't left with a
 * silent, invisible bot. Best-effort: if there's no channel we can post in, we skip
 * (the admin can still run /dejavue setup) rather than fail loudly.
 */
export async function onGuildCreate(guild: Guild): Promise<void> {
  try {
    const channel = welcomeChannel(guild);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('👋 Thanks for adding Dejavue!')
      .setDescription(
        [
          'I catch duplicate questions in your help forums and turn solved threads into a searchable knowledge base.',
          '',
          '**Get started** → `/dejavue setup #your-forum` to add a channel, or `/dejavue setup` for the panel.',
          '**Just exploring?** Run `/dejavue setup` and hit **Create demo** for an example forum to play with.',
          '**See everything** → `/dejavue help`.',
          '',
          "**Permissions I need** in your help channels so I can post prompts, tag solved posts, and archive threads: *View Channel, Send Messages in Threads, Embed Links, Read Message History, Manage Threads,* and *Manage Channels*. `/dejavue setup` tells you if any are missing.",
        ].join('\n'),
      )
      .setFooter({ text: 'Powered by Dejavue' });
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log.warn({ err, guildId: guild.id }, 'guildCreate welcome failed');
  }
}

/** The system channel if we can post there, else the first text channel we can post in. */
function welcomeChannel(guild: Guild): TextChannel | null {
  const me = guild.members.me;
  if (!me) return null;
  const canSend = (ch: GuildBasedChannel): ch is TextChannel =>
    ch.type === ChannelType.GuildText &&
    (ch.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) ?? false) &&
    (ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ?? false);
  if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.find((ch): ch is TextChannel => canSend(ch)) ?? null;
}
