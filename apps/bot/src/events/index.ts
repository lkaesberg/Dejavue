import { type Client, Events } from 'discord.js';
import { logger } from '@dejavue/core';
import { reconcileAllEntitlements } from '../lib/reconcile';
import { onEntitlementCreate, onEntitlementDelete, onEntitlementUpdate } from './entitlements';
import { onInteraction } from './interactionCreate';
import { onMessageCreate } from './messageCreate';
import { onThreadCreate } from './threadCreate';

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

export function registerEvents(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    logger().info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'Dejavue ready');
    // Heal any entitlement drift on startup, then hourly.
    void reconcileAllEntitlements(c);
    setInterval(() => void reconcileAllEntitlements(c), RECONCILE_INTERVAL_MS).unref();
  });

  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    void onThreadCreate(thread, newlyCreated);
  });
  client.on(Events.MessageCreate, (message) => {
    void onMessageCreate(message);
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
