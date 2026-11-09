import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { getStaleUnansweredThreads, nudgeableChannelIds } from './nudges';
import { setThreadStatus } from './threads';

function recordingDb(): { db: Database; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  ) as unknown as Database;
  return { db, queries };
}

describe('stale-question nudges', () => {
  it('only nudges question-mode forums that are still monitored', () => {
    expect(
      nudgeableChannelIds({ forumChannelIds: ['q1', 'k1', 'q2'], channelModes: { k1: 'knowledge', q2: 'question' } }),
    ).toEqual(['q1', 'q2']);
  });

  it('skips the query when no channel is nudgeable', async () => {
    const { db, queries } = recordingDb();
    expect(await getStaleUnansweredThreads(db, 'g', [], 24)).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('selects forum posts in the given channels, oldest first', async () => {
    const { db, queries } = recordingDb();
    await getStaleUnansweredThreads(db, 'g', ['q1', 'q2'], 24);
    const { sql, params } = queries[0]!;
    expect(sql).toContain('"thread"."kind" = $');
    expect(params).toContain('forum');
    expect(sql).toContain('"thread"."channel_id" in ($');
    expect(params).toEqual(expect.arrayContaining(['q1', 'q2']));
    expect(sql).toContain('"thread"."last_nudged_at" is null');
    expect(sql).toMatch(/order by "thread"\."created_at" asc limit/);
  });

  it('re-arms the nudge only when a solved post is reopened', async () => {
    const { db, queries } = recordingDb();
    await setThreadStatus(db, 'g', 't', 'unsolved');
    expect(queries[0]!.sql).toContain(
      `"last_nudged_at" = case when "thread"."status" = 'solved' then null else "thread"."last_nudged_at" end`,
    );
  });
});
