/**
 * Tier-aware monitored-channel resolution — the single home for two rules that
 * were previously duplicated across the bot's event guards:
 *
 * 1. **Empty config = all forums.** A guild that has not run `/dejavue setup`
 *    yet has no configured channels; the bot monitors every forum so it works
 *    out of the box. As soon as any channel is configured, only those count.
 * 2. **Downgrade cap.** Entitlements are never mutated on downgrade (that
 *    would destroy the admin's selection on re-upgrade); instead only the
 *    first `maxForumChannels` configured entries stay active, enforced here
 *    at point of use.
 */

export interface MonitoredChannelConfig {
  forumChannelIds: readonly string[];
}

/** The configured channels that are active under the tier's cap (first-N). */
export function activeForumChannels(
  ids: readonly string[],
  maxForumChannels: number,
): readonly string[] {
  if (!Number.isFinite(maxForumChannels)) return ids;
  return ids.slice(0, Math.max(0, maxForumChannels));
}

/** Is this forum currently monitored, given the guild's config and tier cap? */
export function isMonitoredForum(
  cfg: MonitoredChannelConfig | null | undefined,
  forumId: string,
  maxForumChannels: number,
): boolean {
  const ids = cfg?.forumChannelIds ?? [];
  if (ids.length === 0) return true; // pre-setup default: monitor everything
  return activeForumChannels(ids, maxForumChannels).includes(forumId);
}
