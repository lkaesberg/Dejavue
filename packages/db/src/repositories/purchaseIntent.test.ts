import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { resolveTopUpIntent, snowflakeTimeMs } from './purchaseIntent';

const CLICK = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOUR = 3_600_000;

/** A snowflake created at `ms`. */
const snowflake = (ms: number): string => ((BigInt(ms) - 1_420_070_400_000n) << 22n).toString();

/** A database answering the intent select, then the entitlement select, in order. */
function scriptedDb(intent: unknown[] | null, bound: { id: string }[]): { db: Database; sql: string[] } {
  const sql: string[] = [];
  const db = drizzle(
    async (q) => {
      sql.push(q);
      if (q.includes('from "purchase_intent"')) {
        // pg-proxy maps array rows positionally: user_id, sku_id, guild_id, updated_at.
        return { rows: intent ? [intent] : [] };
      }
      return { rows: bound.map((b) => [b.id]) };
    },
    { schema },
  ) as unknown as Database;
  return { db, sql };
}

const intentRow = ['u1', 'sku-1000', 'gA', new Date(CLICK).toISOString()];
const base = {
  userId: 'u1',
  skuId: 'sku-1000',
  entitlementId: snowflake(CLICK + 30 * HOUR),
  ladderSkuIds: ['sku-500', 'sku-1000'],
  reuseWindowMs: 24 * HOUR,
};

describe('resolveTopUpIntent', () => {
  it('decodes snowflake times', () => {
    expect(snowflakeTimeMs(snowflake(CLICK))).toBe(CLICK);
    expect(snowflakeTimeMs('not-a-snowflake')).toBeUndefined();
  });

  it('no intent → unbridged', async () => {
    const { db } = scriptedDb(null, []);
    expect(await resolveTopUpIntent(db, { ...base, now: CLICK })).toBeUndefined();
  });

  it('bridges a second pack from the same ladder click within the window', async () => {
    const { db, sql } = scriptedDb(intentRow, [{ id: snowflake(CLICK + 60_000) }]);
    expect(await resolveTopUpIntent(db, { ...base, now: CLICK + 2 * HOUR })).toBe('gA');
    expect(sql).toHaveLength(1); // within the window there's nothing else to check
  });

  it('the first purchase after a click bridges however late', async () => {
    const { db } = scriptedDb(intentRow, [{ id: snowflake(CLICK - 10 * 24 * HOUR) }]);
    expect(await resolveTopUpIntent(db, { ...base, now: CLICK + 30 * HOUR })).toBe('gA');
  });

  it('a spent intent stops bridging after the window', async () => {
    const { db, sql } = scriptedDb(intentRow, [{ id: snowflake(CLICK + 60_000) }]);
    expect(await resolveTopUpIntent(db, { ...base, now: CLICK + 30 * HOUR })).toBeUndefined();
    expect(sql[1]).toContain('"entitlement"."guild_id" = $');
    expect(sql[1]).toContain('"entitlement"."sku_id" in (');
  });

  it('does not count the entitlement being bridged as spending its own intent', async () => {
    const { db } = scriptedDb(intentRow, [{ id: base.entitlementId }]);
    expect(await resolveTopUpIntent(db, { ...base, now: CLICK + 30 * HOUR })).toBe('gA');
  });
});
