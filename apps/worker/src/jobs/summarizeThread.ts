import { summarizeThread } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import { checkQuota, commitGeneration, getDb, setCanonicalSummary } from '@dejavue/db';
import type { SummarizeThreadJob } from '@dejavue/queue';

const log = childLogger({ mod: 'job:summarize-thread' });

/** Summarize a solved thread into a canonical KB answer (Pro, quota-metered). */
export async function handleSummarizeThread(job: SummarizeThreadJob): Promise<void> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) {
    log.warn('OPENROUTER_API_KEY not set; skipping summary');
    return;
  }
  const db = getDb();
  const quota = await checkQuota(db, job.guildId, env.PRO_MONTHLY_QUOTA);
  if (!quota.allowed) {
    log.info({ guildId: job.guildId, used: quota.used, limit: quota.limit }, 'quota exhausted; skipping summary');
    return;
  }

  const result = await summarizeThread({ question: job.question, answer: job.answer });
  const summary = result.text.trim();
  if (!summary) return;

  await setCanonicalSummary(db, job.threadRowId, summary);
  await commitGeneration(db, {
    guildId: job.guildId,
    feature: 'summary',
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    threadId: job.threadRowId,
    usedBefore: quota.used,
    baseQuota: env.PRO_MONTHLY_QUOTA,
  });
  log.info({ threadRowId: job.threadRowId }, 'summarized thread');
}
