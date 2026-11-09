import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { type NewReindexJob, reindexJob, type ReindexJob } from '../schema';

export async function createReindexJob(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    kind: 'forum' | 'tracked';
    statusChannelId?: string | null;
    statusMessageId?: string | null;
  },
): Promise<ReindexJob> {
  const values: NewReindexJob = {
    guildId: input.guildId,
    channelId: input.channelId,
    kind: input.kind,
    status: 'pending',
    statusChannelId: input.statusChannelId ?? null,
    statusMessageId: input.statusMessageId ?? null,
  };
  const [row] = await db.insert(reindexJob).values(values).returning();
  if (!row) throw new Error('createReindexJob returned no row');
  return row;
}

export async function getReindexJob(db: Database, id: string): Promise<ReindexJob | undefined> {
  const [row] = await db.select().from(reindexJob).where(eq(reindexJob.id, id)).limit(1);
  return row;
}

/** A pending/running reindex for this channel, if any (dedupe before enqueueing a new one). */
export async function getActiveReindexJob(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<ReindexJob | undefined> {
  const [row] = await db
    .select()
    .from(reindexJob)
    .where(
      and(
        eq(reindexJob.guildId, guildId),
        eq(reindexJob.channelId, channelId),
        inArray(reindexJob.status, ['pending', 'running']),
      ),
    )
    .orderBy(desc(reindexJob.createdAt))
    .limit(1);
  return row;
}

/** Active reindex jobs for a guild (status command shows live progress for each). */
export async function listActiveReindexJobs(db: Database, guildId: string): Promise<ReindexJob[]> {
  return db
    .select()
    .from(reindexJob)
    .where(and(eq(reindexJob.guildId, guildId), inArray(reindexJob.status, ['pending', 'running'])));
}

/**
 * Progress fields only. Status changes go through {@link claimReindexJob} /
 * {@link transitionReindexJob} so every lifecycle move is guarded on the current status.
 */
export type ReindexPatch = Partial<{
  phase: ReindexJob['phase'];
  processedThreadIds: string[];
  total: number;
  processed: number;
  failed: number;
  removed: number;
  statusChannelId: string | null;
  statusMessageId: string | null;
}>;

type JobStatus = ReindexJob['status'];

/**
 * Checkpoint progress (and refresh the heartbeat). Only a running job accepts progress,
 * so a run the sweeper already failed can't write over its terminal row.
 */
export async function updateReindexJob(
  db: Database,
  id: string,
  patch: ReindexPatch,
): Promise<void> {
  await db
    .update(reindexJob)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(reindexJob.id, id), eq(reindexJob.status, 'running')));
}

/**
 * Take ownership of a job for one worker run: pending → running, or re-take a running
 * job whose heartbeat is older than `leaseMs` (its worker died). A row another live
 * worker is heartbeating, or a terminal one, is never claimed — so a pg-boss retry that
 * fires while the original is still running can't work the same row twice.
 */
export async function claimReindexJob(
  db: Database,
  id: string,
  leaseMs: number,
): Promise<ReindexJob | undefined> {
  const leaseCutoff = new Date(Date.now() - leaseMs);
  const [row] = await db
    .update(reindexJob)
    .set({ status: 'running', updatedAt: new Date() })
    .where(
      and(
        eq(reindexJob.id, id),
        or(
          eq(reindexJob.status, 'pending'),
          and(eq(reindexJob.status, 'running'), lt(reindexJob.updatedAt, leaseCutoff)),
        ),
      ),
    )
    .returning();
  return row;
}

/** Keep a running job's lease alive (bumps updated_at only while it is still running). */
export async function heartbeatReindexJob(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(reindexJob)
    .set({ updatedAt: new Date() })
    .where(and(eq(reindexJob.id, id), eq(reindexJob.status, 'running')))
    .returning({ id: reindexJob.id });
  return rows.length > 0;
}

/**
 * The one status-changing write: move `id` to `to` only if it is currently in one of
 * `from`. Returns false when the row was not in an allowed state (someone else already
 * finished, failed or swept it) — the caller must then leave channel_sync alone.
 */
export async function transitionReindexJob(
  db: Database,
  id: string,
  from: JobStatus[],
  to: JobStatus,
  patch: ReindexPatch = {},
): Promise<boolean> {
  const rows = await db
    .update(reindexJob)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(reindexJob.id, id), inArray(reindexJob.status, from)))
    .returning({ id: reindexJob.id });
  return rows.length > 0;
}

/**
 * Fail jobs nothing is working on any more: running rows whose heartbeat stopped more
 * than `runningStaleMs` ago (worker crash, retries exhausted) and pending rows older than
 * `pendingStaleMs` (the queue message was lost). Returns the swept rows so the caller can
 * release each channel's 'reindexing' claim.
 */
export async function sweepStaleReindexJobs(
  db: Database,
  opts: { runningStaleMs: number; pendingStaleMs: number },
): Promise<Pick<ReindexJob, 'id' | 'guildId' | 'channelId'>[]> {
  const now = Date.now();
  return db
    .update(reindexJob)
    .set({ status: 'failed', updatedAt: sql`now()` })
    .where(
      or(
        and(
          eq(reindexJob.status, 'running'),
          lt(reindexJob.updatedAt, new Date(now - opts.runningStaleMs)),
        ),
        and(
          eq(reindexJob.status, 'pending'),
          lt(reindexJob.updatedAt, new Date(now - opts.pendingStaleMs)),
        ),
      ),
    )
    .returning({ id: reindexJob.id, guildId: reindexJob.guildId, channelId: reindexJob.channelId });
}
