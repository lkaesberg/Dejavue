import { and, desc, eq, inArray } from 'drizzle-orm';
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

export type BackfillPatch = Partial<{
  status: BackfillJob['status'];
  cursor: string | null;
  processedThreadIds: string[];
  total: number;
  processed: number;
  failed: number;
  statusChannelId: string | null;
  statusMessageId: string | null;
}>;

export async function updateBackfillJob(
  db: Database,
  id: string,
  patch: BackfillPatch,
): Promise<void> {
  await db
    .update(backfillJob)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(backfillJob.id, id));
}
