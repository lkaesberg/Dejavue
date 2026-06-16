import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, type KnowledgeGapCluster, knowledgeGapCluster, thread } from '../schema';

export interface EmbeddingPoint {
  threadRowId: string;
  threadId: string;
  title: string;
  status: 'open' | 'solved' | 'unsolved';
  vector: number[];
}

/** Load question embeddings (+ thread metadata) for clustering. */
export async function getGuildEmbeddingPoints(
  db: Database,
  guildId: string,
  modelId?: string,
  limit = 2000,
): Promise<EmbeddingPoint[]> {
  const conditions = [eq(embedding.guildId, guildId), eq(embedding.source, 'question')];
  // Only one model's vectors at a time — never cluster across incompatible geometries.
  if (modelId) conditions.push(eq(embedding.modelId, modelId));
  const rows = await db
    .select({
      threadRowId: embedding.threadId,
      vector: embedding.vec,
      threadId: thread.threadId,
      title: thread.title,
      status: thread.status,
    })
    .from(embedding)
    .innerJoin(thread, eq(embedding.threadId, thread.id))
    .where(and(...conditions))
    .limit(limit);

  return rows.map((r) => ({
    threadRowId: r.threadRowId,
    threadId: r.threadId,
    title: r.title,
    status: r.status,
    vector: r.vector as number[],
  }));
}

export interface NewClusterInput {
  label?: string | null;
  representativeText?: string | null;
  medoidThreadRowId?: string | null;
  memberThreadIds: string[];
  size: number;
}

/** Replace the open knowledge-gap clusters for a guild with a fresh set. */
export async function replaceClusters(
  db: Database,
  guildId: string,
  clusters: NewClusterInput[],
): Promise<void> {
  await db
    .delete(knowledgeGapCluster)
    .where(and(eq(knowledgeGapCluster.guildId, guildId), eq(knowledgeGapCluster.status, 'open')));
  if (clusters.length === 0) return;
  await db.insert(knowledgeGapCluster).values(
    clusters.map((c) => ({
      guildId,
      label: c.label ?? null,
      representativeText: c.representativeText ?? null,
      medoidThreadId: c.medoidThreadRowId ?? null,
      memberThreadIds: c.memberThreadIds,
      size: c.size,
      status: 'open' as const,
    })),
  );
}

export async function getTopClusters(
  db: Database,
  guildId: string,
  limit = 10,
): Promise<KnowledgeGapCluster[]> {
  return db
    .select()
    .from(knowledgeGapCluster)
    .where(and(eq(knowledgeGapCluster.guildId, guildId), eq(knowledgeGapCluster.status, 'open')))
    .orderBy(sql`${knowledgeGapCluster.size} desc`)
    .limit(limit);
}
