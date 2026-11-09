import { childLogger } from '@dejavue/core';
import {
  type Database,
  failReindex,
  getActiveReindexJob,
  type GuildConfig,
  sweepStaleBackfillJobs,
  sweepStaleReindexJobs,
} from '@dejavue/db';

const log = childLogger({ mod: 'job-lease' });

/**
 * Channel history jobs (backfill / reindex) hold their row with a heartbeat on
 * updated_at. A row whose heartbeat is younger than the lease belongs to a live worker
 * and is never claimed by a second one (a pg-boss expiry retry while the original is
 * still running); an older one belongs to a dead worker and may be re-taken.
 */
export const JOB_HEARTBEAT_MS = 30_000;
export const JOB_LEASE_MS = 3 * 60_000;
/**
 * Sweeper thresholds. Running: well past the lease, so pg-boss's own retries (30s/60s/
 * 120s backoff) get the first chance to resume a crashed run. Pending: the queue message
 * was lost (enqueue failed, or the queue was purged) — nothing will ever pick it up.
 */
export const RUNNING_STALE_MS = 30 * 60_000;
export const PENDING_STALE_MS = 24 * 3_600_000;
export const SWEEP_EVERY_MS = 10 * 60_000;

/** Thrown when a job row is held by another live worker: pg-boss retries it later. */
export class JobLeaseHeldError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} job ${id} is held by another worker`);
    this.name = 'JobLeaseHeldError';
  }
}

/** Thrown at a checkpoint when the channel was removed from monitoring mid-run. */
export class ChannelUnmonitoredError extends Error {
  constructor(channelId: string) {
    super(`channel ${channelId} is no longer monitored`);
    this.name = 'ChannelUnmonitoredError';
  }
}

/** Is `channelId` still configured as a forum / tracked channel for this guild? */
export function isChannelMonitored(
  cfg: Pick<GuildConfig, 'forumChannelIds' | 'trackedChannelIds'> | undefined,
  channelId: string,
  kind: 'forum' | 'tracked',
): boolean {
  if (!cfg) return false;
  return (kind === 'forum' ? cfg.forumChannelIds : cfg.trackedChannelIds).includes(channelId);
}

/**
 * Beat `beat` every `everyMs` until the returned stop() is called. A failed beat is only
 * logged (the next one retries); the lease is generous enough to absorb a few misses.
 */
export function startHeartbeat(
  beat: () => Promise<unknown>,
  everyMs: number = JOB_HEARTBEAT_MS,
): () => void {
  const timer = setInterval(() => {
    beat().catch((err) => log.warn({ err }, 'job heartbeat failed'));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Fail channel jobs nothing is working on any more, and release the 'reindexing' claim
 * each swept reindex held — otherwise the channel would show "re-scanning…" and refuse
 * every new reindex forever. Idempotent and guarded, so several workers may run it.
 */
export async function sweepStaleChannelJobs(db: Database): Promise<{ reindex: number; backfill: number }> {
  const opts = { runningStaleMs: RUNNING_STALE_MS, pendingStaleMs: PENDING_STALE_MS };
  const reindex = await sweepStaleReindexJobs(db, opts);
  for (const j of reindex) {
    // A newer job for the channel owns the claim now — leave it alone.
    if (await getActiveReindexJob(db, j.guildId, j.channelId)) continue;
    await failReindex(db, j.guildId, j.channelId, 'reindex failed');
  }
  const backfill = await sweepStaleBackfillJobs(db, opts);
  if (reindex.length || backfill.length) {
    log.warn(
      { reindex: reindex.map((j) => j.id), backfill: backfill.map((j) => j.id) },
      'failed stale channel jobs',
    );
  }
  return { reindex: reindex.length, backfill: backfill.length };
}
