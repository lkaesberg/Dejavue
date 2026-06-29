import { and, desc, eq, inArray } from 'drizzle-orm';
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

export type ReindexPatch = Partial<{
  status: ReindexJob['status'];
  phase: ReindexJob['phase'];
  cursor: string | null;
  processedThreadIds: string[];
  total: number;
  processed: number;
  failed: number;
  removed: number;
  statusChannelId: string | null;
  statusMessageId: string | null;
}>;

export async function updateReindexJob(
  db: Database,
  id: string,
  patch: ReindexPatch,
): Promise<void> {
  await db
    .update(reindexJob)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(reindexJob.id, id));
}
