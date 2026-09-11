import { capture } from '@dejavue/analytics';
import { generateFaq } from '@dejavue/ai';
import { childLogger, genProgressEmbed, getEnv } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getFaqEntries,
  getThreadsByRowIds,
  getTopClusters,
  markGenerationFinished,
  upsertGeneratedFaq,
} from '@dejavue/db';
import type { RegenFaqJob } from '@dejavue/queue';
import { LiveProgress } from '../lib/progress';
import { guildCreditBudget } from '../lib/quota';

const log = childLogger({ mod: 'job:regen-faq' });
const MAX_FAQ = 10;

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Render the current FAQ into the live message (final state). */
async function renderFaq(guildId: string, live: LiveProgress, note?: string): Promise<void> {
  const faqs = await getFaqEntries(getDb(), guildId);
  const body = faqs
    .slice(0, 8)
    .map((f) => `**${truncate(f.question, 120)}**\n${truncate(f.answer, 280)}`)
    .join('\n\n');
  await live.finalize(genProgressEmbed({ kind: 'faq', phase: 'done', body, note }));
}

/** Generate / maintain the auto-FAQ from the top clusters (Pro, quota-metered). */
export async function handleRegenFaq(job: RegenFaqJob): Promise<void> {
  const env = getEnv();
  const db = getDb();
  const live = job.progress ? new LiveProgress(job.progress) : null;
  live?.update(genProgressEmbed({ kind: 'faq', phase: 'working', note: 'drafting answers…' }));
  let stoppedOnQuota = false;
  try {
    if (!env.OPENROUTER_API_KEY) {
      log.warn('OPENROUTER_API_KEY not set; skipping FAQ regen');
      await markGenerationFinished(db, job.guildId, 'faq');
      return;
    }
    const baseCredits = await guildCreditBudget(job.guildId);
    const clusters = await getTopClusters(db, job.guildId, MAX_FAQ);

    for (const cluster of clusters) {
      if (!cluster.medoidThreadId) continue;
      const quota = await checkQuota(db, job.guildId, baseCredits);
      if (!quota.allowed) {
        log.info({ guildId: job.guildId }, 'AI credits exhausted; stopping FAQ regen');
        stoppedOnQuota = true;
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
        usedTokensBefore: quota.usedTokens,
        baseCredits,
      });
      capture('generation', job.guildId, {
        feature: 'faq',
        model_id: res.model,
        prompt_tokens: res.promptTokens,
        completion_tokens: res.completionTokens,
        success: true,
      });
    }
    await markGenerationFinished(db, job.guildId, 'faq');
    log.info({ guildId: job.guildId, clusters: clusters.length }, 'regenerated FAQ');
  } finally {
    if (live) {
      const note = stoppedOnQuota
        ? 'Stopped early — monthly AI credits used up. Top up or wait for the reset on the 1st (UTC).'
        : undefined;
      await renderFaq(job.guildId, live, note).catch(() => undefined);
    }
  }
}
