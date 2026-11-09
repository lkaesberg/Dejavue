import { capture } from '@dejavue/analytics';
import { buildSummaryContext, summarizeThread } from '@dejavue/ai';
import { childLogger, getEnv } from '@dejavue/core';
import {
  checkQuota,
  claimCanonicalSummary,
  commitGeneration,
  getDb,
  getThreadByRowId,
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

  // Stored only if the thread is still in the solve we summarized (a reopen or
  // re-solve meanwhile clears the summary and moves solvedAt) and no summary landed
  // first. The tokens were spent either way, so the generation is still metered.
  const stored = row
    ? await claimCanonicalSummary(db, job.threadRowId, summary, row.solvedAt ?? null)
    : false;
  if (!stored) log.info({ threadRowId: job.threadRowId }, 'summary discarded — thread changed meanwhile');
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
  capture('generation', job.guildId, {
    feature: 'summary',
    model_id: result.model,
    prompt_tokens: result.promptTokens,
    completion_tokens: result.completionTokens,
    success: true,
  });
  log.info({ threadRowId: job.threadRowId }, 'summarized thread');
}
