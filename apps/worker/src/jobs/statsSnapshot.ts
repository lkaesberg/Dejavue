import { capture } from '@dejavue/analytics';
import { childLogger, deriveTier, getEnv, TIERS } from '@dejavue/core';
import { getDb, instanceStats } from '@dejavue/db';
import { fetchBotGuilds } from '../lib/discordRest';

const log = childLogger({ mod: 'job:stats-snapshot' });

/** Distinct id for instance-wide events, which belong to no single server. */
const INSTANCE_ID = 'instance';

/**
 * The servers the bot is in right now, and how many people are in them — asked of
 * Discord, because our own tables can't answer it: a guild_config row appears on a
 * server's first use and is kept after the bot leaves, so it misses every server that
 * installed the bot and never ran a command, and still counts the ones that removed it.
 *
 * `members` sums each server's count, so someone in two servers counts twice. Discord's
 * privileged-intent threshold counts unique users, which this approximates from above.
 *
 * Null when Discord can't be reached: the snapshot then omits these fields rather than
 * reporting a number that means something else.
 */
async function serverReach(): Promise<{ guilds: number; members: number } | null> {
  try {
    const guilds = await fetchBotGuilds();
    return {
      guilds: guilds.length,
      members: guilds.reduce((sum, g) => sum + (g.approximate_member_count ?? 0), 0),
    };
  } catch (err) {
    log.warn({ err }, 'listing servers from Discord failed; snapshot omits server counts');
    return null;
  }
}

/**
 * Daily instance-wide rollup.
 *
 * Every other event here is guild-scoped and describes something that happened; this one
 * describes the shape of the whole install at a point in time — how many servers, how
 * many people they hold, how much is indexed, what the last 30 days cost. It is what the
 * installed-vs-active, subscriptions-by-tier and embedding-spend tiles are drawn from, so
 * it must land once a day even on a quiet instance.
 */
export async function handleStatsSnapshot(): Promise<void> {
  const env = getEnv();
  const [stats, reach] = await Promise.all([instanceStats(getDb()), serverReach()]);

  // Fold per-SKU entitlement counts into tier counts using the same precedence
  // (max > pro > plus) that gates features, so the dashboard and the product agree.
  const skus = { plus: env.SKU_PLUS, pro: env.SKU_PRO, max: env.SKU_MAX };
  const byTier: Record<string, number> = { free: 0, plus: 0, pro: 0, max: 0 };
  let subscribed = 0;
  for (const [skuId, count] of Object.entries(stats.activeSkus)) {
    const tier = deriveTier([{ skuId, deleted: false, endsAt: null }], skus);
    if (tier === 'free') continue; // a one-time add-on SKU, not a subscription
    byTier[tier] = (byTier[tier] ?? 0) + count;
    subscribed += count;
  }
  byTier.free = reach ? Math.max(0, reach.guilds - subscribed) : 0;

  // MRR from list prices per tier. Kept here (not in the tier matrix) because price is
  // set in Discord's portal, not in code — treat this as an indicator, not billing truth.
  const PRICE: Record<string, number> = { plus: 4.99, pro: 9.99, max: 24.99 };
  const mrr = TIERS.reduce((sum, t) => sum + (byTier[t] ?? 0) * (PRICE[t] ?? 0), 0);

  capture('stats_snapshot', INSTANCE_ID, {
    guilds_installed: reach?.guilds,
    guilds_free: reach ? byTier.free : undefined,
    guilds_plus: byTier.plus,
    guilds_pro: byTier.pro,
    guilds_max: byTier.max,
    members_total: reach?.members,
    threads_indexed: stats.threadsIndexed,
    threads_solved: stats.threadsSolved,
    messages_indexed: stats.messagesIndexed,
    embedding_tokens_30d: stats.embeddingTokens30d,
    credits_used_30d: Math.ceil(stats.creditTokens30d / 1000),
    mrr: Math.round(mrr * 100) / 100,
  });
  log.info({ guilds: reach?.guilds, members: reach?.members, mrr }, 'stats snapshot emitted');
}
