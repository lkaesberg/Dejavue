import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import {
  addForumChannel,
  addTrackedChannel,
  forgetDeletedChannel,
  removeMonitoredChannel,
  setChannelGuidelines,
} from './guilds';

function recordingDb(rows: unknown[][][] = []): { db: Database; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (sql, params) => {
      queries.push({ sql, params });
      return { rows: (rows.shift() ?? []) as never };
    },
    { schema },
  ) as unknown as Database;
  return { db, queries };
}

describe('channel membership writes', () => {
  it('adds a forum element-wise and re-checks the cap in the same UPDATE', async () => {
    const { db, queries } = recordingDb([[['g']]]);
    expect(await addForumChannel(db, 'g', 'f1', { mode: 'knowledge', cap: 3, solvedTagId: 's' })).toBe(true);
    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/^update "guild_config" set/);
    expect(sql).toContain('array_append("guild_config"."forum_channel_ids", $');
    expect(sql).toContain('"guild_config"."channel_modes" || jsonb_build_object($');
    expect(sql).toContain('cardinality("guild_config"."forum_channel_ids") < $');
    expect(sql).toContain('"solved_tag_id" = $');
    expect(sql).not.toContain('"unsolved_tag_id"');
    expect(params).toEqual(expect.arrayContaining(['f1', 'knowledge', 3, 's']));
  });

  it('reports a cap refusal when no row was updated', async () => {
    const { db } = recordingDb([[]]);
    expect(await addTrackedChannel(db, 'g', 'c1', 1)).toBe(false);
  });

  it('has no cap bound for unlimited plans', async () => {
    const { db, queries } = recordingDb([[['g']]]);
    await addTrackedChannel(db, 'g', 'c1', Number.POSITIVE_INFINITY);
    expect(queries[0]!.sql).not.toContain('cardinality');
    expect(queries[0]!.params).not.toContain(Number.POSITIVE_INFINITY);
  });

  it('removes a channel element-wise from both arrays and its mode', async () => {
    const { db, queries } = recordingDb();
    await removeMonitoredChannel(db, 'g', 'c1');
    const { sql } = queries[0]!;
    expect(sql).toContain('array_remove("guild_config"."forum_channel_ids", $');
    expect(sql).toContain('array_remove("guild_config"."tracked_channel_ids", $');
    expect(sql).toContain('"guild_config"."channel_modes" - $');
    expect(sql).not.toContain('channel_guidelines');
  });

  it('unmonitors a deleted channel before purging its threads', async () => {
    const { db, queries } = recordingDb();
    await forgetDeletedChannel(db, 'g', 'c1');
    expect(queries[0]!.sql).toMatch(/^update "guild_config"/);
    expect(queries[0]!.sql).toContain('"guild_config"."channel_guidelines" - $');
    expect(queries.slice(1).some((q) => q.sql.startsWith('delete from "thread"'))).toBe(true);
    expect(queries.some((q) => q.sql.startsWith('select'))).toBe(false);
  });

  it('writes guidelines per key, without reading the map first', async () => {
    const { db, queries } = recordingDb();
    await setChannelGuidelines(db, 'g', 'c1', '  be nice ');
    await setChannelGuidelines(db, 'g', 'c1', '');
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain('jsonb_build_object($');
    expect(queries[0]!.params).toContain('be nice');
    expect(queries[1]!.sql).toContain('"guild_config"."channel_guidelines" - $');
  });
});
