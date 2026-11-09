import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { replaceClusters } from './clusters';

/** A database that records each statement and answers with the next queued rows. */
function recordingDb(rows: unknown[][][] = []): { db: Database; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (sql, params) => {
      queries.push({ sql, params });
      return { rows: (rows.shift() ?? []) as never };
    },
    { schema },
  ) as unknown as Database;
  // pg-proxy has no transactions: run the callback inline and mark the boundary.
  (db as unknown as { transaction: unknown }).transaction = async (fn: (tx: Database) => Promise<unknown>) => {
    queries.push({ sql: 'begin', params: [] });
    const out = await fn(db);
    queries.push({ sql: 'commit', params: [] });
    return out;
  };
  return { db, queries };
}

const cluster = (medoid: string) => ({ medoidThreadRowId: medoid, memberThreadIds: ['t'], size: 2 });

describe('replaceClusters', () => {
  it('moves FAQ entries onto the new cluster with the same medoid, then prunes orphans', async () => {
    const { db, queries } = recordingDb([
      // old open clusters
      [
        ['old-a', 'medoid-a'],
        ['old-b', 'medoid-b'],
      ],
      // inserted clusters
      [
        ['new-a', 'medoid-a'],
        ['new-c', 'medoid-c'],
      ],
    ]);
    await replaceClusters(db, 'g', [cluster('medoid-a'), cluster('medoid-c')]);
    const stmts = queries.filter((q) => !/^(begin|commit)/i.test(q.sql));
    expect(stmts[0]!.sql).toMatch(/^select .* from "knowledge_gap_cluster"/);
    expect(stmts[1]!.sql).toMatch(/^insert into "knowledge_gap_cluster"/);
    // Only old-a has a successor: its FAQ entries are re-pointed before the delete.
    const relinks = stmts.filter((q) => q.sql.startsWith('update "faq_entry"'));
    expect(relinks).toHaveLength(1);
    expect(relinks[0]!.params).toEqual(['new-a', 'old-a']);
    const delClusters = stmts.findIndex((q) => q.sql.startsWith('delete from "knowledge_gap_cluster"'));
    expect(delClusters).toBeGreaterThan(stmts.indexOf(relinks[0]!));
    expect(stmts[delClusters]!.params).toEqual(['old-a', 'old-b']);
    // Generated entries whose topic vanished are pruned; human edits are kept.
    const prune = stmts.at(-1)!;
    expect(prune.sql).toMatch(/^delete from "faq_entry"/);
    expect(prune.sql).toContain('"faq_entry"."cluster_id" is null');
    expect(prune.sql).toContain('"faq_entry"."manual_override" = $');
    expect(prune.params).toContain(false);
  });

  it('runs in one transaction', async () => {
    const { db, queries } = recordingDb([[]]);
    await replaceClusters(db, 'g', []);
    expect(queries[0]!.sql.toLowerCase()).toBe('begin');
    expect(queries.at(-1)!.sql.toLowerCase()).toBe('commit');
    expect(queries.some((q) => q.sql.startsWith('insert'))).toBe(false);
  });
});
