import { buildSummaryContext, summarizeThread } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getThreadByRowId,
  setCanonicalSummary,
} from '@dejavue/db';
import type { SummarizeThreadJob } from '@dejavue/queue';
import { guildCreditBudget } from '../lib/quota';

const log = childLogger({ mod: 'job:summarize-thread' });

/** Summarize a solved thread into a canonical KB answer (Pro, credit-metered). */
export async function handleSummarizeThread(job: SummarizeThreadJob): Promise<void> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) {
    log.warn('OPENROUTER_API_KEY not set; skipping summary');
    return;
  }
  const db = getDb();
  const baseCredits = await guildCreditBudget(job.guildId);
  const quota = await checkQuota(db, job.guildId, baseCredits);
  if (!quota.allowed) {
    log.info(
      { guildId: job.guildId, usedCredits: quota.usedCredits, limitCredits: quota.limitCredits },
      'AI credits exhausted; skipping summary',
    );
    return;
  }

  // Prefer the live row (it has the full transcript, so we can give the model the
  // whole thread — or start + answer-window context when long); fall back to the payload.
  const row = await getThreadByRowId(db, job.threadRowId);
  const context = buildSummaryContext(
    row
      ? {
          title: row.title,
          questionBody: row.questionBody,
          acceptedAnswerText: row.acceptedAnswerText,
          transcript: row.transcript,
        }
      : { title: job.question, acceptedAnswerText: job.answer },
  );
  if (!context.trim()) return;

  const result = await summarizeThread({ context });
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
    usedTokensBefore: quota.usedTokens,
    baseCredits,
  });
  log.info({ threadRowId: job.threadRowId }, 'summarized thread');
}
