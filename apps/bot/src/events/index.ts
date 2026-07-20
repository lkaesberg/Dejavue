import { type Client, Events } from 'discord.js';
import { logger, notifyAsync } from '@dejavue/core';
import { registerCommands } from '../commands/registry';
import { channelFitReconcile } from '../lib/channelFit';
import { kbStartupReconcile } from '../lib/kbReconcile';
import { reconcileAllEntitlements } from '../lib/reconcile';
import { reconcileDeletions } from '../lib/threadReconcile';
import { onChannelDelete } from './channelDelete';
import { onChannelUpdate } from './channelUpdate';
import { onEntitlementCreate, onEntitlementDelete, onEntitlementUpdate } from './entitlements';
import { onGuildCreate } from './guildCreate';
import { onInteraction } from './interactionCreate';
import { onMessageCreate } from './messageCreate';
import { onMessageDelete, onMessageDeleteBulk, onMessageUpdate } from './messageMutations';
import { onThreadCreate } from './threadCreate';
import { onThreadDelete } from './threadDelete';
import { onThreadUpdate } from './threadUpdate';

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const DELETION_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function registerEvents(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    const shards = c.ws.shards.size;
    logger().info({ user: c.user.tag, guilds: c.guilds.cache.size, shards }, 'Dejavue ready');
    notifyAsync({
      level: 'success',
      title: '✅ Bot online',
      fields: [
        { name: 'User', value: c.user.tag },
        { name: 'Guilds', value: String(c.guilds.cache.size) },
        { name: 'Shards', value: String(shards) },
      ],
    });

    // Re-register application commands on every startup so a deploy / reboot /
    // restart always syncs Discord with the code. Idempotent overwrite (uses the
    // dev guild if DISCORD_DEV_GUILD_ID is set, else global); non-fatal on failure.
    const appId = c.application?.id;
    if (appId) {
      void registerCommands(c.rest, appId)
        .then(({ count, scope }) => logger().info({ count, scope }, 'registered application commands'))
        .catch((err) => {
          logger().error({ err }, 'startup command registration failed');
          notifyAsync({
            level: 'error',
            title: '🔴 Command registration failed',
            description: String(err instanceof Error ? err.message : err).slice(0, 500),
          });
        });
    } else {
      logger().warn('no application id on ready; skipping command registration');
    }

    // Heal any entitlement drift on startup, then hourly.
    void reconcileAllEntitlements(c);
    setInterval(() => void reconcileAllEntitlements(c), RECONCILE_INTERVAL_MS).unref();
    // Heal deletions that happened while we were offline, THEN fill the KB — so we
    // don't re-publish/re-embed ghosts. Periodic sweep backstops missed events.
    void reconcileDeletions(c).then(() => kbStartupReconcile(c));
    setInterval(() => void reconcileDeletions(c), DELETION_RECONCILE_INTERVAL_MS).unref();
    // Heal channel-fit topics: rebuild any missing for the active model (and drop
    // rows from a previous model) so a model switch / failed build self-corrects.
    void channelFitReconcile(c);
    setInterval(() => void channelFitReconcile(c), RECONCILE_INTERVAL_MS).unref();
  });

  client.on(Events.GuildCreate, (guild) => {
    void onGuildCreate(guild);
  });
  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    void onThreadCreate(thread, newlyCreated);
  });
  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    void onThreadUpdate(oldThread, newThread);
  });
  client.on(Events.ThreadDelete, (thread) => {
    void onThreadDelete(thread);
  });
  client.on(Events.ChannelDelete, (channel) => {
    void onChannelDelete(channel);
  });
  client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
    void onChannelUpdate(oldChannel, newChannel);
  });
  client.on(Events.MessageCreate, (message) => {
    void onMessageCreate(message);
  });
  client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
    void onMessageUpdate(oldMessage, newMessage);
  });
  client.on(Events.MessageDelete, (message) => {
    void onMessageDelete(message);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    void onMessageDeleteBulk(messages, channel);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void onInteraction(interaction);
  });

  client.on(Events.EntitlementCreate, (ent) => {
    if (ent) void onEntitlementCreate(ent);
  });
  client.on(Events.EntitlementUpdate, (ent) => {
    if (ent) void onEntitlementUpdate(ent);
  });
  client.on(Events.EntitlementDelete, (ent) => {
    if (ent) void onEntitlementDelete(ent);
  });
}
