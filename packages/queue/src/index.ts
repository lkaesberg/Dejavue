import type { Job, WorkOptions } from 'pg-boss';
import { startBoss } from './boss';
import {
  type BackfillForumJob,
  type ClusterGapsJob,
  type EmbedThreadJob,
  QUEUES,
  type QueueName,
  type RegenFaqJob,
  type RevalidateKbJob,
  type SummarizeThreadJob,
} from './jobs';

export * from './jobs';
export { getBoss, startBoss, stopBoss } from './boss';

// --------------------------------------------------------------------------
// Producers (enqueue)
// --------------------------------------------------------------------------

export async function enqueueEmbedThread(job: EmbedThreadJob): Promise<void> {
  const boss = await startBoss();
  await boss.send(QUEUES.EMBED_THREAD, job, { singletonKey: job.threadRowId });
}

export async function enqueueSummarize(job: SummarizeThreadJob): Promise<void> {
  const boss = await startBoss();
  // singletonKey dedupes concurrent jobs; singletonSeconds throttles re-enqueues
  // (e.g. a KB page reloaded during generation) to one per thread per window.
  await boss.send(QUEUES.SUMMARIZE_THREAD, job, {
    singletonKey: job.threadRowId,
    singletonSeconds: 180,
  });
}

export async function enqueueClusterGaps(job: ClusterGapsJob): Promise<void> {
  const boss = await startBoss();
  await boss.send(QUEUES.CLUSTER_GAPS, job, { singletonKey: job.guildId, singletonSeconds: 60 });
}

export async function enqueueRegenFaq(job: RegenFaqJob): Promise<void> {
  const boss = await startBoss();
  await boss.send(QUEUES.REGEN_FAQ, job, { singletonKey: job.guildId, singletonSeconds: 60 });
}

export async function enqueueBackfill(job: BackfillForumJob): Promise<void> {
  const boss = await startBoss();
  await boss.send(QUEUES.BACKFILL_FORUM, job, { singletonKey: job.backfillJobId });
}

export async function enqueueRevalidateKb(job: RevalidateKbJob): Promise<void> {
  const boss = await startBoss();
  await boss.send(QUEUES.REVALIDATE_KB, job, { singletonKey: `${job.guildId}:${job.threadId}` });
}

// --------------------------------------------------------------------------
// Consumer helpers
// --------------------------------------------------------------------------

/**
 * Register a handler for a queue. pg-boss v12 delivers an array of jobs; we fan
 * them out to a single-job handler for ergonomics.
 */
export async function work<T extends object>(
  queue: QueueName,
  handler: (data: T, job: Job<T>) => Promise<void>,
  options?: WorkOptions,
): Promise<string> {
  const boss = await startBoss();
  const wrapped = async (jobs: Job<T>[]): Promise<void> => {
    for (const job of jobs) {
      await handler(job.data, job);
    }
  };
  return options ? boss.work<T>(queue, options, wrapped) : boss.work<T>(queue, wrapped);
}

/** Schedule a recurring job via cron (used for nudges / clustering / reconcile). */
export async function schedule(queue: QueueName, cron: string, data: object = {}): Promise<void> {
  const boss = await startBoss();
  await boss.schedule(queue, cron, data);
}
