import { capture } from '@dejavue/analytics';
import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type TextChannel,
  type User,
} from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import { COLOR } from '../lib/embeds';

const log = childLogger({ mod: 'event:guildCreate' });

/** Discord's "cannot send messages to this user" — closed DMs, not a fault. */
const DM_BLOCKED = 50007;

/**
 * All we need of the installer, and structural so it accepts the PartialUser an
 * audit-log executor can be.
 */
type Installer = Pick<User, 'id' | 'send'>;

/**
 * Welcome an admin when Dejavue joins a server.
 *
 * The setup walkthrough goes by DM to whoever actually installed the bot — a
 * public post in the system channel reaches everyone except, reliably, the one
 * person who needs it. The channel still gets a note, so the rest of the server
 * knows the bot is here and nobody is left without instructions when the DM
 * can't be delivered.
 *
 * Best-effort throughout: a server with no postable channel and an installer
 * with closed DMs must not throw.
 */
export async function onGuildCreate(guild: Guild): Promise<void> {
  capture('guild_joined', guild.id, { member_count: guild.memberCount });
  try {
    const installer = await inviterOf(guild);
    const dmSent = installer ? await sendSetupDm(guild, installer) : false;
    await postChannelNotice(guild, dmSent ? installer : null);
  } catch (err) {
    log.warn({ err, guildId: guild.id }, 'guildCreate welcome failed');
  }
}

/**
 * Who added the bot.
 *
 * `guildCreate` doesn't carry the inviter, so read it from the audit log — which
 * is a REST call, needing no extra gateway intent, but needing the View Audit
 * Log permission. Plenty of servers won't have granted it, so fall back to the
 * owner, who installed the bot themselves in most small servers anyway.
 */
async function inviterOf(guild: Guild): Promise<Installer | null> {
  const me = guild.client.user;
  if (me && guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    // The entry can lag the event by a moment; one retry is enough in practice.
    for (const delayMs of [0, 2_000]) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const executor = await guild
        .fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 })
        .then((logs) => logs.entries.find((e) => e.target?.id === me.id)?.executor)
        .catch(() => null);
      if (executor) return executor;
    }
  }
  return guild.fetchOwner().then((m) => m.user).catch(() => null);
}

/** The walkthrough. Returns false when the DM couldn't be delivered. */
async function sendSetupDm(guild: Guild, user: Installer): Promise<boolean> {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`👋 Thanks for adding Dejavue to ${guild.name}`)
    .setDescription(
      'I catch duplicate questions in your help channels and turn solved threads into a searchable knowledge base — inside Discord, and on a public website if you want one.',
    )
    .addFields(
      {
        name: '1️⃣ Add a channel',
        value:
          '`/dejavue setup #your-help-forum`\nFor forums I create the `solved` / `unsolved` tags and start importing past threads straight away. Text and announcement channels work too — they get indexed as searchable content.',
      },
      {
        name: '2️⃣ Watch it land',
        value:
          '`/dejavue dashboard`\nEverything I am watching, how far each import has got, and buttons through to the rest. This is the screen to come back to.',
      },
      {
        name: '3️⃣ Tune what I do on my own',
        value:
          '`/dejavue settings`\nDuplicate sensitivity, stale-question nudges and the off-topic guard — one page each, every setting explaining what it does and what your members will see.',
      },
      {
        name: '4️⃣ Publish it (optional)',
        value: '`/dejavue website`\nTurn the archive into a public, searchable site with its own address.',
      },
      {
        name: '💡 Just exploring?',
        value:
          'Run `/dejavue dashboard` and hit **Create demo** — I build an example forum you can delete when you are done.',
      },
      {
        name: '🔑 Permissions I need',
        value:
          "In your help channels: *View Channel, Send Messages in Threads, Embed Links, Read Message History, Manage Threads* and *Manage Channels*. Manage Channels is what lets me create and swap the `solved` / `unsolved` tags. `/dejavue setup` tells you if any are missing.",
      },
    )
    .setFooter({ text: 'Powered by Dejavue' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Docs & website').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(getEnv().KB_PUBLIC_URL),
  );

  try {
    // Link buttons only: a DM interaction carries no guild, so none of the hub
    // components could do anything here.
    await user.send({ embeds: [embed], components: [row] });
    return true;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === DM_BLOCKED) {
      log.info({ guildId: guild.id }, 'installer has DMs closed; falling back to a channel post');
    } else {
      log.warn({ err, guildId: guild.id }, 'setup DM failed');
    }
    return false;
  }
}

/**
 * The public note. Short when the installer already has the walkthrough in their
 * DMs, the full thing when they don't — so nobody ends up with no instructions.
 */
async function postChannelNotice(guild: Guild, dmedTo: Installer | null): Promise<void> {
  const channel = welcomeChannel(guild);
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(COLOR).setFooter({ text: 'Powered by Dejavue' });

  if (dmedTo) {
    embed
      .setTitle('👋 Dejavue is here')
      .setDescription(
        `I catch duplicate questions and turn solved threads into a searchable knowledge base.\n\nI've sent <@${dmedTo.id}> the setup steps — any admin can also run \`/dejavue help\`, or jump straight to \`/dejavue setup #your-help-forum\`.`,
      );
  } else {
    embed.setTitle('👋 Thanks for adding Dejavue!').setDescription(
      [
        'I catch duplicate questions in your help forums and turn solved threads into a searchable knowledge base.',
        '',
        '**Get started** → `/dejavue setup #your-help-forum` to add a channel.',
        '**See what I am watching** → `/dejavue dashboard`.',
        '**Just exploring?** Run `/dejavue dashboard` and hit **Create demo** for an example forum to play with.',
        '**Everything else** → `/dejavue help`.',
        '',
        "**Permissions I need** in your help channels so I can post prompts, tag solved posts, and archive threads: *View Channel, Send Messages in Threads, Embed Links, Read Message History, Manage Threads,* and *Manage Channels*. `/dejavue setup` tells you if any are missing.",
      ].join('\n'),
    );
  }
  await channel.send({ embeds: [embed] });
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
