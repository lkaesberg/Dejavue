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
 *
 * Never overrides an in-flight reindex: the reindex job owns 'reindexing' and settles it
 * itself ({@link completeReindex} / {@link failReindex}), so a live capture that lands
 * mid-run must not flip the channel to 'synced' underneath it.
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
      setWhere: ne(channelSync.state, 'reindexing'),
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
        // Don't clobber an in-flight reindex — and keep its reason too, so a 'reindexing'
        // row never carries a stale reason the state doesn't show.
        state: sql`case when ${channelSync.state} = 'reindexing' then ${channelSync.state} else 'stale' end`,
        staleReason: sql`case when ${channelSync.state} = 'reindexing' then ${channelSync.staleReason} else ${reason} end`,
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

/**
 * Release a reindex claim that won't complete: 'reindexing' → 'stale' so the channel
 * isn't stuck showing "re-scanning…" forever and can be retried. Used by the job's own
 * failure path, by the trigger when it can't create/enqueue the job after
 * {@link claimReindex}, and by the stale-job sweeper. Unlike {@link markChannelStale}
 * (which deliberately won't clobber an in-flight reindex) this is the claim owner
 * letting go. Guarded on 'reindexing' so it never resurrects or overwrites anything else.
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
    .where(
      and(
        eq(channelSync.guildId, guildId),
        eq(channelSync.channelId, channelId),
        eq(channelSync.state, 'reindexing'),
      ),
    );
}

/**
 * Finalize a completed full scan: synced + watermark proof + fresh counts. A scan that
 * stopped adding new content at the index cap (`capped`) lands on stale 'cap' instead —
 * the channel is NOT fully indexed, and claiming 'synced' would hide the "index full"
 * warning. Likewise a scan where some threads could not be indexed (`failed` > 0) lands
 * on stale 'partial', so the hub asks for a re-scan instead of showing "up to date".
 */
export async function completeReindex(
  db: Database,
  guildId: string,
  channelId: string,
  opts: {
    indexedMessageCount: number;
    lastIndexedMessageId: string | null;
    capped?: boolean;
    failed?: number;
  },
): Promise<void> {
  const staleReason = opts.capped ? 'cap' : (opts.failed ?? 0) > 0 ? 'partial' : null;
  await db
    .update(channelSync)
    .set({
      state: staleReason ? 'stale' : 'synced',
      staleReason,
      indexedMessageCount: opts.indexedMessageCount,
      lastReindexAt: new Date(),
      lastReindexThrough: opts.lastIndexedMessageId,
      ...(opts.lastIndexedMessageId ? { lastIndexedMessageId: opts.lastIndexedMessageId } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(channelSync.guildId, guildId), eq(channelSync.channelId, channelId)));
}
