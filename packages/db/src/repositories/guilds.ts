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
 * backfill/reindex jobs notice at their next checkpoint (ChannelUnmonitoredError) and
 * stop without recreating channel_sync.
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

export interface GenStatus {
  /** A run was requested and the worker hasn't reported finishing it yet. */
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
  const run = cfg?.genRuns?.[feature] ?? {};
  const started = run.started;
  const finished = run.finished;
  const inFlight =
    typeof started === 'number' &&
    (typeof finished !== 'number' || started > finished) &&
    now - started < opts.maxRunMs;
  const fresh = typeof finished === 'number' && now - finished < opts.throttleMs;
  return { inFlight, fresh, startedAt: started, finishedAt: finished };
}

async function patchGenRun(
  db: Database,
  guildId: string,
  feature: GenFeature,
  patch: { started?: number; finished?: number },
): Promise<void> {
  const cfg = await getGuildConfig(db, guildId);
  if (!cfg) return;
  const runs = { ...(cfg.genRuns ?? {}) };
  runs[feature] = { ...(runs[feature] ?? {}), ...patch };
  await db
    .update(guildConfig)
    .set({ genRuns: runs, updatedAt: new Date() })
    .where(eq(guildConfig.guildId, guildId));
}

/** Mark that a generation run was just requested (command-side). */
export function markGenerationStarted(db: Database, guildId: string, feature: GenFeature): Promise<void> {
  return patchGenRun(db, guildId, feature, { started: Date.now() });
}

/** Mark that a generation run finished (worker-side, any trigger). */
export function markGenerationFinished(db: Database, guildId: string, feature: GenFeature): Promise<void> {
  return patchGenRun(db, guildId, feature, { finished: Date.now() });
}
