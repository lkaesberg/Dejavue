import { and, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { channelSync, type ChannelSync, type ThreadKind } from '../schema';

/** Get-or-create the sync row for a channel (state starts 'never'). */
export async function ensureChannelSync(
  db: Database,
  guildId: string,
  channelId: string,
  kind: ThreadKind,
): Promise<ChannelSync> {
  await db
    .insert(channelSync)
    .values({ guildId, channelId, kind })
    .onConflictDoNothing({ target: [channelSync.guildId, channelSync.channelId] });
  const row = await getChannelSync(db, guildId, channelId);
  if (!row) throw new Error('ensureChannelSync: row missing after upsert');
  return row;
}

export async function getChannelSync(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<ChannelSync | undefined> {
  const [row] = await db
    .select()
    .from(channelSync)
    .where(and(eq(channelSync.guildId, guildId), eq(channelSync.channelId, channelId)))
    .limit(1);
  return row;
}

export async function listChannelSync(db: Database, guildId: string): Promise<ChannelSync[]> {
  return db.select().from(channelSync).where(eq(channelSync.guildId, guildId));
}

export async function deleteChannelSync(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<void> {
  await db
    .delete(channelSync)
    .where(and(eq(channelSync.guildId, guildId), eq(channelSync.channelId, channelId)));
}

/**
 * Mark a channel up to date (capture path). Per-channel captures are debounced and
 * serialized, so a simple last-write-wins watermark is safe. `newestMessageId` is the
 * newest message folded in this run (null leaves the existing watermark).
 */
export async function markChannelSynced(
  db: Database,
  guildId: string,
  channelId: string,
  kind: ThreadKind,
  newestMessageId: string | null,
  indexedMessageCount: number,
): Promise<void> {
  await db
    .insert(channelSync)
    .values({
      guildId,
      channelId,
      kind,
      state: 'synced',
      lastIndexedMessageId: newestMessageId ?? null,
      indexedMessageCount,
    })
    .onConflictDoUpdate({
      target: [channelSync.guildId, channelSync.channelId],
      set: {
        state: 'synced',
        staleReason: null,
        indexedMessageCount,
        ...(newestMessageId ? { lastIndexedMessageId: newestMessageId } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Flag a channel as behind reality, unless a reindex is already running. */
export async function markChannelStale(
  db: Database,
  guildId: string,
  channelId: string,
  kind: ThreadKind,
  reason: string,
): Promise<void> {
  await db
    .insert(channelSync)
    .values({ guildId, channelId, kind, state: 'stale', staleReason: reason })
    .onConflictDoUpdate({
      target: [channelSync.guildId, channelSync.channelId],
      set: {
        // Don't clobber an in-flight reindex.
        state: sql`case when ${channelSync.state} = 'reindexing' then ${channelSync.state} else 'stale' end`,
        staleReason: reason,
        updatedAt: new Date(),
      },
    });
}

/**
 * Race-free throttle for auto-reindex: atomically flip to 'reindexing' and stamp
 * lastReindexAt ONLY if no reindex is in flight and the last one is older than
 * throttleMs. Returns true if this caller won the claim. The row must already exist
 * (ensureChannelSync first).
 */
export async function claimReindex(
  db: Database,
  guildId: string,
  channelId: string,
  throttleMs: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - throttleMs);
  const rows = await db
    .update(channelSync)
    .set({ state: 'reindexing', lastReindexAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(channelSync.guildId, guildId),
        eq(channelSync.channelId, channelId),
        ne(channelSync.state, 'reindexing'),
        or(isNull(channelSync.lastReindexAt), lt(channelSync.lastReindexAt, cutoff)),
      ),
    )
    .returning({ id: channelSync.id });
  return rows.length > 0;
}

/** Force state to 'reindexing' (the explicit /dejavue reindex command path). */
export async function setReindexing(
  db: Database,
  guildId: string,
  channelId: string,
  kind: ThreadKind,
): Promise<void> {
  await db
    .insert(channelSync)
    .values({ guildId, channelId, kind, state: 'reindexing', lastReindexAt: new Date() })
    .onConflictDoUpdate({
      target: [channelSync.guildId, channelSync.channelId],
      set: { state: 'reindexing', lastReindexAt: new Date(), updatedAt: new Date() },
    });
}

/**
 * Finalize a FAILED reindex: force the channel out of 'reindexing' to 'stale' so it isn't
 * stuck showing "re-scanning…" forever and can be retried. This is the reindex's OWN
 * terminal outcome (it set 'reindexing'), so — unlike {@link markChannelStale}, which
 * deliberately won't clobber an in-flight reindex from a live-capture race — it must win.
 * A bare UPDATE, like {@link completeReindex}; the row exists (setReindexing created it).
 */
export async function failReindex(
  db: Database,
  guildId: string,
  channelId: string,
  reason: string,
): Promise<void> {
  await db
    .update(channelSync)
    .set({ state: 'stale', staleReason: reason, updatedAt: new Date() })
    .where(and(eq(channelSync.guildId, guildId), eq(channelSync.channelId, channelId)));
}

/** Finalize a completed reindex: synced + watermark proof + fresh counts. */
export async function completeReindex(
  db: Database,
  guildId: string,
  channelId: string,
  opts: { indexedMessageCount: number; lastIndexedMessageId: string | null },
): Promise<void> {
  await db
    .update(channelSync)
    .set({
      state: 'synced',
      staleReason: null,
      indexedMessageCount: opts.indexedMessageCount,
      lastReindexAt: new Date(),
      lastReindexThrough: opts.lastIndexedMessageId,
      ...(opts.lastIndexedMessageId ? { lastIndexedMessageId: opts.lastIndexedMessageId } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(channelSync.guildId, guildId), eq(channelSync.channelId, channelId)));
}
