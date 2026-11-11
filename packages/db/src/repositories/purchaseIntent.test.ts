import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import {
  bridgeAndStoreEntitlement,
  inBuyingSitting,
  purchaseTimeMs,
  snowflakeTimeMs,
  TOP_UP_SITTING_MS,
} from './purchaseIntent';

const SHOWN = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const LADDER = ['sku-500', 'sku-1000', 'sku-2500'];
const SITTING = { skuIds: LADDER, windowMs: TOP_UP_SITTING_MS };

/** A Discord snowflake id created at `ms` (`seq` keeps ids made in one ms distinct). */
const snowflakeAt = (ms: number, seq = 0) => String(((BigInt(ms) - 1_420_070_400_000n) << 22n) | BigInt(seq));

type Ent = { guildId: string | null; userId: string | null; skuId: string };

/**
 * An in-memory purchase_intent + entitlement pair answering exactly the statements
 * bridgeAndStoreEntitlement issues (pg-proxy has no transactions, so the transaction
 * just runs the callback; real concurrency is covered by purchaseIntent.pg.test.ts).
 */
function memoryDb() {
  const intents = new Map<string, { guildId: string; updatedAt: number }>();
  const ents = new Map<string, Ent>();
  const sql: string[] = [];
  const db = drizzle(
    async (q, params) => {
      sql.push(q);
      const p = params as unknown[];
      if (q.startsWith('select') && q.includes('from "purchase_intent"')) {
        expect(q).toContain('for update');
        return {
          rows: [...intents]
            .filter(([k]) => k.startsWith(`${p[0]}|`))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k.split('|')[1], v.guildId, new Date(v.updatedAt).toISOString()]),
        };
      }
      if (q.startsWith('select') && q.includes('from "entitlement"')) {
        // where user_id = $1 and guild_id = $2 and sku_id in ($3..) and id <> $last
        const [userId, guildId, ...rest] = p as string[];
        const exceptId = rest.pop();
        return {
          rows: [...ents]
            .filter(
              ([id, e]) =>
                e.userId === userId && e.guildId === guildId && rest.includes(e.skuId) && id !== exceptId,
            )
            .map(([id]) => [id]),
        };
      }
      if (q.startsWith('delete from "purchase_intent"')) {
        const key = `${p[0]}|${p[1]}`;
        const hit = intents.get(key);
        if (!hit) return { rows: [] };
        intents.delete(key);
        return { rows: [[hit.guildId, new Date(hit.updatedAt).toISOString()]] };
      }
      if (q.startsWith('insert into "entitlement"')) {
        const [id, skuId, guildId, userId] = p as [string, string, string | null, string | null];
        const prev = ents.get(id);
        const stored = prev?.guildId ?? guildId ?? null;
        ents.set(id, { guildId: stored, userId: userId ?? prev?.userId ?? null, skuId });
        return { rows: [[stored]] };
      }
      if (q.startsWith('insert into "purchase_intent"')) {
        const key = `${p[0]}|${p[1]}`;
        if (!intents.has(key))
          intents.set(key, { guildId: String(p[2]), updatedAt: Date.parse(String(p[3])) });
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${q}`);
    },
    { schema },
  ) as unknown as Database & { transaction: unknown };
  (db as { transaction: unknown }).transaction = (fn: (tx: Database) => unknown) => fn(db);
  /** One ladder showing: an intent per pack, all stamped with the showing time. */
  const show = (guildId: string, at = SHOWN, userId = 'u1') => {
    for (const sku of LADDER) intents.set(`${userId}|${sku}`, { guildId, updatedAt: at });
  };
  return { db, intents, ents, sql, show };
}

/** Buy a top-up pack at `at` (the entitlement id is a snowflake of that time). */
const buy = (db: Database, skuId: string, at: number, seq = 0) =>
  bridgeAndStoreEntitlement(
    db,
    { id: snowflakeAt(at, seq), skuId, userId: 'u1', guildId: null },
    { sitting: SITTING, now: at },
  );
const BRIDGED_A = { guildId: 'gA', bridged: 'gA' };
const UNBRIDGED = { guildId: null, bridged: undefined };

describe('inBuyingSitting', () => {
  const W = TOP_UP_SITTING_MS;
  it('accepts the first purchase after a showing however late', () => {
    expect(inBuyingSitting(SHOWN, SHOWN + 48 * HOUR, [], W)).toBe(true);
  });
  it('accepts a further purchase within 30 min of the showing or the previous bridged one', () => {
    expect(inBuyingSitting(SHOWN, SHOWN + 29 * MIN, [SHOWN + MIN], W)).toBe(true);
    expect(inBuyingSitting(SHOWN, SHOWN + 2 * HOUR + 20 * MIN, [SHOWN + 2 * HOUR], W)).toBe(true);
    expect(inBuyingSitting(SHOWN, SHOWN + 2 * HOUR + 31 * MIN, [SHOWN + 2 * HOUR], W)).toBe(false);
  });
  it('ignores purchases from before the showing and after this one', () => {
    expect(inBuyingSitting(SHOWN, SHOWN + 3 * HOUR, [SHOWN - MIN, SHOWN + 4 * HOUR], W)).toBe(true);
  });
});

describe('bridgeAndStoreEntitlement (top-up buying sitting)', () => {
  it('bridges the first pack bought 2h after the showing', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + 2 * HOUR)).toEqual(BRIDGED_A);
    // Only the purchased SKU's intent was consumed.
    expect([...m.intents.keys()].sort()).toEqual(['u1|sku-1000', 'u1|sku-2500']);
  });

  it('bridges a second pack bought within 30 min of the first', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + 2 * HOUR)).toEqual(BRIDGED_A);
    expect(await buy(m.db, 'sku-1000', SHOWN + 2 * HOUR + 25 * MIN)).toEqual(BRIDGED_A);
    // ...and the sitting extends from each bridged pack.
    expect(await buy(m.db, 'sku-2500', SHOWN + 2 * HOUR + 50 * MIN)).toEqual(BRIDGED_A);
  });

  it('bridges two packs inside 30 min of the showing', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + MIN)).toEqual(BRIDGED_A);
    expect(await buy(m.db, 'sku-2500', SHOWN + 29 * MIN)).toEqual(BRIDGED_A);
  });

  it('leaves a second pack bought 3h after the first (and >30 min after the showing) unbridged', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + 5 * MIN)).toEqual(BRIDGED_A);
    expect(await buy(m.db, 'sku-1000', SHOWN + 3 * HOUR + 5 * MIN)).toEqual(UNBRIDGED);
    // The out-of-sitting intent is left in place, unused.
    expect(m.intents.has('u1|sku-1000')).toBe(true);
  });

  it('leaves the same pack bought twice from one showing unbridged the second time', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + MIN)).toEqual(BRIDGED_A);
    expect(await buy(m.db, 'sku-500', SHOWN + 2 * MIN)).toEqual(UNBRIDGED);
  });

  it('a fresh showing re-arms every pack and starts a new sitting', async () => {
    const m = memoryDb();
    m.show('gA');
    await buy(m.db, 'sku-500', SHOWN + MIN);
    m.show('gA', SHOWN + 5 * HOUR);
    // The first purchase after the new showing bridges however late, even the same pack.
    expect(await buy(m.db, 'sku-500', SHOWN + 9 * HOUR)).toEqual(BRIDGED_A);
    expect(await buy(m.db, 'sku-1000', SHOWN + 9 * HOUR + 10 * MIN)).toEqual(BRIDGED_A);
  });

  it('a newer showing for another guild wins', async () => {
    const m = memoryDb();
    m.show('gA');
    expect(await buy(m.db, 'sku-500', SHOWN + MIN)).toEqual(BRIDGED_A);
    m.show('gB', SHOWN + 10 * MIN);
    // The sibling now goes to gB, and as gB's first purchase (gA's pack doesn't count).
    expect(await buy(m.db, 'sku-1000', SHOWN + 4 * HOUR)).toEqual({ guildId: 'gB', bridged: 'gB' });
  });

  it('a pack stored unbridged does not count as a bridged purchase of the sitting', async () => {
    const m = memoryDb();
    m.show('gA');
    await buy(m.db, 'sku-500', SHOWN + MIN);
    expect(await buy(m.db, 'sku-500', SHOWN + 2 * HOUR)).toEqual(UNBRIDGED); // same pack again
    expect(await buy(m.db, 'sku-1000', SHOWN + 2 * HOUR + 10 * MIN)).toEqual(UNBRIDGED);
  });

  it('a row that is already bound keeps its guild and gives the intent back', async () => {
    const m = memoryDb();
    m.show('gB');
    const id = snowflakeAt(SHOWN + MIN);
    m.ents.set(id, { guildId: 'gA', userId: 'u1', skuId: 'sku-500' });
    expect(
      await bridgeAndStoreEntitlement(
        m.db,
        { id, skuId: 'sku-500', userId: 'u1', guildId: null },
        { sitting: SITTING, now: SHOWN + MIN },
      ),
    ).toEqual({ guildId: 'gA' });
    expect(m.intents.get('u1|sku-500')).toEqual({ guildId: 'gB', updatedAt: SHOWN });
  });

  it('has no age limit without a sitting (custom domain) and still bridges one purchase', async () => {
    const m = memoryDb();
    m.intents.set('u1|sku-domain', { guildId: 'gA', updatedAt: SHOWN });
    const dom = (id: string) =>
      bridgeAndStoreEntitlement(m.db, { id, skuId: 'sku-domain', userId: 'u1', guildId: null });
    expect(await dom('e1')).toEqual(BRIDGED_A);
    expect(m.sql.some((q) => q.includes('for update'))).toBe(false);
    expect(await dom('e2')).toEqual(UNBRIDGED);
  });

  describe('times are purchase times (entitlement snowflake)', () => {
    afterEach(() => vi.useRealTimers());
    const late = (db: Database, id: string, skuId: string) =>
      bridgeAndStoreEntitlement(db, { id, skuId, userId: 'u1', guildId: null }, { sitting: SITTING });

    it('reads the creation time from a snowflake and falls back to now otherwise', () => {
      expect(snowflakeTimeMs(snowflakeAt(SHOWN))).toBe(SHOWN);
      expect(snowflakeTimeMs('e1')).toBeUndefined();
      expect(purchaseTimeMs('e1', SHOWN)).toBe(SHOWN);
      // A snowflake from the future (clock skew) is clamped to now.
      expect(purchaseTimeMs(snowflakeAt(SHOWN + MIN), SHOWN)).toBe(SHOWN);
    });

    it('bridges a second pack bought inside the sitting even when its CREATE is healed hours later by reconcile', async () => {
      vi.useFakeTimers();
      const m = memoryDb();
      m.show('gA');
      vi.setSystemTime(SHOWN + 2 * HOUR);
      expect(await late(m.db, snowflakeAt(SHOWN + 2 * HOUR), 'sku-500')).toEqual(BRIDGED_A);
      // The sibling was bought 20 min later, but its CREATE was missed; reconcile heals it at +5h.
      vi.setSystemTime(SHOWN + 5 * HOUR);
      expect(await late(m.db, snowflakeAt(SHOWN + 2 * HOUR + 20 * MIN), 'sku-1000')).toEqual(BRIDGED_A);
    });

    it('does not bridge a further pack bought after the sitting, however soon it is processed', async () => {
      vi.useFakeTimers();
      const m = memoryDb();
      m.show('gA');
      vi.setSystemTime(SHOWN + MIN);
      await late(m.db, snowflakeAt(SHOWN + MIN), 'sku-500');
      vi.setSystemTime(SHOWN + 32 * MIN);
      expect(await late(m.db, snowflakeAt(SHOWN + 32 * MIN), 'sku-1000')).toEqual(UNBRIDGED);
      expect(m.intents.has('u1|sku-1000')).toBe(true);
    });
  });
});
