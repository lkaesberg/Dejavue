import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { backfillJob, type BackfillJob } from '../schema';

export async function createBackfillJob(
  db: Database,
  input: {
    guildId: string;
    channelId: string;
    entitlementId?: string | null;
    statusChannelId?: string | null;
    statusMessageId?: string | null;
  },
): Promise<BackfillJob> {
  const [row] = await db
    .insert(backfillJob)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      entitlementId: input.entitlementId ?? null,
      status: 'pending',
      statusChannelId: input.statusChannelId ?? null,
      statusMessageId: input.statusMessageId ?? null,
    })
    .returning();
  if (!row) throw new Error('createBackfillJob returned no row');
  return row;
}

/** A pending/running backfill for this channel, if any (dedupe before enqueueing a new one). */
export async function getActiveBackfillJob(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<BackfillJob | undefined> {
  const [row] = await db
    .select()
    .from(backfillJob)
    .where(
      and(
        eq(backfillJob.guildId, guildId),
        eq(backfillJob.channelId, channelId),
        inArray(backfillJob.status, ['pending', 'running']),
      ),
    )
    .orderBy(desc(backfillJob.createdAt))
    .limit(1);
  return row;
}

/** Active backfill jobs for a guild (the setup hub shows live import progress for each). */
export async function listActiveBackfillJobs(db: Database, guildId: string): Promise<BackfillJob[]> {
  return db
    .select()
    .from(backfillJob)
    .where(and(eq(backfillJob.guildId, guildId), inArray(backfillJob.status, ['pending', 'running'])));
}

export async function getBackfillJob(db: Database, id: string): Promise<BackfillJob | undefined> {
  const [row] = await db.select().from(backfillJob).where(eq(backfillJob.id, id)).limit(1);
  return row;
}

export async function getLatestBackfillJob(
  db: Database,
  guildId: string,
): Promise<BackfillJob | undefined> {
  const [row] = await db
    .select()
    .from(backfillJob)
    .where(eq(backfillJob.guildId, guildId))
    .orderBy(desc(backfillJob.createdAt))
    .limit(1);
  return row;
}

/**
 * Progress fields only. Status changes go through {@link claimBackfillJob} /
 * {@link transitionBackfillJob} so every lifecycle move is guarded on the current status.
 */
export type BackfillPatch = Partial<{
  processedThreadIds: string[];
  total: number;
  processed: number;
  failed: number;
  statusChannelId: string | null;
  statusMessageId: string | null;
}>;

type JobStatus = BackfillJob['status'];

/** Checkpoint progress (and refresh the heartbeat) — only while the job is running. */
export async function updateBackfillJob(
  db: Database,
  id: string,
  patch: BackfillPatch,
): Promise<void> {
  await db
    .update(backfillJob)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(backfillJob.id, id), eq(backfillJob.status, 'running')));
}

/**
 * Take ownership of an import for one worker run: pending → running, failed → running
 * (a pg-boss retry after a recorded failure resumes from its checkpoint), or re-take a
 * running row whose heartbeat is older than `leaseMs`. Refuses while ANOTHER import of
 * the same channel is live (running with a fresh heartbeat), so two imports never work
 * one forum at once.
 */
export async function claimBackfillJob(
  db: Database,
  id: string,
  leaseMs: number,
): Promise<BackfillJob | undefined> {
  const leaseCutoff = new Date(Date.now() - leaseMs);
  // Raw template params bypass the column's Date mapping, so pass an ISO string.
  const other = sql.raw('other');
  const [row] = await db
    .update(backfillJob)
    .set({ status: 'running', updatedAt: new Date() })
    .where(
      and(
        eq(backfillJob.id, id),
        or(
          inArray(backfillJob.status, ['pending', 'failed']),
          and(eq(backfillJob.status, 'running'), lt(backfillJob.updatedAt, leaseCutoff)),
        ),
        sql`not exists (
          select 1 from ${backfillJob} as ${other}
          where ${other}.guild_id = ${backfillJob.guildId}
            and ${other}.channel_id = ${backfillJob.channelId}
            and ${other}.id <> ${backfillJob.id}
            and ${other}.status = 'running'
            and ${other}.updated_at >= ${leaseCutoff.toISOString()}::timestamptz
        )`,
      ),
    )
    .returning();
  return row;
}

/** Keep a running import's lease alive (bumps updated_at only while it is still running). */
export async function heartbeatBackfillJob(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(backfillJob)
    .set({ updatedAt: new Date() })
    .where(and(eq(backfillJob.id, id), eq(backfillJob.status, 'running')))
    .returning({ id: backfillJob.id });
  return rows.length > 0;
}

/**
 * The one status-changing write: move `id` to `to` only if it is currently in one of
 * `from`. Returns false when the row was not in an allowed state.
 */
export async function transitionBackfillJob(
  db: Database,
  id: string,
  from: JobStatus[],
  to: JobStatus,
  patch: BackfillPatch = {},
): Promise<boolean> {
  const rows = await db
    .update(backfillJob)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(backfillJob.id, id), inArray(backfillJob.status, from)))
    .returning({ id: backfillJob.id });
  return rows.length > 0;
}

/**
 * Another import of the same channel that should win over `job`: one already running,
 * or one still pending that was created first (so two pending duplicates never both
 * stand down — the older one runs, the younger one is redundant).
 */
export async function getOtherActiveBackfillJob(
  db: Database,
  job: Pick<BackfillJob, 'id' | 'guildId' | 'channelId' | 'createdAt'>,
): Promise<BackfillJob | undefined> {
  const [row] = await db
    .select()
    .from(backfillJob)
    .where(
      and(
        eq(backfillJob.guildId, job.guildId),
        eq(backfillJob.channelId, job.channelId),
        ne(backfillJob.id, job.id),
        or(
          eq(backfillJob.status, 'running'),
          and(
            eq(backfillJob.status, 'pending'),
            or(
              lt(backfillJob.createdAt, job.createdAt),
              and(eq(backfillJob.createdAt, job.createdAt), lt(backfillJob.id, job.id)),
            ),
          ),
        ),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Fail imports nothing is working on any more: running rows whose heartbeat stopped more
 * than `runningStaleMs` ago and pending rows older than `pendingStaleMs`.
 */
export async function sweepStaleBackfillJobs(
  db: Database,
  opts: { runningStaleMs: number; pendingStaleMs: number },
): Promise<Pick<BackfillJob, 'id' | 'guildId' | 'channelId'>[]> {
  const now = Date.now();
  return db
    .update(backfillJob)
    .set({ status: 'failed', updatedAt: sql`now()` })
    .where(
      or(
        and(
          eq(backfillJob.status, 'running'),
          lt(backfillJob.updatedAt, new Date(now - opts.runningStaleMs)),
        ),
        and(
          eq(backfillJob.status, 'pending'),
          lt(backfillJob.updatedAt, new Date(now - opts.pendingStaleMs)),
        ),
      ),
    )
    .returning({ id: backfillJob.id, guildId: backfillJob.guildId, channelId: backfillJob.channelId });
}
