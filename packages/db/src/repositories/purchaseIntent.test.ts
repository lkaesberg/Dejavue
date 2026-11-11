import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import {
  bridgeAndStoreEntitlement,
  purchaseTimeMs,
  snowflakeTimeMs,
  TOP_UP_INTENT_TTL_MS,
} from './purchaseIntent';

const CLICK = Date.UTC(2026, 10, 1, 12, 0, 0);
const MIN = 60_000;
const LADDER = ['sku-500', 'sku-1000', 'sku-2500'];

/**
 * An in-memory purchase_intent + entitlement pair answering exactly the statements
 * bridgeAndStoreEntitlement issues (pg-proxy has no transactions, so the transaction
 * just runs the callback; real concurrency is covered by purchaseIntent.pg.test.ts).
 */
function memoryDb() {
  const intents = new Map<string, { guildId: string; updatedAt: number }>();
  const ents = new Map<string, string | null>();
  const sql: string[] = [];
  const db = drizzle(
    async (q, params) => {
      sql.push(q);
      const p = params as unknown[];
      if (q.startsWith('delete from "purchase_intent"')) {
        const key = `${p[0]}|${p[1]}`;
        const hit = intents.get(key);
        const cutoff = p[2] === undefined ? undefined : Date.parse(String(p[2]));
        if (!hit || (cutoff !== undefined && !(hit.updatedAt > cutoff))) return { rows: [] };
        intents.delete(key);
        return { rows: [[hit.guildId, new Date(hit.updatedAt).toISOString()]] };
      }
      if (q.startsWith('insert into "entitlement"')) {
        const [id, , guildId] = p as [string, string, string | null];
        const stored = ents.has(id) ? (ents.get(id) ?? guildId) : guildId;
        ents.set(id, stored ?? null);
        return { rows: [[stored ?? null]] };
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
  /** One ladder click: an intent per pack, all stamped with the click time. */
  const click = (guildId: string, at = CLICK, userId = 'u1') => {
    for (const sku of LADDER) intents.set(`${userId}|${sku}`, { guildId, updatedAt: at });
  };
  return { db, intents, ents, sql, click };
}

const buy = (db: Database, id: string, skuId: string, now: number, opts: { noAgeLimit?: boolean } = {}) =>
  bridgeAndStoreEntitlement(
    db,
    { id, skuId, userId: 'u1', guildId: null },
    { maxAgeMs: opts.noAgeLimit ? undefined : TOP_UP_INTENT_TTL_MS, now },
  );

describe('bridgeAndStoreEntitlement', () => {
  it('bridges two different packs bought from one click, each to the clicked guild', async () => {
    const m = memoryDb();
    m.click('gA');
    expect(await buy(m.db, 'e1', 'sku-500', CLICK + MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(await buy(m.db, 'e2', 'sku-1000', CLICK + 5 * MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
    // Only the purchased SKUs' intents were consumed; the third pack's is still valid.
    expect([...m.intents.keys()]).toEqual(['u1|sku-2500']);
    expect(m.ents.get('e1')).toBe('gA');
    expect(m.ents.get('e2')).toBe('gA');
  });

  it('leaves the same pack bought twice after one click unbridged the second time', async () => {
    const m = memoryDb();
    m.click('gA');
    expect(await buy(m.db, 'e1', 'sku-500', CLICK + MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(await buy(m.db, 'e2', 'sku-500', CLICK + 2 * MIN)).toEqual({ guildId: null, bridged: undefined });
    expect(m.ents.get('e2')).toBeNull();
  });

  it('a fresh click re-arms a pack that was already bought', async () => {
    const m = memoryDb();
    m.click('gA');
    await buy(m.db, 'e1', 'sku-500', CLICK + MIN);
    m.click('gA', CLICK + 3 * MIN);
    expect(await buy(m.db, 'e2', 'sku-500', CLICK + 4 * MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
  });

  it('never uses a top-up intent older than 30 minutes, and leaves it in place', async () => {
    const m = memoryDb();
    m.click('gA');
    expect(await buy(m.db, 'e1', 'sku-500', CLICK + 30 * MIN + 1)).toEqual({
      guildId: null,
      bridged: undefined,
    });
    expect(m.intents.has('u1|sku-500')).toBe(true);
    expect(m.sql[0]).toContain('"purchase_intent"."updated_at" > $3');
  });

  it('a sibling pack still bridges inside the window after another pack was bought', async () => {
    const m = memoryDb();
    m.click('gA');
    await buy(m.db, 'e1', 'sku-500', CLICK + MIN);
    expect(await buy(m.db, 'e2', 'sku-2500', CLICK + 29 * MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
    // ...but not once the click is over 30 minutes old.
    expect(await buy(m.db, 'e3', 'sku-1000', CLICK + 31 * MIN)).toEqual({
      guildId: null,
      bridged: undefined,
    });
  });

  it('has no age limit without maxAgeMs (custom domain) and still bridges one purchase', async () => {
    const m = memoryDb();
    m.intents.set('u1|sku-domain', { guildId: 'gA', updatedAt: CLICK });
    expect(await buy(m.db, 'e1', 'sku-domain', CLICK + 48 * 60 * MIN, { noAgeLimit: true })).toEqual({
      guildId: 'gA',
      bridged: 'gA',
    });
    expect(m.sql[0]).not.toContain('"updated_at" >');
    expect(await buy(m.db, 'e2', 'sku-domain', CLICK + 49 * 60 * MIN, { noAgeLimit: true })).toEqual({
      guildId: null,
      bridged: undefined,
    });
  });

  it('a row that is already bound keeps its guild and gives the intent back', async () => {
    const m = memoryDb();
    m.click('gB');
    m.ents.set('e1', 'gA');
    expect(await buy(m.db, 'e1', 'sku-500', CLICK + MIN)).toEqual({ guildId: 'gA' });
    expect(m.intents.get('u1|sku-500')).toEqual({ guildId: 'gB', updatedAt: CLICK });
  });

  describe('window measured to the purchase time (entitlement snowflake)', () => {
    afterEach(() => vi.useRealTimers());
    /** A Discord snowflake id created at `ms`. */
    const snowflakeAt = (ms: number) => String((BigInt(ms) - 1_420_070_400_000n) << 22n);
    const late = (db: Database, id: string, skuId: string) =>
      bridgeAndStoreEntitlement(
        db,
        { id, skuId, userId: 'u1', guildId: null },
        { maxAgeMs: TOP_UP_INTENT_TTL_MS },
      );

    it('reads the creation time from a snowflake and falls back to now otherwise', () => {
      expect(snowflakeTimeMs(snowflakeAt(CLICK))).toBe(CLICK);
      expect(snowflakeTimeMs('e1')).toBeUndefined();
      expect(purchaseTimeMs('e1', CLICK)).toBe(CLICK);
      // A snowflake from the future (clock skew) is clamped to now.
      expect(purchaseTimeMs(snowflakeAt(CLICK + MIN), CLICK)).toBe(CLICK);
    });

    it('bridges a pack bought inside the window even when processed much later (missed CREATE healed by reconcile)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(CLICK + 55 * MIN);
      const m = memoryDb();
      m.click('gA');
      expect(await late(m.db, snowflakeAt(CLICK + 5 * MIN), 'sku-500')).toEqual({
        guildId: 'gA',
        bridged: 'gA',
      });
    });

    it('does not bridge a pack bought after the window, however soon it is processed', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(CLICK + 31 * MIN);
      const m = memoryDb();
      m.click('gA');
      expect(await late(m.db, snowflakeAt(CLICK + 31 * MIN), 'sku-500')).toEqual({
        guildId: null,
        bridged: undefined,
      });
      expect(m.intents.has('u1|sku-500')).toBe(true);
    });
  });
});
