import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { claimBackfillJob, getOtherActiveBackfillJob, transitionBackfillJob, updateBackfillJob } from './backfill';
import { completeReindex, failReindex, markChannelStale, markChannelSynced } from './channelSync';
import {
  claimReindexJob,
  heartbeatReindexJob,
  sweepStaleReindexJobs,
  transitionReindexJob,
  updateReindexJob,
} from './reindex';

/** A database that records each statement instead of running it. */
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

const last = (q: { sql: string }[]): string => q.at(-1)?.sql ?? '';

describe('reindex_job transitions', () => {
  it('claims only a pending row or a running row with an expired lease', async () => {
    const { db, queries } = recordingDb();
    expect(await claimReindexJob(db, 'job-1', 180_000)).toBeUndefined();
    const sql = last(queries);
    expect(sql).toMatch(/^update "reindex_job" set "status" = \$1/);
    expect(sql).toContain('"reindex_job"."status" = $');
    expect(sql).toContain('"reindex_job"."updated_at" < $');
    expect(queries.at(-1)?.params).toContain('pending');
    expect(queries.at(-1)?.params).toContain('running');
    expect(queries.at(-1)?.params).not.toContain('failed');
  });

  it('guards every status change on the allowed from-states', async () => {
    const { db, queries } = recordingDb();
    expect(await transitionReindexJob(db, 'job-1', ['running'], 'completed', { phase: 'done' })).toBe(false);
    expect(last(queries)).toMatch(/where \("reindex_job"\."id" = \$\d+ and "reindex_job"\."status" in \(\$\d+\)\)/);
    expect(queries.at(-1)?.params).toEqual(expect.arrayContaining(['completed', 'done', 'job-1', 'running']));
  });

  it('only lets a running job take progress or heartbeats', async () => {
    const { db, queries } = recordingDb();
    await updateReindexJob(db, 'job-1', { processed: 5 });
    expect(last(queries)).toContain('"reindex_job"."status" = $');
    expect(queries.at(-1)?.params).toContain('running');
    expect(await heartbeatReindexJob(db, 'job-1')).toBe(false);
    expect(last(queries)).toContain('"reindex_job"."status" = $');
  });

  it('sweeps stale running and pending rows to failed', async () => {
    const { db, queries } = recordingDb();
    await sweepStaleReindexJobs(db, { runningStaleMs: 1, pendingStaleMs: 2 });
    const { sql, params } = queries.at(-1)!;
    expect(sql).toMatch(/^update "reindex_job" set "status" = \$1, "updated_at" = now\(\)/);
    expect(params[0]).toBe('failed');
    expect(params).toEqual(expect.arrayContaining(['running', 'pending']));
  });
});

describe('backfill_job transitions', () => {
  it('claims pending/failed/expired rows only while no other import of the channel is live', async () => {
    const { db, queries } = recordingDb();
    expect(await claimBackfillJob(db, 'job-1', 180_000)).toBeUndefined();
    const { sql, params } = queries.at(-1)!;
    expect(sql).toContain('"backfill_job"."status" in ($');
    expect(sql).toContain('not exists');
    expect(sql).toContain('from "backfill_job" as other');
    expect(sql).toContain('other.channel_id = "backfill_job"."channel_id"');
    expect(sql).toContain("other.status = 'running'");
    expect(params).toEqual(expect.arrayContaining(['pending', 'failed', 'running']));
  });

  it('guards status changes and progress writes', async () => {
    const { db, queries } = recordingDb();
    expect(await transitionBackfillJob(db, 'job-1', ['pending', 'failed'], 'failed')).toBe(false);
    expect(last(queries)).toContain('"backfill_job"."status" in ($');
    await updateBackfillJob(db, 'job-1', { processed: 3 });
    expect(last(queries)).toContain('"backfill_job"."status" = $');
  });

  it('lets only an older pending or a running import win over a duplicate', async () => {
    const { db, queries } = recordingDb();
    await getOtherActiveBackfillJob(db, { id: 'b', guildId: 'g', channelId: 'c', createdAt: new Date(0) });
    const sql = last(queries);
    expect(sql).toContain('"backfill_job"."created_at" < $');
    expect(sql).toContain('"backfill_job"."id" < $');
  });
});

describe('channel_sync writers', () => {
  it('never lets a live capture flip an in-flight reindex to synced', async () => {
    const { db, queries } = recordingDb();
    await markChannelSynced(db, 'g', 'c', 'channel', null, 3);
    expect(last(queries)).toMatch(/on conflict .* do update set .* where "channel_sync"\."state" <> \$\d+/);
    expect(queries.at(-1)?.params).toContain('reindexing');
  });

  it('keeps the existing reason on a reindexing row when marking stale', async () => {
    const { db, queries } = recordingDb();
    await markChannelStale(db, 'g', 'c', 'channel', 'gap');
    const sql = last(queries);
    expect(sql).toContain(`"stale_reason" = case when "channel_sync"."state" = 'reindexing' then "channel_sync"."stale_reason" else`);
  });

  it('releases a claim only while the channel is still reindexing', async () => {
    const { db, queries } = recordingDb();
    await failReindex(db, 'g', 'c', 'reindex failed');
    expect(last(queries)).toContain('"channel_sync"."state" = $');
    expect(queries.at(-1)?.params).toEqual(['stale', 'reindex failed', expect.any(String), 'g', 'c', 'reindexing']);
  });

  it('lands a capped full scan on stale cap instead of synced', async () => {
    const { db, queries } = recordingDb();
    await completeReindex(db, 'g', 'c', { indexedMessageCount: 1, lastIndexedMessageId: null, capped: true });
    expect(queries.at(-1)?.params[0]).toBe('stale');
    expect(queries.at(-1)?.params).toContain('cap');
    await completeReindex(db, 'g', 'c', { indexedMessageCount: 1, lastIndexedMessageId: null });
    expect(queries.at(-1)?.params[0]).toBe('synced');
    expect(queries.at(-1)?.params).not.toContain('cap');
  });
});
