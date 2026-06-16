import { Client, GatewayIntentBits, Partials } from 'discord.js';

/**
 * Gateway client. We need:
 *  - Guilds        → thread create/update events on forum channels
 *  - GuildMessages  → the messageCreate fallback for the starter-message race (M2)
 *  - MessageContent → to read the starter message + accepted-answer text
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}
