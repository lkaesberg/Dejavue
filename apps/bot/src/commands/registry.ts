import { type REST, Routes } from 'discord.js';
import { getEnv } from '@dejavue/core';
import { dejavueCommand } from './dejavue';
import { markAnswerCommand } from './markAnswer';
import type { MessageContextCommand, SlashCommand } from './types';

export const slashCommands: SlashCommand[] = [dejavueCommand];
export const contextCommands: MessageContextCommand[] = [markAnswerCommand];

export const slashByName = new Map(slashCommands.map((c) => [c.data.name, c]));
export const contextByName = new Map(contextCommands.map((c) => [c.data.name, c]));

/** All command payloads for REST registration. */
export function allCommandJSON() {
  return [
    ...slashCommands.map((c) => c.data.toJSON()),
    ...contextCommands.map((c) => c.data.toJSON()),
  ];
}

/**
 * Overwrite (PUT) all application commands. Guild-scoped when DISCORD_DEV_GUILD_ID
 * is set (instant, for dev), otherwise global. This is a full idempotent overwrite,
 * so it's safe to call on every bot startup as well as from the `register` CLI.
 */
export async function registerCommands(
  rest: REST,
  appId: string,
): Promise<{ count: number; scope: string }> {
  const devGuild = getEnv().DISCORD_DEV_GUILD_ID;
  const scope = devGuild ? `guild ${devGuild}` : 'global';
  const body = allCommandJSON();
  const route = devGuild
    ? Routes.applicationGuildCommands(appId, devGuild)
    : Routes.applicationCommands(appId);
  try {
    await rest.put(route, { body });
  } catch (err) {
    // Surface the scope: "Missing Access" on a guild scope means the bot wasn't
    // invited to that guild with the applications.commands OAuth scope. For a
    // multi-guild (production) bot, leave DISCORD_DEV_GUILD_ID unset → global.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`command registration failed (scope: ${scope}): ${msg}`, { cause: err });
  }
  return { count: body.length, scope };
}
