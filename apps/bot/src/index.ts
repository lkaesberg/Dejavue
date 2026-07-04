import '@dejavue/core/env-preload';
import { installCrashHandlers, logger, notify, requireEnv } from '@dejavue/core';
import { createClient } from './client';
import { registerEvents } from './events';

const log = logger();
installCrashHandlers('bot');

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const client = createClient();
  registerEvents(client);
  await client.login(token);
}

main().catch((err) => {
  log.error({ err }, 'bot failed to start');
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // Await the alert so it flushes before we exit.
  void notify({ level: 'error', title: '🔴 Bot failed to start', description: detail.slice(0, 4000) }).finally(
    () => process.exit(1),
  );
});
