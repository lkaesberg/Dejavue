import { warmup } from '@dejavue/ai';
import { shutdownAnalytics } from '@dejavue/analytics';
import '@dejavue/core/env-preload';
import { createServer, type Server } from 'node:http';
import { getEnv, installCrashHandlers, logger, notify, notifyAsync } from '@dejavue/core';
import { getDb, getSql } from '@dejavue/db';
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
import { handleGuildRetention } from './jobs/guildRetention';
import { handleIngestAttachment } from './jobs/ingestAttachment';
import { handleNudgeStale } from './jobs/nudgeStale';
import { handleStatsSnapshot } from './jobs/statsSnapshot';
import { handleRegenFaq } from './jobs/regenFaq';
import { handleReindexChannel } from './jobs/reindexChannel';
import { handleRevalidateKb } from './jobs/revalidateKb';
import { handleSummarizeThread } from './jobs/summarizeThread';
import { handleEmbedRequest } from './lib/embedService';
import { SWEEP_EVERY_MS, sweepStaleChannelJobs } from './lib/jobLease';

const log = logger();
installCrashHandlers('worker');

// How many channel history jobs (backfill / reindex) may run in parallel. Bounded so a
// "Reindex all" over many channels makes visible progress on several at once instead of
// serializing behind the first, while the shared REST queue still throttles Discord.
// Each job re-embeds on a CPU model, so this also trades memory for throughput — hence
// env-tunable (CHANNEL_JOB_CONCURRENCY), conservative default, set to 1 on a small host.
const CHANNEL_JOB_CONCURRENCY = getEnv().CHANNEL_JOB_CONCURRENCY;

/**
 * Liveness endpoint for deploy orchestration: 200 when the DB is reachable. The same
 * internal server carries the embedding service (POST /embed) the bot and web call.
 * Best effort — a taken port (e.g. a second local worker next to the Docker
 * one) must not crash job processing, so listen errors only log a warning.
 */
function startHealthServer(): Server {
  const port = Number(process.env.HEALTH_PORT ?? 8090);
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/embed') {
      void handleEmbedRequest(req, res);
      return;
    }
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    getSql()`select 1`
      .then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
      .catch(() => res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}'));
  });
  server.on('error', (err) => log.warn({ err, port }, 'health endpoint unavailable (continuing without it)'));
  server.listen(port, () => log.info({ port }, 'health endpoint listening'));
  return server;
}

async function main(): Promise<void> {
  await startBoss();
  await work<EmbedThreadJob>(QUEUES.EMBED_THREAD, handleEmbedThread);
  await work<SummarizeThreadJob>(QUEUES.SUMMARIZE_THREAD, handleSummarizeThread);
  await work<ClusterGapsJob>(QUEUES.CLUSTER_GAPS, handleClusterGaps);
  await work<RegenFaqJob>(QUEUES.REGEN_FAQ, handleRegenFaq);
  await work<NudgeStaleJob>(QUEUES.NUDGE_STALE, handleNudgeStale);
  await work<RevalidateKbJob>(QUEUES.REVALIDATE_KB, handleRevalidateKb);
  await work<IngestAttachmentJob>(QUEUES.INGEST_ATTACHMENT, handleIngestAttachment);
  // Backfill/reindex each paginate a channel's full history and re-embed on a CPU
  // model, so one job runs for minutes. They all share ONE discord.js REST client
  // whose queue already enforces Discord's rate limits, so a few channels can run at
  // once safely. localConcurrency spawns that many parallel workers; without it (the
  // old batchSize:1 default of localConcurrency:1) a multi-channel "Reindex all"
  // processed strictly one channel at a time and the rest sat stuck in "reindexing"
  // for the whole run. batchSize stays 1 so each worker claims exactly one job.
  await work<BackfillForumJob>(QUEUES.BACKFILL_FORUM, handleBackfillForum, {
    batchSize: 1,
    localConcurrency: CHANNEL_JOB_CONCURRENCY,
  });
  await work<ReindexChannelJob>(QUEUES.REINDEX_CHANNEL, handleReindexChannel, {
    batchSize: 1,
    localConcurrency: CHANNEL_JOB_CONCURRENCY,
  });

  // Backfill/reindex rows whose worker died (or whose queue message was lost) would
  // otherwise stay 'running'/'pending' forever and block their channel. Sweep them on
  // start and periodically; the sweep is guarded, so several workers may run it.
  const sweep = (): void => {
    sweepStaleChannelJobs(getDb()).catch((err) => log.warn({ err }, 'stale channel job sweep failed'));
  };
  sweep();
  setInterval(sweep, SWEEP_EVERY_MS).unref();

  await work(QUEUES.STATS_SNAPSHOT, handleStatsSnapshot);
  await work(QUEUES.GUILD_RETENTION, handleGuildRetention);

  // Hourly stale-question sweep (Plus+). Other generative jobs are on-demand.
  await schedule(QUEUES.NUDGE_STALE, '0 * * * *');
  // Daily instance rollup for product analytics (03:00 UTC — off the hourly sweep).
  await schedule(QUEUES.STATS_SNAPSHOT, '0 3 * * *');
  // Daily removed-server retention (03:30 UTC — after the snapshot counts them).
  await schedule(QUEUES.GUILD_RETENTION, '30 3 * * *');

  health = startHealthServer();
  // The bot and web embed through this process (POST /embed), so load the local model
  // now rather than making the first duplicate check or website search wait for it.
  void warmup().catch((err) => log.warn({ err }, 'embedding model warmup failed'));
  log.info('Dejavue worker started');
  notifyAsync({ level: 'success', title: '✅ Worker online' });
}

let health: Server | undefined;

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  void notify({ level: 'error', title: '🔴 Worker failed to start', description: detail.slice(0, 4000) }).finally(
    () => process.exit(1),
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down worker');
    health?.close();
    // Analytics batches in memory, so a deploy would drop the tail of the buffer
    // without an explicit flush.
    void Promise.allSettled([stopBoss(), shutdownAnalytics()]).finally(() => process.exit(0));
  });
}
