import { clusterLabel, embeddingModelId } from '@dejavue/ai';
import { childLogger, genProgressEmbed, getEnv, greedyCluster } from '@dejavue/core';
import {
  checkQuota,
  commitGeneration,
  getDb,
  getGuildEmbeddingPoints,
  getTopClusters,
  markGenerationFinished,
  type NewClusterInput,
  replaceClusters,
} from '@dejavue/db';
import type { ClusterGapsJob } from '@dejavue/queue';
import { LiveProgress } from '../lib/progress';
import { guildGenerationQuota } from '../lib/quota';

const log = childLogger({ mod: 'job:cluster-gaps' });
const SIM_THRESHOLD = 0.82;
const LABEL_TOP_N = 5;

/** Render the current top clusters into the live message (final state). */
async function renderClusters(guildId: string, live: LiveProgress): Promise<void> {
  const clusters = await getTopClusters(getDb(), guildId, 10);
  const body = clusters
    .map((c) => {
      const first = c.memberThreadIds[0];
      const title = c.label ?? c.representativeText ?? 'topic';
      return first
        ? `• [${title}](https://discord.com/channels/${guildId}/${first}) — ${c.size} asks`
        : `• ${title} — ${c.size} asks`;
    })
    .join('\n');
  await live.finalize(genProgressEmbed({ kind: 'cluster', phase: 'done', body }));
}

/** Cluster a guild's recurring questions and label the largest clusters (Pro). */
export async function handleClusterGaps(job: ClusterGapsJob): Promise<void> {
  const db = getDb();
  const env = getEnv();
  const live = job.progress ? new LiveProgress(job.progress) : null;
  live?.update(genProgressEmbed({ kind: 'cluster', phase: 'working', note: 'grouping questions…' }));
  try {
    await clusterGaps(job, db, env);
  } finally {
    if (live) await renderClusters(job.guildId, live).catch(() => undefined);
  }
}

async function clusterGaps(
  job: ClusterGapsJob,
  db: ReturnType<typeof getDb>,
  env: ReturnType<typeof getEnv>,
): Promise<void> {
  const baseQuota = await guildGenerationQuota(job.guildId);
  const points = await getGuildEmbeddingPoints(db, job.guildId, embeddingModelId());
  if (points.length < 4) {
    await replaceClusters(db, job.guildId, []);
    await markGenerationFinished(db, job.guildId, 'cluster');
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
  await markGenerationFinished(db, job.guildId, 'cluster');
  log.info({ guildId: job.guildId, clusters: toStore.length }, 'clustered knowledge gaps');
}
