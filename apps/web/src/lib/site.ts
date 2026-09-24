import { getEnv } from '@dejavue/core';

// Dejavue is AGPL-3.0. The privacy argument on the marketing site ("we don't track you",
// "authors stay aliased") is only worth as much as it is checkable, so the source is
// linked prominently rather than buried in the footer.
export const REPO_URL = 'https://github.com/lkaesberg/Dejavue';

/** Invite to Dejavue's own support server (the platform's, not a tenant's). */
export const SUPPORT_URL = 'https://discord.gg/aGC2RGwbHj';

const INSTALL_PERMS = [
  1024n, // View Channels
  16n, // Manage Channels
  2048n, // Send Messages
  16384n, // Embed Links
  65536n, // Read Message History
  17179869184n, // Manage Threads
  274877906944n, // Send Messages in Threads
]
  .reduce((sum, bit) => sum + bit)
  .toString();

/** The bot's Add-to-Discord install link, or null when no client id is configured. */
export function addToDiscordUrl(): string | null {
  const clientId = getEnv().DISCORD_CLIENT_ID;
  return clientId
    ? `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${INSTALL_PERMS}`
    : null;
}
