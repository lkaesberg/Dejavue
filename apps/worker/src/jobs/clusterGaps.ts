import { clusterLabel, embeddingModelId } from '@dejavue/ai';
import { childLogger, getEnv, greedyCluster } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getGuildEmbeddingPoints,
  type NewClusterInput,
  replaceClusters,
} from '@dejavue/db';
import type { ClusterGapsJob } from '@dejavue/queue';
import { guildGenerationQuota } from '../lib/quota';

const log = childLogger({ mod: 'job:cluster-gaps' });
const SIM_THRESHOLD = 0.82;
const LABEL_TOP_N = 5;

/** Cluster a guild's recurring questions and label the largest clusters (Pro). */
export async function handleClusterGaps(job: ClusterGapsJob): Promise<void> {
  const db = getDb();
  const env = getEnv();
  const baseQuota = await guildGenerationQuota(job.guildId);
  const points = await getGuildEmbeddingPoints(db, job.guildId, embeddingModelId());
  if (points.length < 4) {
    await replaceClusters(db, job.guildId, []);
    log.info({ guildId: job.guildId, points: points.length }, 'too few points to cluster');
    return;
  }

  const clusters = greedyCluster(
    points.map((p) => ({ id: p.threadRowId, vector: p.vector })),
    SIM_THRESHOLD,
    2,
  );
  const byRowId = new Map(points.map((p) => [p.threadRowId, p]));

  const toStore: NewClusterInput[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;
    const medoid = byRowId.get(c.medoidId);
    const memberThreadIds = c.memberIds
      .map((id) => byRowId.get(id)?.threadId)
      .filter((x): x is string => Boolean(x));
    let label: string | null = medoid?.title ?? null;

    if (i < LABEL_TOP_N && env.OPENROUTER_API_KEY) {
      const quota = await checkQuota(db, job.guildId, baseQuota);
      if (quota.allowed) {
        try {
          const reps = c.memberIds
            .slice(0, 5)
            .map((id) => byRowId.get(id)?.title ?? '')
            .filter(Boolean);
          const res = await clusterLabel(reps);
          if (res.text.trim()) label = res.text.trim().slice(0, 120);
          await commitGeneration(db, {
            guildId: job.guildId,
            feature: 'cluster_label',
            model: res.model,
            promptTokens: res.promptTokens,
            completionTokens: res.completionTokens,
            usedBefore: quota.used,
            baseQuota,
          });
        } catch (err) {
          log.warn({ err }, 'cluster label failed');
        }
      }
    }

    toStore.push({
      label,
      representativeText: medoid?.title ?? null,
      medoidThreadRowId: c.medoidId,
      memberThreadIds,
      size: c.size,
    });
  }

  await replaceClusters(db, job.guildId, toStore);
  log.info({ guildId: job.guildId, clusters: toStore.length }, 'clustered knowledge gaps');
}
