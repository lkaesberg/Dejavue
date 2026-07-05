import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Gateway client. We need:
 *  - Guilds        → thread create/update events on forum channels
 *  - GuildMessages  → the messageCreate fallback for the starter-message race (M2)
 *  - MessageContent → to read the starter message + accepted-answer text
 */
export function createClient(): Client {
  return new Client({
    // Internal sharding: keep a single process, but let Discord decide how many
    // gateway shards to open ('auto' fetches the recommended count at login — 1
    // today, scaling up automatically to satisfy Discord's mandatory-sharding
    // threshold at 2,500 guilds). All shards share this process's cache and fire
    // one ClientReady, so the startup reconciles in events/index.ts still see
    // every guild — no per-shard gating needed.
    shards: 'auto',
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}
