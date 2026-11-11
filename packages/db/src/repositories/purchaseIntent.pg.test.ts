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
import { bridgeAndStoreEntitlement, recordPurchaseIntent, TOP_UP_INTENT_TTL_MS } from './purchaseIntent';

const url = process.env.DEJAVUE_TEST_DATABASE_URL;
const USER = 'pi-race-user';
const LADDER = ['pi-race-500', 'pi-race-1000', 'pi-race-2500'];

describe.skipIf(!url)('purchase intent bridging on Postgres', () => {
  const sql = postgres(url ?? '', { max: 10, onnotice: () => {} });
  const db = drizzle(sql, { schema }) as unknown as Database;
  const ids = Array.from({ length: 12 }, (_, i) => `pi-race-ent-${i}`);

  const reset = async () => {
    await db.delete(purchaseIntent).where(eq(purchaseIntent.userId, USER));
    await db.delete(entitlement).where(inArray(entitlement.id, ids));
  };
  const click = async (guildId: string) => {
    for (const skuId of LADDER) await recordPurchaseIntent(db, { userId: USER, skuId, guildId });
  };
  const buy = (id: string, skuId: string, now?: number) =>
    bridgeAndStoreEntitlement(
      db,
      { id, skuId, userId: USER, guildId: null },
      { maxAgeMs: TOP_UP_INTENT_TTL_MS, now },
    );
  const boundTo = async (id: string) =>
    (await db.select({ g: entitlement.guildId }).from(entitlement).where(eq(entitlement.id, id)))[0]?.g;

  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await sql.end();
  });

  it('two different packs fulfilled concurrently both bridge to the clicked guild', async () => {
    await click('gA');
    const [a, b] = await Promise.all([buy(ids[0]!, LADDER[0]!), buy(ids[1]!, LADDER[1]!)]);
    expect(a).toEqual({ guildId: 'gA', bridged: 'gA' });
    expect(b).toEqual({ guildId: 'gA', bridged: 'gA' });
    const left = await db.select().from(purchaseIntent).where(eq(purchaseIntent.userId, USER));
    expect(left.map((r) => r.skuId)).toEqual([LADDER[2]]);
  });

  it('the same pack bought twice concurrently bridges exactly one', async () => {
    await click('gA');
    const res = await Promise.all([buy(ids[2]!, LADDER[0]!), buy(ids[3]!, LADDER[0]!)]);
    expect(res.filter((r) => r.bridged === 'gA')).toHaveLength(1);
    expect(res.filter((r) => r.guildId === null)).toHaveLength(1);
  });

  it('concurrent deliveries of one entitlement bind it once and consume only its intent', async () => {
    await click('gA');
    const res = await Promise.all(Array.from({ length: 6 }, () => buy(ids[4]!, LADDER[1]!)));
    expect(res.every((r) => r.guildId === 'gA')).toBe(true);
    expect(res.filter((r) => r.bridged === 'gA')).toHaveLength(1);
    expect(await boundTo(ids[4]!)).toBe('gA');
    const left = await db
      .select()
      .from(purchaseIntent)
      .where(and(eq(purchaseIntent.userId, USER), inArray(purchaseIntent.skuId, LADDER)));
    expect(left.map((r) => r.skuId).sort()).toEqual([LADDER[0], LADDER[2]].sort());
  });

  it('an intent older than 30 minutes is not used', async () => {
    await click('gA');
    const res = await buy(ids[5]!, LADDER[0]!, Date.now() + TOP_UP_INTENT_TTL_MS + 60_000);
    expect(res).toEqual({ guildId: null, bridged: undefined });
    expect(await boundTo(ids[5]!)).toBeNull();
  });
});
