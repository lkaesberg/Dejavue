import { childLogger, getEnv } from '@dejavue/core';
import {
  getDb,
  getGuildConfig,
  getStaleUnansweredThreads,
  listGuildsWithNudges,
  markThreadNudged,
  resolveGuildTier,
} from '@dejavue/db';
import type { NudgeStaleJob } from '@dejavue/queue';
import { postMessage } from '../lib/discordRest';

const log = childLogger({ mod: 'job:nudge-stale' });

/** Ping helpers about stale unanswered posts (Plus+). Scheduled hourly sweep. */
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
      (await resolveGuildTier(db, guildId, { plus: env.SKU_PLUS, pro: env.SKU_PRO }));
    if (tier === 'free') continue; // nudges are a Plus+ feature

    const stale = await getStaleUnansweredThreads(db, guildId, cfg.nudgeAfterHours);
    for (const t of stale) {
      try {
        const mention = cfg.nudgeHelperRoleId ? `<@&${cfg.nudgeHelperRoleId}> ` : '';
        const title = t.title?.trim() ? `**"${t.title.trim().slice(0, 150)}"** ` : 'This question ';
        await postMessage(
          t.threadId,
          `${mention}⏳ ${title}has been waiting ${cfg.nudgeAfterHours}h without a solution — anyone able to help?`,
        );
        await markThreadNudged(db, t.threadRowId);
      } catch (err) {
        log.warn({ err, threadId: t.threadId }, 'nudge failed');
      }
    }
    if (stale.length) log.info({ guildId, nudged: stale.length }, 'sent nudges');
  }
}
