import { describe, expect, it, vi } from 'vitest';

vi.mock('@dejavue/core', () => ({ childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@dejavue/db', () => ({ getDb: () => ({}), reconcileGuildEntitlements: vi.fn() }));
const storeAndFulfil = vi.fn(async (_e: unknown) => null);
vi.mock('./oneTimePurchase', () => ({
  isOneTimeSku: () => true,
  storeAndFulfil: (e: unknown) => storeAndFulfil(e),
}));
vi.mock('./entitlementMap', () => ({ mapEntitlement: (e: unknown) => e }));
vi.mock('./tier', () => ({ invalidateTier: vi.fn() }));
vi.mock('./topUp', () => ({ grantTopUp: vi.fn(async () => undefined) }));
vi.mock('./upgrade', () => ({ checkTierUpgrade: vi.fn(async () => undefined) }));

import type { Client } from 'discord.js';
import { byPurchaseTime, reconcileAllEntitlements } from './reconcile';

const snowflakeAt = (ms: number) => String((BigInt(ms) - 1_420_070_400_000n) << 22n);

describe('reconcileAllEntitlements', () => {
  it('heals user-owned purchases oldest first, whatever order Discord lists them in', async () => {
    const t = Date.UTC(2026, 10, 1);
    // Different digit counts would sort wrongly as strings; compare as snowflakes.
    const ids = [snowflakeAt(t + 4 * 3_600_000), '9', snowflakeAt(t + 3_600_000)];
    const ents = ids.map((id) => ({
      id,
      skuId: 'sku-topup-500',
      guildId: null,
      consumed: false,
      deleted: false,
    }));
    const client = {
      application: { entitlements: { fetch: async () => new Map(ents.map((e) => [e.id, e])) } },
    };
    await reconcileAllEntitlements(client as unknown as Client);
    expect(storeAndFulfil.mock.calls.map(([e]) => (e as { id: string }).id)).toEqual([
      ids[1],
      ids[2],
      ids[0],
    ]);
  });

  it('orders non-snowflake ids first and stably', () => {
    expect(
      ['b', '5', 'a']
        .map((id) => ({ id }))
        .sort(byPurchaseTime)
        .map((e) => e.id),
    ).toEqual(['a', 'b', '5']);
  });
});
