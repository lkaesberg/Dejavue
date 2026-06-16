import '@dejavue/core/env-preload';
import { logger, requireEnv } from '@dejavue/core';
import { createClient } from './client';
import { registerEvents } from './events';

const log = logger();

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const client = createClient();
  registerEvents(client);
  await client.login(token);
}

main().catch((err) => {
  log.error({ err }, 'bot failed to start');
  process.exit(1);
});
