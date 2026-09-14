import { getGuildConfig, getDb } from '@dejavue/db';
import { getGuildTier, limitsFor } from './tier';

/**
 * Whether to stamp "Powered by Dejavue" on a message or page for this guild.
 *
 * Two independent things decide it, and until now only one of them was wired:
 * the plan (Free always carries the branding — it is the trade for everything
 * else Free gets) and the admin's own preference, which lived in
 * `guild_config.branding_enabled` and was read by nothing at all. The settings
 * hub now exposes that column, so it has to actually be consulted.
 */
export async function showBrandingFor(guildId: string): Promise<boolean> {
  const limits = limitsFor(await getGuildTier(guildId));
  if (!limits.removeBranding) return true;
  const cfg = await getGuildConfig(getDb(), guildId);
  // Default on: a guild that never touched the setting keeps the footer.
  return cfg?.brandingEnabled ?? true;
}
