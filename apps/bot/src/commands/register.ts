import '@dejavue/core/env-preload';
import { REST } from 'discord.js';
import { logger, requireEnv } from '@dejavue/core';
import { registerCommands } from './registry';

const log = logger();

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const appId = requireEnv('DISCORD_CLIENT_ID');
  const rest = new REST().setToken(token);
  const { count, scope } = await registerCommands(rest, appId);
  log.info({ count, scope }, 'registered application commands');
}

main().catch((err) => {
  log.error({ err }, 'command registration failed');
  process.exit(1);
});
