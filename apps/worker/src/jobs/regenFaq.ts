import { generateFaq } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getThreadsByRowIds,
  getTopClusters,
  upsertGeneratedFaq,
} from '@dejavue/db';
import type { RegenFaqJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:regen-faq' });
const MAX_FAQ = 10;

/** Generate / maintain the auto-FAQ from the top clusters (Pro, quota-metered). */
export async function handleRegenFaq(job: RegenFaqJob): Promise<void> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) {
    log.warn('OPENROUTER_API_KEY not set; skipping FAQ regen');
    return;
  }
  const db = getDb();
  const clusters = await getTopClusters(db, job.guildId, MAX_FAQ);

  for (const cluster of clusters) {
    if (!cluster.medoidThreadId) continue;
    const quota = await checkQuota(db, job.guildId, env.PRO_MONTHLY_QUOTA);
    if (!quota.allowed) {
      log.info({ guildId: job.guildId }, 'quota exhausted; stopping FAQ regen');
      break;
    }
    const [medoid] = await getThreadsByRowIds(db, [cluster.medoidThreadId]);
    const question = cluster.representativeText ?? medoid?.title ?? cluster.label ?? '';
    if (!question) continue;
    const context = medoid?.acceptedAnswerText ?? '';

    const res = await generateFaq({ question, context });
    const answer = res.text.trim();
    if (!answer) continue;

    await upsertGeneratedFaq(db, {
      guildId: job.guildId,
      clusterId: cluster.id,
      question,
      answer,
      sourceThreadIds: cluster.memberThreadIds,
    });
    await commitGeneration(db, {
      guildId: job.guildId,
      feature: 'faq',
      model: res.model,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      usedBefore: quota.used,
      baseQuota: env.PRO_MONTHLY_QUOTA,
    });
  }
  log.info({ guildId: job.guildId, clusters: clusters.length }, 'regenerated FAQ');
}
