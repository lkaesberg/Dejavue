import { ChannelType, type Client, type ForumChannel, type Guild } from 'discord.js';
import { childLogger, type FitSuggestion, suggestBetterChannel } from '@dejavue/core';
import {
  channelFitScores,
  channelMode,
  deleteStaleModelTopics,
  getDb,
  getGuildConfig,
  type GuildConfig,
  listChannelTopicChannelIds,
  upsertChannelTopic,
} from '@dejavue/db';

const log = childLogger({ mod: 'channel-fit' });

/** Guilds with a topic (re)build in flight — collapses bursts and retry storms. */
const rebuilding = new Set<string>();

/** The text we embed for a channel: its name plus its description / post guidelines. */
function topicText(name: string, description?: string | null): string {
  return [name.trim(), (description ?? '').trim()].filter(Boolean).join('\n\n');
}

/** Monitored channels eligible for fit checks (question channels — never knowledge). */
function questionChannelIds(cfg: GuildConfig): string[] {
  return cfg.forumChannelIds.filter((id) => channelMode(cfg, id) !== 'knowledge');
}

async function buildTopic(
  guild: Guild,
  channelId: string,
  cfg: GuildConfig,
): Promise<void> {
  const ch =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (ch?.type !== ChannelType.GuildForum) return;
  await refreshChannelTopic(
    guild.id,
    ch as ForumChannel,
    cfg.embeddingModel,
    cfg.channelGuidelines?.[channelId],
  );
}

/** Build/refresh one channel's topic embedding from its name + description. */
export async function refreshChannelTopic(
  guildId: string,
  channel: ForumChannel,
  model: string | undefined,
  description?: string | null,
): Promise<void> {
  const text = topicText(channel.name, description ?? channel.topic);
  if (!text) return;
  const { embedOne, embeddingModelId } = await import('@dejavue/ai');
  const vec = await embedOne(text, { mode: 'passage', model });
  await upsertChannelTopic(getDb(), {
    guildId,
    channelId: channel.id,
    modelId: embeddingModelId(model),
    text,
    vec,
  });
}

/** Force-(re)build topics for every monitored question channel (explicit enable). */
export async function refreshAllChannelTopics(guild: Guild, cfg: GuildConfig): Promise<void> {
  for (const channelId of questionChannelIds(cfg)) {
    try {
      await buildTopic(guild, channelId, cfg);
    } catch (err) {
      log.warn({ err, channelId, guildId: guild.id }, 'failed to refresh channel topic');
    }
  }
  log.info({ guildId: guild.id }, 'refreshed all channel topics');
}

/**
 * Build topics only for monitored question channels that lack one for the active
 * model — self-heals missing/failed builds and a model switch without re-embedding
 * channels that are already current. Guarded so a burst collapses to one build.
 */
export async function ensureChannelTopics(guild: Guild, cfg: GuildConfig): Promise<void> {
  if (rebuilding.has(guild.id)) return;
  rebuilding.add(guild.id);
  try {
    const { embeddingModelId } = await import('@dejavue/ai');
    const present = new Set(
      await listChannelTopicChannelIds(getDb(), guild.id, embeddingModelId(cfg.embeddingModel)),
    );
    for (const channelId of questionChannelIds(cfg)) {
      if (present.has(channelId)) continue;
      try {
        await buildTopic(guild, channelId, cfg);
      } catch (err) {
        log.warn({ err, channelId, guildId: guild.id }, 'failed to ensure channel topic');
      }
    }
  } finally {
    rebuilding.delete(guild.id);
  }
}

/**
 * Startup/periodic reconcile for fit-check guilds: drop topic rows from a previous
 * embedding model, then build any missing topics for the active model — so a model
 * switch or a build that failed while online heals without waiting for traffic.
 */
export async function channelFitReconcile(client: Client): Promise<void> {
  try {
    const { embeddingModelId } = await import('@dejavue/ai');
    const db = getDb();
    for (const guild of client.guilds.cache.values()) {
      const cfg = await getGuildConfig(db, guild.id);
      if (!cfg?.channelFitCheck) continue;
      await deleteStaleModelTopics(db, guild.id, embeddingModelId(cfg.embeddingModel));
      await ensureChannelTopics(guild, cfg);
    }
  } catch (err) {
    log.error({ err }, 'channel-fit reconcile failed');
  }
}

/**
 * Given a new question's embedding, decide whether another monitored *question*
 * channel is a clearly better home than the one it was posted in. Returns the
 * suggestion or null. Caller must already know the feature is enabled.
 */
export async function checkChannelFit(
  guildId: string,
  currentChannelId: string,
  queryVector: number[],
  cfg: GuildConfig,
): Promise<FitSuggestion | null> {
  const { embeddingModelId } = await import('@dejavue/ai');
  const scores = await channelFitScores(getDb(), {
    guildId,
    queryVector,
    modelId: embeddingModelId(cfg.embeddingModel),
  });
  if (scores.length === 0) return null;
  return suggestBetterChannel(scores, currentChannelId, new Set(questionChannelIds(cfg)));
}
