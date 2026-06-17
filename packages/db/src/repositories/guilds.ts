import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import { guildConfig, type GuildConfig, type NewGuildConfig } from '../schema';

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

/** Store (or clear, when empty) a channel's forum post-guidelines. */
export async function setChannelGuidelines(
  db: Database,
  guildId: string,
  channelId: string,
  guidelines: string | null,
): Promise<void> {
  const cfg = await getGuildConfig(db, guildId);
  if (!cfg) return;
  const map = { ...(cfg.channelGuidelines ?? {}) };
  const trimmed = guidelines?.trim();
  if (trimmed) map[channelId] = trimmed;
  else delete map[channelId];
  await db
    .update(guildConfig)
    .set({ channelGuidelines: map, updatedAt: new Date() })
    .where(eq(guildConfig.guildId, guildId));
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
