// Race tests for purchase-intent bridging against a REAL, migrated, throwaway Postgres.
// Skipped unless DEJAVUE_TEST_DATABASE_URL is set, e.g.:
//   docker run -d --name dv-test-pg -e POSTGRES_USER=dejavue -e POSTGRES_PASSWORD=dejavue \
//     -e POSTGRES_DB=dejavue -p 127.0.0.1:55432:5432 pgvector/pgvector:pg16
//   DATABASE_URL=postgres://dejavue:dejavue@127.0.0.1:55432/dejavue pnpm db:migrate
//   DEJAVUE_TEST_DATABASE_URL=postgres://dejavue:dejavue@127.0.0.1:55432/dejavue pnpm test
// It deletes rows for its own made-up user ids only; never point it at a real database.
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { entitlement, purchaseIntent } from '../schema';
import { bridgeAndStoreEntitlement, recordPurchaseIntent, TOP_UP_SITTING_MS } from './purchaseIntent';

const url = process.env.DEJAVUE_TEST_DATABASE_URL;
const USER = 'pi-race-user';
const LADDER = ['pi-race-500', 'pi-race-1000', 'pi-race-2500'];
const SITTING = { skuIds: LADDER, windowMs: TOP_UP_SITTING_MS };
const MIN = 60_000;
const HOUR = 60 * MIN;

let seq = 0;
/** A unique Discord snowflake id created at `ms`. */
const snowflakeAt = (ms: number) =>
  String(((BigInt(Math.floor(ms)) - 1_420_070_400_000n) << 22n) | BigInt(++seq % 4096));

describe.skipIf(!url)('purchase intent bridging on Postgres', () => {
  const sql = postgres(url ?? '', { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as unknown as Database;
  let shownAt = 0;

  const reset = async () => {
    await db.delete(purchaseIntent).where(eq(purchaseIntent.userId, USER));
    await db.delete(entitlement).where(eq(entitlement.userId, USER));
  };
  /** One ladder showing, back-dated `ago` ms so purchases can happen "later" up to now. */
  const show = async (guildId: string, ago = 0) => {
    shownAt = Date.now() - ago;
    for (const skuId of LADDER)
      await recordPurchaseIntent(db, { userId: USER, skuId, guildId }, new Date(shownAt));
  };
  /** Buy a pack `after` ms after the showing (purchase time = the id's snowflake). */
  const buy = (skuId: string, after: number, id = snowflakeAt(shownAt + after)) =>
    bridgeAndStoreEntitlement(db, { id, skuId, userId: USER, guildId: null }, { sitting: SITTING });
  const boundTo = async (id: string) =>
    (await db.select({ g: entitlement.guildId }).from(entitlement).where(eq(entitlement.id, id)))[0]?.g;

  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await sql.end();
  });

  it('two different packs fulfilled concurrently both bridge to the shown guild', async () => {
    await show('gA', 3 * HOUR);
    const [a, b] = await Promise.all([buy(LADDER[0]!, 2 * HOUR), buy(LADDER[1]!, 2 * HOUR + 5 * MIN)]);
    expect(a).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(b).toEqual({ guildId: 'gA', bridged: 'gA' });
    const left = await db.select().from(purchaseIntent).where(eq(purchaseIntent.userId, USER));
    expect(left.map((r) => r.skuId)).toEqual([LADDER[2]]);
  });

  it('two late packs (3h apart) healed concurrently land on the shown guild or stay unbridged', async () => {
    await show('gA', 6 * HOUR);
    // Healed together by a reconcile pass; serialised on the buyer's intent rows, so
    // whichever commits first is the showing's first purchase and the other is judged
    // against the purchases committed before it (only earlier purchase times count).
    const ids = [snowflakeAt(shownAt + HOUR), snowflakeAt(shownAt + 4 * HOUR)];
    const res = await Promise.all([buy(LADDER[0]!, 0, ids[0]), buy(LADDER[1]!, 0, ids[1])]);
    expect(res.every((r) => r.guildId === 'gA' || r.guildId === null)).toBe(true);
    expect(await boundTo(ids[0]!)).toBe('gA');
    // Sequentially (the normal case) the 1h pack bridges and the 4h one does not.
    await reset();
    await show('gA', 6 * HOUR);
    expect(await buy(LADDER[0]!, HOUR)).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(await buy(LADDER[1]!, 4 * HOUR)).toEqual({ guildId: null, bridged: undefined });
  });

  it('the same pack bought twice concurrently bridges exactly one', async () => {
    await show('gA');
    const res = await Promise.all([buy(LADDER[0]!, 0), buy(LADDER[0]!, 0)]);
    expect(res.filter((r) => r.bridged === 'gA')).toHaveLength(1);
    expect(res.filter((r) => r.guildId === null)).toHaveLength(1);
  });

  it('concurrent deliveries of one entitlement bind it once and consume only its intent', async () => {
    await show('gA');
    const id = snowflakeAt(shownAt);
    const res = await Promise.all(Array.from({ length: 6 }, () => buy(LADDER[1]!, 0, id)));
    expect(res.every((r) => r.guildId === 'gA')).toBe(true);
    expect(res.filter((r) => r.bridged === 'gA')).toHaveLength(1);
    expect(await boundTo(id)).toBe('gA');
    const left = await db
      .select()
      .from(purchaseIntent)
      .where(and(eq(purchaseIntent.userId, USER), inArray(purchaseIntent.skuId, LADDER)));
    expect(left.map((r) => r.skuId).sort()).toEqual([LADDER[0], LADDER[2]].sort());
  });

  it('first pack 2h after the showing bridges; a sibling 3h after that does not', async () => {
    await show('gA', 6 * HOUR);
    expect(await buy(LADDER[0]!, 2 * HOUR)).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(await buy(LADDER[1]!, 2 * HOUR + 20 * MIN)).toEqual({ guildId: 'gA', bridged: 'gA' });
    const id = snowflakeAt(shownAt + 5 * HOUR + 20 * MIN);
    expect(await buy(LADDER[2]!, 0, id)).toEqual({ guildId: null, bridged: undefined });
    expect(await boundTo(id)).toBeNull();
  });
});
