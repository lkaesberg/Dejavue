import type { ThreadChannel } from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import {
  channelMode,
  checkQuota,
  commitGeneration,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  getThreadsByRowIds,
  type GuildConfig,
  keywordSearch,
  listChannelTopicChannelIds,
  type SearchMatch,
  semanticSearch,
  updateGuildConfig,
} from '@dejavue/db';
import { assessChannel, ensureChannelTopics } from './channelFit';
import { channelFitMessage, channelGuardMessage, duplicatesMessage } from './embeds';
import { applyTag, ensureWrongChannelTag, fetchStarterWithRetry, forumParent } from './forum';
import { closeThread } from './solve';
import { getGuildTier, limitsFor } from './tier';

const log = childLogger({ mod: 'dedup' });

const DEBOUNCE_MS = 4000;
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

/** Pro: draft an answer from matched solved threads, metered against the quota. */
async function maybeDraft(
  guildId: string,
  question: string,
  matches: SearchMatch[],
  baseQuota: number,
): Promise<string | undefined> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) return undefined;
  const db = getDb();
  try {
    const quota = await checkQuota(db, guildId, baseQuota);
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
      baseQuota,
    });
    return result.text.trim() || undefined;
  } catch (err) {
    log.warn({ err, guildId }, 'draft generation failed');
    return undefined;
  }
}

/**
 * Channel-fit advisory + off-topic guard. If another monitored question channel is a
 * clearly better home, suggest it (advisory). When the guard is on with auto-close and
 * the post is *confidently* in the wrong channel, tag it `wrong-channel` and close the
 * thread (returns true so the caller skips duplicate suggestions on a closed thread).
 * Self-heals per-channel: a missing topic for the active model is rebuilt in the
 * background; we only skip when *this* channel's topic isn't ready (nothing to compare).
 */
async function maybeGuardOrSuggest(
  thread: ThreadChannel,
  currentChannelId: string,
  queryVector: number[],
  cfg: GuildConfig,
  showBranding: boolean,
): Promise<boolean> {
  try {
    const db = getDb();
    const { embeddingModelId } = await import('@dejavue/ai');
    const present = new Set(
      await listChannelTopicChannelIds(db, thread.guildId, embeddingModelId(cfg.embeddingModel)),
    );
    const candidates = cfg.forumChannelIds.filter((id) => channelMode(cfg, id) !== 'knowledge');
    if (candidates.some((id) => !present.has(id))) {
      // Build the missing topics for next time (ensureChannelTopics is guarded).
      void ensureChannelTopics(thread.guild, cfg).catch(() => undefined);
    }
    if (!present.has(currentChannelId)) return false; // can't judge fit without this channel's topic

    const { suggestion, wrong } = await assessChannel(thread.guildId, currentChannelId, queryVector, cfg);

    // Guard auto-close: confidently the wrong channel → tag + close the thread.
    if (cfg.guardEnabled && cfg.guardAutoClose && wrong) {
      const forum = forumParent(thread);
      if (forum) {
        try {
          const tagId = cfg.wrongChannelTagId ?? (await ensureWrongChannelTag(forum));
          if (!cfg.wrongChannelTagId) {
            await updateGuildConfig(db, thread.guildId, { wrongChannelTagId: tagId }).catch(() => undefined);
          }
          await applyTag(thread, tagId).catch(() => undefined);
        } catch (err) {
          log.warn({ err, threadId: thread.id }, 'failed to apply wrong-channel tag');
        }
      }
      await thread.send(channelGuardMessage(wrong.channelId, showBranding)).catch(() => undefined);
      await closeThread(thread).catch(() => undefined);
      return true;
    }

    // Otherwise a soft suggestion (advisory fit-check, or guard without auto-close).
    if (suggestion) await thread.send(channelFitMessage(suggestion.channelId, showBranding));
    return false;
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'channel-fit/guard check failed');
    return false;
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
  // Knowledge channels are a pure archive — never post duplicate reminders.
  if (forum && channelMode(cfg, forum.id) === 'knowledge') return;

  // Don't suggest duplicates on a post that's already solved (also keeps the
  // /demo seed posts quiet, since they're persisted solved before this fires).
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing?.status === 'solved') return;

  const body = await fetchStarterWithRetry(thread);
  const query = [thread.name, body].join('\n').trim();
  if (!query) return;

  const limits = limitsFor(await getGuildTier(guildId));

  let matches: SearchMatch[];
  let queryVector: number[] | undefined;
  if (limits.semanticSearch) {
    const { embedOne, embeddingModelId } = await import('@dejavue/ai');
    queryVector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    matches = await semanticSearch(db, {
      guildId,
      queryVector,
      limit: 3,
      minSimilarity: SEMANTIC_MIN_SIMILARITY,
      excludeThreadId: thread.id,
      modelId: embeddingModelId(cfg?.embeddingModel),
    });
  } else {
    matches = await keywordSearch(db, { guildId, query, limit: 3, excludeThreadId: thread.id });
  }

  // Channel-fit advisory + off-topic guard (Plus+, opt-in). Runs before the no-matches
  // early return. If the guard auto-closes the thread, skip duplicate suggestions.
  if ((cfg?.channelFitCheck || cfg?.guardEnabled) && forum && queryVector) {
    const closed = await maybeGuardOrSuggest(thread, forum.id, queryVector, cfg, !limits.removeBranding);
    if (closed) return;
  }

  if (matches.length === 0) return;

  const draft = limits.generative
    ? await maybeDraft(guildId, query, matches, limits.monthlyGenerationQuota)
    : undefined;
  try {
    await thread.send(duplicatesMessage(guildId, matches, !limits.removeBranding, draft));
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'failed to post duplicate suggestion');
  }
}
