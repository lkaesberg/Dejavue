import { childLogger, getEnv, tierLimits } from '@dejavue/core';
import {
  getDb,
  getGuildConfig,
  getStaleUnansweredThreads,
  listGuildsWithNudges,
  markThreadNudged,
  nudgeableChannelIds,
  resolveGuildTier,
} from '@dejavue/db';
import type { NudgeStaleJob } from '@dejavue/queue';
import { isPermanentDiscordError, postMessage } from '../lib/discordRest';

const log = childLogger({ mod: 'job:nudge-stale' });

/** Ping helpers about stale unanswered posts. Scheduled hourly sweep. */
export async function handleNudgeStale(job: NudgeStaleJob): Promise<void> {
  const db = getDb();
  const env = getEnv();
  const guildIds = job.guildId
    ? [job.guildId]
    : (await listGuildsWithNudges(db)).map((g) => g.guildId);

  for (const guildId of guildIds) {
    const cfg = await getGuildConfig(db, guildId);
    if (!cfg?.nudgeEnabled) continue;
    const tier =
      env.DEV_FORCE_TIER ??
      (await resolveGuildTier(db, guildId, {
        plus: env.SKU_PLUS,
        pro: env.SKU_PRO,
        max: env.SKU_MAX,
      }));
    // One source of truth for the gate: the tier matrix (every tier has nudges today,
    // which is what the settings page offers).
    if (!tierLimits(tier).nudges) continue;

    const stale = await getStaleUnansweredThreads(
      db,
      guildId,
      nudgeableChannelIds(cfg),
      cfg.nudgeAfterHours,
    );
    for (const t of stale) {
      try {
        const mention = cfg.nudgeHelperRoleId ? `<@&${cfg.nudgeHelperRoleId}> ` : '';
        const title = t.title?.trim() ? `**"${t.title.trim().slice(0, 150)}"** ` : 'This question ';
        await postMessage(
          t.threadId,
          `${mention}⏳ ${title}has been waiting ${cfg.nudgeAfterHours}h without a solution — anyone able to help?`,
          // Only the configured helper role may be pinged; the title is member-written.
          cfg.nudgeHelperRoleId ? [cfg.nudgeHelperRoleId] : [],
        );
        await markThreadNudged(db, t.threadRowId);
      } catch (err) {
        // A permanent refusal (thread deleted, no access) settles the nudge; a transient
        // one leaves it eligible for the next sweep.
        const permanent = isPermanentDiscordError(err);
        log.warn({ err, threadId: t.threadId, permanent }, 'nudge failed');
        if (permanent) await markThreadNudged(db, t.threadRowId).catch(() => undefined);
      }
    }
    if (stale.length) log.info({ guildId, nudged: stale.length }, 'sent nudges');
  }
}
