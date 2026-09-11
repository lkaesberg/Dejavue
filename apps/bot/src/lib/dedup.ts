import { capture } from '@dejavue/analytics';
import type { BaseMessageOptions, ThreadChannel } from 'discord.js';
import { activeForumChannels, childLogger, dedupMinSimilarity, getEnv } from '@dejavue/core';
import {
  channelMode,
  checkQuota,
  commitGeneration,
  countIndexedMessages,
  getDb,
  getGuildConfig,
  getThreadByDiscordId,
  getThreadsByRowIds,
  type GuildConfig,
  hybridSearch,
  keywordSearch,
  listChannelTopicChannelIds,
  type SearchMatch,
  updateGuildConfig,
} from '@dejavue/db';
import { assessChannel, ensureChannelTopics } from './channelFit';
import {
  channelFitMessage,
  channelGuardMessage,
  draftingMessage,
  duplicatesMessage,
  noMatchesMessage,
  searchingMessage,
} from './embeds';
import { applyTag, ensureWrongChannelTag, fetchStarterWithRetry, forumParent } from './forum';
import { closeThread } from './solve';
import { getGuildTier, limitsFor, monitoredForum } from './tier';

const log = childLogger({ mod: 'dedup' });

const DEBOUNCE_MS = 4000;
// How long the "looks like a new question" notice stays before it removes itself.
const NO_MATCH_TTL_MS = 30_000;
// How readily to flag a reworded post as a duplicate: the guild's chosen preset
// or custom similarity % (/dejavue settings) resolves to a cosine floor via
// dedupMinSimilarity. bge-small cosine for genuine paraphrases sits ~0.65–0.85.

/** Threads we've already scheduled, so threadCreate + messageCreate collapse to one run. */
const scheduled = new Set<string>();

/** Minimal shape of the live searching placeholder held across the debounce. */
export interface LivePlaceholderMessage {
  edit(payload: BaseMessageOptions): Promise<unknown>;
  delete(): Promise<unknown>;
}
export type Placeholder = Promise<LivePlaceholderMessage | null>;

/** Remove the searching placeholder (dead-end paths, errors). Never throws. */
export async function discardPlaceholder(placeholder: Placeholder): Promise<void> {
  const msg = await placeholder.catch(() => null);
  await msg?.delete().catch(() => undefined);
}

/**
 * Edit the placeholder in place. Returns false when there is no placeholder or the
 * edit failed (message deleted by a mod, thread gone) so callers can fall back.
 */
export async function editPlaceholder(
  placeholder: Placeholder,
  payload: BaseMessageOptions,
): Promise<boolean> {
  const msg = await placeholder.catch(() => null);
  if (!msg) return false;
  try {
    await msg.edit(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Edit the placeholder into a transient notice that removes itself after ttlMs
 * (the no-match outcome). No placeholder → stay silent; never throws.
 */
export async function editPlaceholderTransient(
  placeholder: Placeholder,
  payload: BaseMessageOptions,
  ttlMs: number,
): Promise<void> {
  const msg = await placeholder.catch(() => null);
  if (!msg) return;
  try {
    await msg.edit(payload);
  } catch {
    return;
  }
  const timer = setTimeout(() => void msg.delete().catch(() => undefined), ttlMs);
  timer.unref?.();
}

/**
 * The live "Searching solved answers…" message, posted the moment a post lands so the
 * asker sees the bot working during the debounce + search instead of silence. Skipped
 * on guilds with nothing indexed yet (a fresh install would answer "new question" to
 * every post — stay quiet instead).
 */
function postSearchingPlaceholder(thread: ThreadChannel): Placeholder {
  return (async () => {
    try {
      const [limits, indexed] = await Promise.all([
        getGuildTier(thread.guildId).then(limitsFor),
        countIndexedMessages(getDb(), thread.guildId),
      ]);
      if (indexed === 0) return null;
      return await thread.send(
        searchingMessage({
          indexedCount: indexed,
          semantic: limits.semanticSearch,
          showBranding: !limits.removeBranding,
        }),
      );
    } catch (err) {
      log.debug({ err, threadId: thread.id }, 'failed to post searching placeholder');
      return null;
    }
  })();
}

/** Debounced, idempotent-by-thread-id duplicate detection. */
export function scheduleDedup(thread: ThreadChannel): void {
  if (scheduled.has(thread.id)) return;
  scheduled.add(thread.id);
  // Post the "Searching…" placeholder up front, not when the debounce fires: several
  // seconds of silence on a fresh post is long enough for the asker to close Discord.
  // The cost is that a bot restart inside the debounce window can strand one placeholder.
  const placeholder = postSearchingPlaceholder(thread);
  const timer = setTimeout(() => {
    void runDedup(thread, placeholder)
      .catch(async (err) => {
        log.warn({ err, threadId: thread.id }, 'dedup run failed');
        // Never leave a stuck "Searching…" behind.
        await discardPlaceholder(placeholder);
      })
      .finally(() => scheduled.delete(thread.id));
  }, DEBOUNCE_MS);
  timer.unref();
}

/** Plus+: draft an answer from matched solved threads, metered in AI credits. */
async function maybeDraft(
  guildId: string,
  question: string,
  matches: SearchMatch[],
  baseCredits: number,
): Promise<string | undefined> {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) return undefined;
  const db = getDb();
  try {
    const quota = await checkQuota(db, guildId, baseCredits);
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
      usedTokensBefore: quota.usedTokens,
      baseCredits,
    });
    capture('generation', guildId, {
      feature: 'draft',
      model_id: result.model,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      success: true,
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
  finish: (payload: BaseMessageOptions) => Promise<void>,
): Promise<boolean> {
  try {
    const db = getDb();
    const { embeddingModelId } = await import('@dejavue/ai');
    const present = new Set(
      await listChannelTopicChannelIds(db, thread.guildId, embeddingModelId(cfg.embeddingModel)),
    );
    const limits = limitsFor(await getGuildTier(thread.guildId));
    const candidates = activeForumChannels(cfg.forumChannelIds, limits.maxForumChannels).filter(
      (id) => channelMode(cfg, id) !== 'knowledge',
    );
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
      // Resolve the searching placeholder into the guard notice BEFORE closing —
      // closeThread locks + archives, after which edits would fail.
      await finish(channelGuardMessage(wrong.channelId, showBranding));
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

async function runDedup(thread: ThreadChannel, placeholder: Placeholder): Promise<void> {
  const db = getDb();
  const guildId = thread.guildId;
  const forum = forumParent(thread);
  const cfg = await getGuildConfig(db, guildId);
  if (forum && !(await monitoredForum(guildId, cfg, forum.id))) {
    await discardPlaceholder(placeholder);
    return;
  }
  // Knowledge channels are a pure archive — never post duplicate reminders.
  if (forum && channelMode(cfg, forum.id) === 'knowledge') {
    await discardPlaceholder(placeholder);
    return;
  }

  // Don't suggest duplicates on a post that's already solved (also keeps the
  // /demo seed posts quiet, since they're persisted solved before this fires).
  const existing = await getThreadByDiscordId(db, guildId, thread.id);
  if (existing?.status === 'solved') {
    await discardPlaceholder(placeholder);
    return;
  }

  const body = await fetchStarterWithRetry(thread);
  const query = [thread.name, body].join('\n').trim();
  if (!query) {
    await discardPlaceholder(placeholder);
    return;
  }

  const limits = limitsFor(await getGuildTier(guildId));
  const showBranding = !limits.removeBranding;
  // Edit the live placeholder into the outcome; fall back to a fresh message when
  // a mod deleted it mid-search.
  const finish = async (payload: BaseMessageOptions): Promise<void> => {
    if (await editPlaceholder(placeholder, payload)) return;
    await thread
      .send(payload)
      .catch((err) => log.warn({ err, threadId: thread.id }, 'failed to post dedup outcome'));
  };

  const searchStarted = Date.now();
  let matches: SearchMatch[];
  let queryVector: number[] | undefined;
  if (limits.semanticSearch) {
    const { embedOne, embeddingModelId } = await import('@dejavue/ai');
    queryVector = await embedOne(query, { mode: 'query', model: cfg?.embeddingModel });
    // Hybrid: direct keyword overlap boosts the similarity, so an identically-
    // worded repost (same error message, same command) ranks above a merely
    // related thread and can clear the sensitivity bar. Keyword-only hits are
    // excluded — they'd make noisy duplicate suggestions.
    matches = await hybridSearch(db, {
      guildId,
      query,
      queryVector,
      limit: 3,
      minSimilarity: dedupMinSimilarity(cfg?.dedupSensitivity),
      excludeThreadId: thread.id,
      modelId: embeddingModelId(cfg?.embeddingModel),
      includeKeywordOnly: false,
    });
  } else {
    matches = await keywordSearch(db, { guildId, query, limit: 3, excludeThreadId: thread.id });
  }
  const elapsedMs = Date.now() - searchStarted;

  // Channel-fit advisory + off-topic guard (Plus+, opt-in). Runs before the no-matches
  // early return. If the guard auto-closes the thread, skip duplicate suggestions.
  if ((cfg?.channelFitCheck || cfg?.guardEnabled) && forum && queryVector) {
    const closed = await maybeGuardOrSuggest(thread, forum.id, queryVector, cfg, showBranding, finish);
    if (closed) return;
  }

  if (matches.length === 0) {
    // Edit-only (no send fallback): guilds without a placeholder stay silent, as before.
    await editPlaceholderTransient(placeholder, noMatchesMessage(showBranding), NO_MATCH_TTL_MS);
    return;
  }

  // Show the intermediate "drafting…" state only when a draft will actually be attempted.
  if (limits.aiDrafts && getEnv().OPENROUTER_API_KEY) {
    await editPlaceholder(placeholder, draftingMessage(matches.length, showBranding));
  }
  const draft = limits.aiDrafts
    ? await maybeDraft(guildId, query, matches, limits.monthlyCredits)
    : undefined;
  capture('dedup_shown', guildId, {
    match_count: matches.length,
    // Rounded: a similarity bucket is a quality signal, not a fingerprint.
    top_similarity: Math.round((matches[0]?.score ?? 0) * 100) / 100,
    mode: limits.semanticSearch ? 'hybrid' : 'keyword',
  });
  await finish(duplicatesMessage(guildId, matches, showBranding, { draft, elapsedMs }));
}
