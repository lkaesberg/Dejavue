import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { guildConfig, type GuildConfig, type NewGuildConfig } from '../schema';
import { deleteChannelSync } from './channelSync';
import { deleteChannelTopic } from './channelTopics';
import { deleteThreadsByChannel } from './threads';

export type ChannelMode = 'question' | 'knowledge';

/**
 * Resolve a forum channel's mode. 'knowledge' channels are a pure archive (every
 * thread published, no answer-prompting/dedup); everything else is 'question'
 * (the classic Q&A workflow). Defaults to 'question' when unset.
 */
export function channelMode(
  cfg: Pick<GuildConfig, 'channelModes'> | null | undefined,
  channelId: string,
): ChannelMode {
  return cfg?.channelModes?.[channelId] === 'knowledge' ? 'knowledge' : 'question';
}

/** A channel's forum post-guidelines (its Discord topic), kept in sync. */
export function channelGuidelinesOf(
  cfg: Pick<GuildConfig, 'channelGuidelines'> | null | undefined,
  channelId: string,
): string | undefined {
  return cfg?.channelGuidelines?.[channelId] || undefined;
}

/**
 * Store (or clear, when empty) a channel's forum post-guidelines. One key-level jsonb
 * write, so concurrent edits for different channels can't drop each other.
 */
export async function setChannelGuidelines(
  db: Database,
  guildId: string,
  channelId: string,
  guidelines: string | null,
): Promise<void> {
  const trimmed = guidelines?.trim();
  await db
    .update(guildConfig)
    .set({
      channelGuidelines: trimmed
        ? sql`${guildConfig.channelGuidelines} || jsonb_build_object(${channelId}::text, ${trimmed}::text)`
        : sql`${guildConfig.channelGuidelines} - ${channelId}::text`,
      updatedAt: new Date(),
    })
    .where(eq(guildConfig.guildId, guildId));
}

// ---------------------------------------------------------------------------
// Channel membership. guild_config keeps the monitored channels as arrays plus the
// channel_modes map; every add/remove is a single element-level UPDATE (array_append /
// array_remove, jsonb || / -), never a read-modify-write of the whole array, so two
// concurrent setups, or a setup racing a removal, can't drop or resurrect a channel.
// ---------------------------------------------------------------------------

/** `channelId` is already in `col`, or `col` is under `cap` (no bound when infinite). */
function roomFor(
  col: typeof guildConfig.forumChannelIds | typeof guildConfig.trackedChannelIds,
  channelId: string,
  cap: number,
): SQL {
  if (!Number.isFinite(cap)) return sql`true`;
  return sql`(${channelId}::text = any(${col}) or cardinality(${col}) < ${Math.max(0, Math.trunc(cap))})`;
}

/**
 * Add (or re-mode) a monitored forum channel, refusing a new one past `cap`. Returns
 * false when the cap refused it (or the guild has no config row).
 */
export async function addForumChannel(
  db: Database,
  guildId: string,
  channelId: string,
  opts: {
    mode: ChannelMode;
    cap: number;
    solvedTagId?: string | null;
    unsolvedTagId?: string | null;
  },
): Promise<boolean> {
  const tags: { solvedTagId?: string | null; unsolvedTagId?: string | null } = {};
  if (opts.solvedTagId !== undefined) tags.solvedTagId = opts.solvedTagId;
  if (opts.unsolvedTagId !== undefined) tags.unsolvedTagId = opts.unsolvedTagId;
  const rows = await db
    .update(guildConfig)
    .set({
      forumChannelIds: sql`case when ${channelId}::text = any(${guildConfig.forumChannelIds}) then ${guildConfig.forumChannelIds} else array_append(${guildConfig.forumChannelIds}, ${channelId}::text) end`,
      channelModes: sql`${guildConfig.channelModes} || jsonb_build_object(${channelId}::text, ${opts.mode}::text)`,
      ...tags,
      updatedAt: new Date(),
    })
    .where(and(eq(guildConfig.guildId, guildId), roomFor(guildConfig.forumChannelIds, channelId, opts.cap)))
    .returning({ guildId: guildConfig.guildId });
  return rows.length > 0;
}

/** Add a tracked normal channel, refusing a new one past `cap`. False when refused. */
export async function addTrackedChannel(
  db: Database,
  guildId: string,
  channelId: string,
  cap: number,
): Promise<boolean> {
  const rows = await db
    .update(guildConfig)
    .set({
      trackedChannelIds: sql`case when ${channelId}::text = any(${guildConfig.trackedChannelIds}) then ${guildConfig.trackedChannelIds} else array_append(${guildConfig.trackedChannelIds}, ${channelId}::text) end`,
      updatedAt: new Date(),
    })
    .where(and(eq(guildConfig.guildId, guildId), roomFor(guildConfig.trackedChannelIds, channelId, cap)))
    .returning({ guildId: guildConfig.guildId });
  return rows.length > 0;
}

/**
 * Stop monitoring a channel (forum or tracked): drop it from both arrays and its mode,
 * and its guidelines when `dropGuidelines`. A no-op when it isn't monitored. In-flight
 * backfill/reindex jobs notice at their next check (ChannelUnmonitoredError) and stop
 * without recreating channel_sync; their row writes go through whileChannelMonitored,
 * so none lands after this commits.
 */
export async function removeMonitoredChannel(
  db: Database,
  guildId: string,
  channelId: string,
  opts: { dropGuidelines?: boolean } = {},
): Promise<void> {
  await db
    .update(guildConfig)
    .set({
      forumChannelIds: sql`array_remove(${guildConfig.forumChannelIds}, ${channelId}::text)`,
      trackedChannelIds: sql`array_remove(${guildConfig.trackedChannelIds}, ${channelId}::text)`,
      channelModes: sql`${guildConfig.channelModes} - ${channelId}::text`,
      ...(opts.dropGuidelines
        ? { channelGuidelines: sql`${guildConfig.channelGuidelines} - ${channelId}::text` }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guildConfig.guildId, guildId),
        or(
          sql`${channelId}::text = any(${guildConfig.forumChannelIds})`,
          sql`${channelId}::text = any(${guildConfig.trackedChannelIds})`,
        ),
      ),
    );
}

/**
 * Run `fn` only while `channelId` is still monitored (as a forum or tracked channel),
 * atomically with that check: the guild_config row is held FOR SHARE for the duration,
 * so removeMonitoredChannel (an UPDATE of that row) waits for `fn` to commit, and a
 * write that starts after the removal sees it and is skipped. Returns undefined when
 * the channel is no longer monitored. Keep `fn` to a few quick statements — it holds
 * the lock — and run them on the `tx` it is given.
 */
export async function whileChannelMonitored<T>(
  db: Database,
  guildId: string,
  channelId: string,
  kind: 'forum' | 'tracked',
  fn: (tx: Database) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const [cfg] = await tx
      .select({ forum: guildConfig.forumChannelIds, tracked: guildConfig.trackedChannelIds })
      .from(guildConfig)
      .where(eq(guildConfig.guildId, guildId))
      .for('share');
    const ids = kind === 'forum' ? cfg?.forum : cfg?.tracked;
    if (!ids?.includes(channelId)) return undefined;
    return fn(tx as unknown as Database);
  });
}

export async function getGuildConfig(
  db: Database,
  guildId: string,
): Promise<GuildConfig | undefined> {
  const [row] = await db
    .select()
    .from(guildConfig)
    .where(eq(guildConfig.guildId, guildId))
    .limit(1);
  return row;
}

/** Get-or-create the config row for a guild. */
export async function ensureGuildConfig(db: Database, guildId: string): Promise<GuildConfig> {
  const [inserted] = await db
    .insert(guildConfig)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const existing = await getGuildConfig(db, guildId);
  if (!existing) throw new Error(`failed to ensure guild config for ${guildId}`);
  return existing;
}

/**
 * A channel was deleted in Discord: drop its archived threads (embeddings cascade), its
 * sync and topic state, and stop watching it. Shared by the bot's channelDelete handler
 * and the worker's rescan, which is the first to notice when the channel went while the
 * bot was offline. Returns how many threads were removed.
 */
export async function forgetDeletedChannel(
  db: Database,
  guildId: string,
  channelId: string,
): Promise<number> {
  // Unmonitor first, so an in-flight backfill/reindex stops at its next checkpoint
  // instead of re-indexing threads into the channel being purged.
  await removeMonitoredChannel(db, guildId, channelId, { dropGuidelines: true });
  const removed = await deleteThreadsByChannel(db, guildId, channelId);
  await deleteChannelTopic(db, guildId, channelId);
  await deleteChannelSync(db, guildId, channelId);
  return removed;
}

export async function updateGuildConfig(
  db: Database,
  guildId: string,
  patch: Partial<Omit<NewGuildConfig, 'guildId' | 'createdAt'>>,
): Promise<GuildConfig | undefined> {
  const [row] = await db
    .update(guildConfig)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(guildConfig.guildId, guildId))
    .returning();
  return row;
}

/**
 * Compare-and-set guild_config.last_tier: moves it from `from` to `to` only if it
 * still holds `from` (NULL-safe). Returns whether this caller won the transition —
 * concurrent entitlement events / reconcile racing on the same upgrade see false and
 * must not act on it.
 */
export async function swapLastTier(
  db: Database,
  guildId: string,
  from: string | null,
  to: string | null,
): Promise<boolean> {
  const rows = await db
    .update(guildConfig)
    .set({ lastTier: to, updatedAt: new Date() })
    .where(
      and(
        eq(guildConfig.guildId, guildId),
        from === null ? isNull(guildConfig.lastTier) : eq(guildConfig.lastTier, from),
      ),
    )
    .returning({ guildId: guildConfig.guildId });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Generative run state — lets the gaps/faq commands dedupe in-flight runs and
// show progress + freshness instead of re-triggering work on every invocation.
// ---------------------------------------------------------------------------

export type GenFeature = 'cluster' | 'faq';

/** One feature's stored run timestamps (epoch ms). `failed` is set by the worker when
 *  an attempt throws; `finished` only on success. */
export interface GenRun {
  started?: number;
  finished?: number;
  failed?: number;
}

export interface GenStatus {
  /** A run was requested and the worker hasn't reported finishing (or failing) it yet. */
  inFlight: boolean;
  /** A run finished recently enough that a re-run should just show the result. */
  fresh: boolean;
  startedAt?: number;
  finishedAt?: number;
}

/** Derive a feature's generation status from the stored run timestamps. */
export function generationStatus(
  cfg: Pick<GuildConfig, 'genRuns'> | null | undefined,
  feature: GenFeature,
  opts: { throttleMs: number; maxRunMs: number },
  now = Date.now(),
): GenStatus {
  const run: GenRun = cfg?.genRuns?.[feature] ?? {};
  const started = run.started;
  const finished = run.finished;
  const failed = run.failed;
  const inFlight =
    typeof started === 'number' &&
    (typeof finished !== 'number' || started > finished) &&
    (typeof failed !== 'number' || started > failed) &&
    now - started < opts.maxRunMs;
  const fresh = typeof finished === 'number' && now - finished < opts.throttleMs;
  return { inFlight, fresh, startedAt: started, finishedAt: finished };
}

/**
 * Merge `patch` into ONE feature's entry in a single UPDATE (jsonb `||`), so a cluster
 * finish and a concurrent faq start can't overwrite each other's key.
 */
async function patchGenRun(db: Database, guildId: string, feature: GenFeature, patch: GenRun): Promise<void> {
  await db
    .update(guildConfig)
    .set({
      genRuns: sql`${guildConfig.genRuns} || jsonb_build_object(${feature}::text, coalesce(${guildConfig.genRuns} -> ${feature}::text, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(guildConfig.guildId, guildId));
}

/**
 * Command-side: start a run only if none is in flight or fresh. Compare-and-set on the
 * feature's entry as it was read, so two concurrent commands can't both start (and
 * enqueue) a run — the loser gets false and should show the existing result instead.
 */
export async function tryStartGeneration(
  db: Database,
  guildId: string,
  feature: GenFeature,
  opts: { throttleMs: number; maxRunMs: number },
  now = Date.now(),
): Promise<boolean> {
  const cfg = await getGuildConfig(db, guildId);
  if (!cfg) return false;
  const st = generationStatus(cfg, feature, opts, now);
  if (st.inFlight || st.fresh) return false;
  const prev = cfg.genRuns?.[feature];
  const next: GenRun = { started: now, ...(prev?.finished !== undefined ? { finished: prev.finished } : {}) };
  const rows = await db
    .update(guildConfig)
    .set({
      genRuns: sql`${guildConfig.genRuns} || jsonb_build_object(${feature}::text, ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guildConfig.guildId, guildId),
        prev === undefined
          ? sql`(${guildConfig.genRuns} -> ${feature}::text) is null`
          : sql`(${guildConfig.genRuns} -> ${feature}::text) = ${JSON.stringify(prev)}::jsonb`,
      ),
    )
    .returning({ guildId: guildConfig.guildId });
  return rows.length > 0;
}

/** Worker-side: an attempt (first run or a pg-boss retry) is executing now. Re-arms
 *  the in-flight window so a retry after a failure shows as running again. */
export function markGenerationRunning(db: Database, guildId: string, feature: GenFeature): Promise<void> {
  return patchGenRun(db, guildId, feature, { started: Date.now() });
}

/** Mark that a generation run finished (worker-side, any trigger). */
export function markGenerationFinished(db: Database, guildId: string, feature: GenFeature): Promise<void> {
  return patchGenRun(db, guildId, feature, { finished: Date.now() });
}

/** Mark that a generation attempt threw (worker-side): ends in-flight without making
 *  the result look fresh, so the next command can start a new run. */
export function markGenerationFailed(db: Database, guildId: string, feature: GenFeature): Promise<void> {
  return patchGenRun(db, guildId, feature, { failed: Date.now() });
}
