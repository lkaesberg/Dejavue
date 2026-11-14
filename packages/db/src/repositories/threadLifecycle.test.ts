import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { publishExistingSolved } from './kb';
import {
  claimCanonicalSummary,
  deleteThreadByDiscordId,
  isPublishable,
  markThreadSolved,
  setThreadStatus,
  upsertThread,
} from './threads';

/** A database that records each statement and answers with `rows`. */
function recordingDb(rows: unknown[][] = []): { db: Database; queries: { sql: string; params: unknown[] }[] } {
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

const last = (q: { sql: string }[]): string => q.at(-1)?.sql ?? '';
const fakeRow = new Array(25).fill(null);

describe('thread lifecycle', () => {
  it('inserts an imported solved thread with solvedAt and promotes only an open row', async () => {
    const { db, queries } = recordingDb([[fakeRow]]);
    await upsertThread(db, { guildId: 'g', channelId: 'c', threadId: 't', title: 'x', status: 'solved' });
    const { sql, params } = queries[0]!;
    expect(params.some((p) => typeof p === 'string' && /^\d{4}-\d\d-\d\dT/.test(p))).toBe(true);
    expect(sql).toContain(
      `"status" = case when (excluded.status = 'solved' and "thread"."status" = 'open') then 'solved'::thread_status else "thread"."status" end`,
    );
    expect(sql).toMatch(/coalesce\(excluded.solved_at, \$\d+::timestamptz\)/);
  });

  it('repairs a solved row without solvedAt when the caller knows the solve time', async () => {
    const { db, queries } = recordingDb([[fakeRow]]);
    await upsertThread(db, {
      guildId: 'g',
      channelId: 'c',
      threadId: 't',
      title: 'x',
      status: 'solved',
      solvedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(last(queries)).toContain(`("thread"."status" = 'solved' and "thread"."solved_at" is null) then excluded.solved_at`);
  });

  it('reopening drops the answer, its summary and solvedAt', async () => {
    const { db, queries } = recordingDb();
    await setThreadStatus(db, 'g', 't', 'unsolved');
    const { sql, params } = queries[0]!;
    for (const col of ['solved_at', 'accepted_answer_message_id', 'accepted_answer_text', 'accepted_answer_author_id', 'canonical_summary']) {
      expect(sql).toContain(`"${col}" = $`);
    }
    expect(params.filter((p) => p === null).length).toBe(5);
  });

  it('a (re-)solve clears the stale summary', async () => {
    const { db, queries } = recordingDb();
    await markThreadSolved(db, { guildId: 'g', discordThreadId: 't', answerText: 'a' });
    expect(last(queries)).toContain('"canonical_summary" = $');
  });

  it('stores a summary only into the solve it was generated from', async () => {
    const { db, queries } = recordingDb();
    const at = new Date('2026-01-01T00:00:00Z');
    expect(await claimCanonicalSummary(db, 'row', 's', at)).toBe(false);
    expect(last(queries)).toContain('"thread"."canonical_summary" is null');
    expect(last(queries)).toContain(`date_trunc('milliseconds', "thread"."solved_at") = $`);
    await claimCanonicalSummary(db, 'row', 's', null);
    expect(last(queries)).toContain('"thread"."solved_at" is null');
  });

  it('un-folding duplicates of a deleted canonical republishes solved, publishable ones', async () => {
    const { db, queries } = recordingDb();
    await deleteThreadByDiscordId(db, 'g', 'canon');
    expect(queries[0]!.sql).toContain(
      `"published_to_kb" = case when "thread"."status" = 'solved' and "thread"."do_not_publish" = false and "thread"."marked_duplicate" = false then true else "thread"."published_to_kb" end`,
    );
  });

  it('deleting a thread deletes the re-hosted images only its transcript showed', async () => {
    const transcript = [
      {
        authorId: 'u',
        content: 'see screenshot',
        createdAt: '2026-01-01T00:00:00Z',
        attachments: [{ id: 'att1', name: 'shot.webp', kind: 'image' }],
      },
    ];
    // 1: un-fold update, 2: thread delete returning the transcript, 3: attachment delete
    const { db, queries } = recordingDb([[], [['row', transcript]]]);
    await deleteThreadByDiscordId(db, 'g', 't');
    expect(queries).toHaveLength(3);
    const { sql, params } = queries[2]!;
    expect(sql).toContain('delete from "attachment"');
    expect(sql).toContain('not exists (select 1 from "thread"');
    expect(params).toEqual(expect.arrayContaining(['g', 'att1']));
  });

  it('deleting a thread without images touches no attachment', async () => {
    const transcript = [{ authorId: 'u', content: 'hi', createdAt: '2026-01-01T00:00:00Z' }];
    const { db, queries } = recordingDb([[], [['row', transcript]]]);
    await deleteThreadByDiscordId(db, 'g', 't');
    expect(queries.some((q) => q.sql.includes('"attachment"'))).toBe(false);
  });

  it('never publishes a hand-marked duplicate', async () => {
    expect(isPublishable({ doNotPublish: false, duplicateOfThreadId: null, markedDuplicate: true })).toBe(false);
    expect(isPublishable({ doNotPublish: false, duplicateOfThreadId: 'c', markedDuplicate: false })).toBe(false);
    expect(isPublishable({ doNotPublish: true, duplicateOfThreadId: null, markedDuplicate: false })).toBe(false);
    expect(isPublishable({ doNotPublish: false, duplicateOfThreadId: null, markedDuplicate: false })).toBe(true);
    const { db, queries } = recordingDb();
    await publishExistingSolved(db, 'g');
    expect(queries[0]!.sql).toContain('"thread"."marked_duplicate" = $');
  });
});
