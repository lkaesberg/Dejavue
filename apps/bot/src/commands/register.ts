import '@dejavue/core/env-preload';
import { REST, Routes } from 'discord.js';
import { getEnv, logger, requireEnv } from '@dejavue/core';
import { allCommandJSON } from './registry';

const log = logger();

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const appId = requireEnv('DISCORD_CLIENT_ID');
  const devGuild = getEnv().DISCORD_DEV_GUILD_ID;
  const body = allCommandJSON();

  const rest = new REST().setToken(token);
  const route = devGuild
    ? Routes.applicationGuildCommands(appId, devGuild)
    : Routes.applicationCommands(appId);

  await rest.put(route, { body });
  log.info(
    { count: body.length, scope: devGuild ? `guild ${devGuild}` : 'global' },
    'registered application commands',
  );
}

main().catch((err) => {
  log.error({ err }, 'command registration failed');
  process.exit(1);
});
