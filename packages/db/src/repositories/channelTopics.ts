import { and, cosineDistance, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { channelTopic } from '../schema';

/** Insert or refresh a channel's topic embedding (keyed by guild + channel + model). */
export async function upsertChannelTopic(
  db: Database,
  values: { guildId: string; channelId: string; modelId: string; text: string; vec: number[] },
): Promise<void> {
  await db
    .insert(channelTopic)
    .values(values)
    .onConflictDoUpdate({
      target: [channelTopic.guildId, channelTopic.channelId, channelTopic.modelId],
      set: { text: values.text, vec: values.vec, updatedAt: new Date() },
    });
}

/** Remove a channel's topic embedding(s) — on untrack / channel deletion. */
export async function deleteChannelTopic(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(channelTopic)
    .where(and(eq(channelTopic.guildId, guildId), eq(channelTopic.channelId, channelId)));
}

/** Whether the guild has any channel topics built for the active model yet. */
export async function hasChannelTopics(
  db: Database,
  guildId: string,
  modelId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(channelTopic)
    .where(and(eq(channelTopic.guildId, guildId), eq(channelTopic.modelId, modelId)));
  return (row?.n ?? 0) > 0;
}

/** Channel ids that already have a topic for the active model (to build only the gaps). */
export async function listChannelTopicChannelIds(
  db: Database,
  guildId: string,
  modelId: string,
): Promise<string[]> {
  const rows = await db
    .select({ channelId: channelTopic.channelId })
    .from(channelTopic)
    .where(and(eq(channelTopic.guildId, guildId), eq(channelTopic.modelId, modelId)));
  return rows.map((r) => r.channelId);
}

/** Drop topic rows built for a different (e.g. previous) embedding model. */
export async function deleteStaleModelTopics(
  db: Database,
  guildId: string,
  activeModelId: string,
): Promise<void> {
  await db
    .delete(channelTopic)
    .where(and(eq(channelTopic.guildId, guildId), ne(channelTopic.modelId, activeModelId)));
}

export interface ChannelFitScore {
  channelId: string;
  /** Cosine similarity in [0,1] between the query and the channel's topic. */
  score: number;
}

/**
 * Score how well a query (a new question) fits each of the guild's channels, by
 * cosine similarity to the stored topic vectors. Highest fit first. Model-scoped
 * so vectors from a different embedding model are never compared.
 */
export async function channelFitScores(
  db: Database,
  opts: { guildId: string; queryVector: number[]; modelId: string },
): Promise<ChannelFitScore[]> {
  const distance = cosineDistance(channelTopic.vec, opts.queryVector);
  const rows = await db
    .select({ channelId: channelTopic.channelId, score: sql<number>`1 - (${distance})` })
    .from(channelTopic)
    .where(and(eq(channelTopic.guildId, opts.guildId), eq(channelTopic.modelId, opts.modelId)))
    .orderBy(distance);
  return rows;
}
