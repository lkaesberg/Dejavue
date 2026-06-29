import '@dejavue/core/env-preload';
import { logger } from '@dejavue/core';
import {
  type BackfillForumJob,
  type ClusterGapsJob,
  type EmbedThreadJob,
  type IngestAttachmentJob,
  type NudgeStaleJob,
  QUEUES,
  type RegenFaqJob,
  type ReindexChannelJob,
  type RevalidateKbJob,
  schedule,
  startBoss,
  stopBoss,
  type SummarizeThreadJob,
  work,
} from '@dejavue/queue';
import { handleBackfillForum } from './jobs/backfillForum';
import { handleClusterGaps } from './jobs/clusterGaps';
import { handleEmbedThread } from './jobs/embedThread';
import { handleIngestAttachment } from './jobs/ingestAttachment';
import { handleNudgeStale } from './jobs/nudgeStale';
import { handleRegenFaq } from './jobs/regenFaq';
import { handleReindexChannel } from './jobs/reindexChannel';
import { handleRevalidateKb } from './jobs/revalidateKb';
import { handleSummarizeThread } from './jobs/summarizeThread';

const log = logger();

async function main(): Promise<void> {
  await startBoss();
  await work<EmbedThreadJob>(QUEUES.EMBED_THREAD, handleEmbedThread);
  await work<SummarizeThreadJob>(QUEUES.SUMMARIZE_THREAD, handleSummarizeThread);
  await work<ClusterGapsJob>(QUEUES.CLUSTER_GAPS, handleClusterGaps);
  await work<RegenFaqJob>(QUEUES.REGEN_FAQ, handleRegenFaq);
  await work<NudgeStaleJob>(QUEUES.NUDGE_STALE, handleNudgeStale);
  await work<RevalidateKbJob>(QUEUES.REVALIDATE_KB, handleRevalidateKb);
  await work<IngestAttachmentJob>(QUEUES.INGEST_ATTACHMENT, handleIngestAttachment);
  // Backfill is long-running; cap concurrency to 1 to be gentle on Discord REST.
  await work<BackfillForumJob>(QUEUES.BACKFILL_FORUM, handleBackfillForum, { batchSize: 1 });
  // Reindex is also long-running (paginates full history + re-embeds); same cap.
  await work<ReindexChannelJob>(QUEUES.REINDEX_CHANNEL, handleReindexChannel, { batchSize: 1 });

  // Hourly stale-question sweep (Plus+). Other generative jobs are on-demand.
  await schedule(QUEUES.NUDGE_STALE, '0 * * * *');

  log.info('Dejavue worker started');
}

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down worker');
    void stopBoss().finally(() => process.exit(0));
  });
}
