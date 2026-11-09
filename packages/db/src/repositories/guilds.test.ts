import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { generationStatus, markGenerationFailed, markGenerationFinished, tryStartGeneration } from './guilds';

const OPTS = { throttleMs: 5 * 60_000, maxRunMs: 5 * 60_000 };
const NOW = 1_000_000_000;
const cfg = (run: { started?: number; finished?: number }) => ({ genRuns: { cluster: run } });

describe('generationStatus', () => {
  it('reports neither in-flight nor fresh when never run', () => {
    expect(generationStatus(null, 'cluster', OPTS, NOW)).toEqual({
      inFlight: false,
      fresh: false,
      startedAt: undefined,
      finishedAt: undefined,
    });
  });

  it('is in-flight after a recent start with no finish', () => {
    const st = generationStatus(cfg({ started: NOW - 10_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(true);
    expect(st.fresh).toBe(false);
  });

  it('is fresh (not in-flight) after a recent finish', () => {
    const st = generationStatus(cfg({ started: NOW - 60_000, finished: NOW - 30_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(false);
    expect(st.fresh).toBe(true);
  });

  it('is in-flight again when a new run started after the last finish', () => {
    const st = generationStatus(cfg({ started: NOW - 10_000, finished: NOW - 60_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(true);
  });

  it('stops treating a stuck run as in-flight past maxRunMs', () => {
    const st = generationStatus(cfg({ started: NOW - 6 * 60_000 }), 'cluster', OPTS, NOW);
    expect(st.inFlight).toBe(false);
  });

  it('is stale (not fresh) once the throttle window passes', () => {
    const st = generationStatus(cfg({ started: NOW - 7 * 60_000, finished: NOW - 6 * 60_000 }), 'cluster', OPTS, NOW);
    expect(st.fresh).toBe(false);
    expect(st.inFlight).toBe(false);
  });
});

describe('generationStatus after a failure', () => {
  it('a failed attempt ends in-flight without making the result fresh', () => {
    const st = generationStatus(
      { genRuns: { cluster: { started: NOW - 20_000, failed: NOW - 10_000 } } },
      'cluster',
      OPTS,
      NOW,
    );
    expect(st.inFlight).toBe(false);
    expect(st.fresh).toBe(false);
  });

  it('a retry after a failure is in flight again', () => {
    const st = generationStatus(
      { genRuns: { cluster: { started: NOW - 5_000, failed: NOW - 10_000 } } },
      'cluster',
      OPTS,
      NOW,
    );
    expect(st.inFlight).toBe(true);
  });
});

/** A database that records each statement; selects return `selectRow` (if any). */
function recordingDb(selectRow?: Record<string, unknown>): {
  db: Database;
  queries: { sql: string; params: unknown[] }[];
} {
  const queries: { sql: string; params: unknown[] }[] = [];
  const cols = Object.keys(getTableColumns(schema.guildConfig));
  const db = drizzle(
    async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('select') && selectRow) return { rows: [cols.map((c) => selectRow[c] ?? null)] };
      return { rows: [] };
    },
    { schema },
  ) as unknown as Database;
  return { db, queries };
}

describe('generation run writes', () => {
  it('merges one feature key in a single UPDATE (no read-modify-write of the map)', async () => {
    const { db, queries } = recordingDb();
    await markGenerationFinished(db, 'g1', 'cluster');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/^update "guild_config" set "gen_runs" = "guild_config"\."gen_runs" \|\| jsonb_build_object/);
    expect(queries[0]!.params).toContain('cluster');
  });

  it('records failures the same way', async () => {
    const { db, queries } = recordingDb();
    await markGenerationFailed(db, 'g1', 'faq');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.params.some((p) => typeof p === 'string' && p.includes('"failed"'))).toBe(true);
  });

  it('starts a run by compare-and-set on the entry it read', async () => {
    const prev = { started: NOW - 20 * 60_000, finished: NOW - 19 * 60_000 };
    const { db, queries } = recordingDb({ guildId: 'g1', genRuns: { cluster: prev, faq: {} } });
    // The recording DB returns no rows for the UPDATE: the CAS lost.
    expect(await tryStartGeneration(db, 'g1', 'cluster', OPTS, NOW)).toBe(false);
    const update = queries.at(-1)!;
    expect(update.sql).toMatch(/^update "guild_config"/);
    expect(update.sql).toContain('("guild_config"."gen_runs" -> $');
    expect(update.sql).toMatch(/\) = \$\d+::jsonb/);
    expect(update.params).toContain(JSON.stringify(prev));
    expect(update.params).toContain(JSON.stringify({ started: NOW, finished: prev.finished }));
  });

  it('does not write when a run is already in flight', async () => {
    const { db, queries } = recordingDb({ guildId: 'g1', genRuns: { cluster: { started: NOW - 60_000 } } });
    expect(await tryStartGeneration(db, 'g1', 'cluster', OPTS, NOW)).toBe(false);
    expect(queries.every((q) => q.sql.startsWith('select'))).toBe(true);
  });

  it('guards a never-run feature on the key being absent', async () => {
    const { db, queries } = recordingDb({ guildId: 'g1', genRuns: {} });
    await tryStartGeneration(db, 'g1', 'faq', OPTS, NOW);
    expect(queries.at(-1)!.sql).toMatch(/-> \$\d+::text\) is null/);
  });
});
