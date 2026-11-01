import { capture } from '@dejavue/analytics';
import {
  AuditLogEvent,
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  PermissionFlagsBits,
  type TextChannel,
  type User,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, markGuildsPresent } from '@dejavue/db';
import { arrivalNotice, setupGuide } from '../lib/welcome';

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
  // Re-added within the grace period: cancel the pending purge and bring the KB back.
  await markGuildsPresent(getDb(), [guild.id]).catch((err) =>
    log.warn({ err, guildId: guild.id }, 'failed to restore removed server'),
  );
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
  try {
    await user.send(setupGuide(guild.name));
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
 * DMs, the full guide when they don't — so nobody ends up with no instructions.
 */
async function postChannelNotice(guild: Guild, dmedTo: Installer | null): Promise<void> {
  const channel = welcomeChannel(guild);
  if (!channel) return;
  await channel.send(dmedTo ? arrivalNotice(dmedTo.id) : setupGuide(guild.name, { inChannel: true }));
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
