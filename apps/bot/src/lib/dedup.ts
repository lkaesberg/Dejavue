import type { ThreadChannel } from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  getThreadsByRowIds,
  keywordSearch,
  type SearchMatch,
  semanticSearch,
} from '@dejavue/db';
import { duplicatesMessage } from './embeds';
import { forumParent, getStarterText } from './forum';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'dedup' });

const DEBOUNCE_MS = 4000;
const STARTER_RETRY_MS = 1500;
// bge-small cosine for genuine paraphrases sits ~0.65–0.85, so keep the bar
// modest enough to catch reworded duplicates without flagging unrelated posts.
const SEMANTIC_MIN_SIMILARITY = 0.72;

/** Threads we've already scheduled, so threadCreate + messageCreate collapse to one run. */
const scheduled = new Set<string>();

/** Debounced, idempotent-by-thread-id duplicate detection. */
export function scheduleDedup(thread: ThreadChannel): void {
  if (scheduled.has(thread.id)) return;
  scheduled.add(thread.id);
  const timer = setTimeout(() => {
    void runDedup(thread)
      .catch((err) => log.warn({ err, threadId: thread.id }, 'dedup run failed'))
      .finally(() => scheduled.delete(thread.id));
  }, DEBOUNCE_MS);
  timer.unref();
}

/** The starter message may arrive after threadCreate — retry a few times. */
async function fetchStarterWithRetry(thread: ThreadChannel, attempts = 3): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const starter = await getStarterText(thread);
    if (starter && starter.content.trim()) return starter.content;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, STARTER_RETRY_MS));
  }
  return '';
}

/** Pro: draft an answer from matched solved threads, metered against the quota. */
async function maybeDraft(
  guildId: string,
  question: string,
  matches: SearchMatch[],
): Promise<string | undefined> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) return undefined;
  const db = getDb();
  try {
    const quota = await checkQuota(db, guildId, env.PRO_MONTHLY_QUOTA);
    if (!quota.allowed) return undefined;

    const rows = await getThreadsByRowIds(db, matches.map((m) => m.rowId));
    const sources = rows
      .filter((r) => r.acceptedAnswerText)
      .map((r) => ({ title: r.title, answer: r.acceptedAnswerText as string }));
    if (sources.length === 0) return undefined;

    const { draftAnswer } = await import('@dejavue/ai');
    const result = await draftAnswer({ question, sources });
    await commitGeneration(db, {
      guildId,
      feature: 'draft',
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      usedBefore: quota.used,
      baseQuota: env.PRO_MONTHLY_QUOTA,
    });
    return result.text.trim() || undefined;
  } catch (err) {
    log.warn({ err, guildId }, 'draft generation failed');
    return undefined;
  }
}

async function runDedup(thread: ThreadChannel): Promise<void> {
  const db = getDb();
  const guildId = thread.guildId;
  const forum = forumParent(thread);
  const cfg = await getGuildConfig(db, guildId);
  if (forum && cfg && cfg.forumChannelIds.length > 0 && !cfg.forumChannelIds.includes(forum.id)) {
    return;
  }

  // Don't suggest duplicates on a post that's already solved (also keeps the
  // /demo seed posts quiet, since they're persisted solved before this fires).
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing?.status === 'solved') return;

  const body = await fetchStarterWithRetry(thread);
  const query = [thread.name, body].join('\n').trim();
  if (!query) return;

  const limits = limitsFor(await getGuildTier(guildId));

  let matches: SearchMatch[];
  if (limits.semanticSearch) {
    const { embedOne } = await import('@dejavue/ai');
    const vector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    matches = await semanticSearch(db, {
      guildId,
      queryVector: vector,
      limit: 3,
      minSimilarity: SEMANTIC_MIN_SIMILARITY,
      excludeThreadId: thread.id,
    });
  } else {
    matches = await keywordSearch(db, { guildId, query, limit: 3, excludeThreadId: thread.id });
  }

  if (matches.length === 0) return;

  const draft = limits.generative ? await maybeDraft(guildId, query, matches) : undefined;
  try {
    await thread.send(duplicatesMessage(guildId, matches, !limits.removeBranding, draft));
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to post duplicate suggestion');
  }
}
