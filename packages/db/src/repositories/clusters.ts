import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { embedding, faqEntry, type KnowledgeGapCluster, knowledgeGapCluster, thread } from '../schema';

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

/**
 * Replace the open knowledge-gap clusters for a guild with a fresh set, in one
 * transaction, keeping each FAQ entry attached to its topic.
 *
 * Cluster rows get new ids on every run, and faq_entry.cluster_id is ON DELETE SET NULL,
 * so a plain delete-and-insert orphaned every FAQ entry and the next FAQ regen (which
 * looks entries up by cluster id) inserted a fresh copy each cycle. The medoid thread is
 * the cluster's stable identity: an entry whose old cluster has the same medoid as a new
 * one is moved onto the new id before the old rows go. Generated entries left without a
 * cluster afterwards describe a topic that no longer exists and are pruned; a human edit
 * (manual_override) is kept.
 */
export async function replaceClusters(
  db: Database,
  guildId: string,
  clusters: NewClusterInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const old = await tx
      .select({ id: knowledgeGapCluster.id, medoidThreadId: knowledgeGapCluster.medoidThreadId })
      .from(knowledgeGapCluster)
      .where(and(eq(knowledgeGapCluster.guildId, guildId), eq(knowledgeGapCluster.status, 'open')));

    const inserted =
      clusters.length === 0
        ? []
        : await tx
            .insert(knowledgeGapCluster)
            .values(
              clusters.map((c) => ({
                guildId,
                label: c.label ?? null,
                representativeText: c.representativeText ?? null,
                medoidThreadId: c.medoidThreadRowId ?? null,
                memberThreadIds: c.memberThreadIds,
                size: c.size,
                status: 'open' as const,
              })),
            )
            .returning({ id: knowledgeGapCluster.id, medoidThreadId: knowledgeGapCluster.medoidThreadId });

    const newByMedoid = new Map<string, string>();
    for (const c of inserted) if (c.medoidThreadId) newByMedoid.set(c.medoidThreadId, c.id);
    for (const o of old) {
      const next = o.medoidThreadId ? newByMedoid.get(o.medoidThreadId) : undefined;
      if (next) await tx.update(faqEntry).set({ clusterId: next }).where(eq(faqEntry.clusterId, o.id));
    }

    if (old.length > 0) {
      await tx.delete(knowledgeGapCluster).where(
        inArray(
          knowledgeGapCluster.id,
          old.map((o) => o.id),
        ),
      );
    }
    await tx
      .delete(faqEntry)
      .where(and(eq(faqEntry.guildId, guildId), isNull(faqEntry.clusterId), eq(faqEntry.manualOverride, false)));
  });
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
