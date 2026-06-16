import { desc, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { backfillJob, type BackfillJob } from '../schema';

export async function createBackfillJob(
  db: Database,
  input: { guildId: string; channelId: string; entitlementId?: string | null },
): Promise<BackfillJob> {
  const [row] = await db
    .insert(backfillJob)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      entitlementId: input.entitlementId ?? null,
      status: 'pending',
    })
    .returning();
  if (!row) throw new Error('createBackfillJob returned no row');
  return row;
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
