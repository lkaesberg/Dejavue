import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  getEntitlement: vi.fn(),
  bridgeAndStoreEntitlement: vi.fn(),
  upsertEntitlement: vi.fn(),
};
const notifyAsync = vi.fn();

vi.mock('@dejavue/core', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getEnv: () => ({ SKU_CUSTOM_DOMAIN: 'sku-domain', SKU_BACKFILL: undefined }),
  isTopUpSku: (_env: unknown, sku: string) => sku.startsWith('sku-topup'),
  notifyAsync: (...a: unknown[]) => notifyAsync(...a),
}));
vi.mock('@dejavue/db', () => ({
  getDb: () => ({}),
  getEntitlement: (...a: unknown[]) => db.getEntitlement(...a),
  bridgeAndStoreEntitlement: (...a: unknown[]) => db.bridgeAndStoreEntitlement(...a),
  upsertEntitlement: (...a: unknown[]) => db.upsertEntitlement(...a),
  TOP_UP_INTENT_TTL_MS: 30 * 60 * 1000,
  hasOtherLiveEntitlement: vi.fn(),
  revokeTopUpGrant: vi.fn(),
  updateGuildConfig: vi.fn(),
}));
vi.mock('./customDomain', () => ({ grantCustomDomain: vi.fn(async () => undefined) }));
vi.mock('./topUp', () => ({ grantTopUp: vi.fn(async () => undefined) }));

import type { Entitlement } from 'discord.js';
import { grantCustomDomain } from './customDomain';
import { storeAndFulfil } from './oneTimePurchase';
import { grantTopUp } from './topUp';

const ent = {
  id: 'e1',
  skuId: 'sku-domain',
  guildId: null,
  userId: 'u1',
  deleted: false,
  consumed: false,
  startsTimestamp: null,
  endsTimestamp: null,
} as unknown as Entitlement;

const row = (id: string, skuId: string) => ({ id, skuId, guildId: null, userId: 'u1' });
const topUp = (id: string, skuId: string) => ({ ...ent, id, skuId }) as unknown as Entitlement;

describe('storeAndFulfil', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bridges a custom-domain purchase from its intent with no age limit', async () => {
    db.getEntitlement.mockResolvedValue(undefined);
    db.bridgeAndStoreEntitlement.mockResolvedValue({ guildId: 'gA', bridged: 'gA' });
    expect(await storeAndFulfil(ent)).toBe('gA');
    expect(db.bridgeAndStoreEntitlement).toHaveBeenCalledWith(
      {},
      expect.objectContaining(row('e1', 'sku-domain')),
      {
        maxAgeMs: undefined,
      },
    );
    expect(db.upsertEntitlement).not.toHaveBeenCalled();
    expect(grantCustomDomain).toHaveBeenCalledWith(ent, 'gA');
  });

  it('never re-bridges an already-bound purchase to a newer intent for another guild', async () => {
    db.getEntitlement.mockResolvedValue({ id: 'e1', guildId: 'gA' });
    db.upsertEntitlement.mockResolvedValue('gA');
    expect(await storeAndFulfil(ent)).toBe('gA');
    expect(db.bridgeAndStoreEntitlement).not.toHaveBeenCalled();
    expect(grantCustomDomain).toHaveBeenCalledWith(ent, 'gA');
  });

  it('credits two different packs bought from one ladder click, each from its own 30-min intent', async () => {
    db.getEntitlement.mockResolvedValue(undefined);
    db.bridgeAndStoreEntitlement.mockResolvedValue({ guildId: 'gA', bridged: 'gA' });
    const a = topUp('e500', 'sku-topup-500');
    const b = topUp('e1000', 'sku-topup-1000');
    expect(await storeAndFulfil(a, { alertUnbridged: true })).toBe('gA');
    expect(await storeAndFulfil(b, { alertUnbridged: true })).toBe('gA');
    expect(db.bridgeAndStoreEntitlement).toHaveBeenNthCalledWith(
      1,
      {},
      expect.objectContaining(row('e500', 'sku-topup-500')),
      { maxAgeMs: 30 * 60 * 1000 },
    );
    expect(db.bridgeAndStoreEntitlement).toHaveBeenNthCalledWith(
      2,
      {},
      expect.objectContaining(row('e1000', 'sku-topup-1000')),
      { maxAgeMs: 30 * 60 * 1000 },
    );
    expect(grantTopUp).toHaveBeenCalledWith(a, 'gA');
    expect(grantTopUp).toHaveBeenCalledWith(b, 'gA');
    expect(notifyAsync).not.toHaveBeenCalled();
  });

  it('stores a pack with no unused intent unbridged and alerts ops (same pack twice, or expired)', async () => {
    db.getEntitlement.mockResolvedValue(undefined);
    db.bridgeAndStoreEntitlement.mockResolvedValue({ guildId: null });
    const again = topUp('e500b', 'sku-topup-500');
    expect(await storeAndFulfil(again, { alertUnbridged: true })).toBeNull();
    expect(grantTopUp).not.toHaveBeenCalled();
    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ title: '🚨 Unfulfilled one-time purchase' }),
    );
  });

  it('never re-bridges an already-bound top-up', async () => {
    db.getEntitlement.mockResolvedValue({ id: 'e500', guildId: 'gA' });
    db.upsertEntitlement.mockResolvedValue('gA');
    const a = topUp('e500', 'sku-topup-500');
    expect(await storeAndFulfil(a)).toBe('gA');
    expect(db.bridgeAndStoreEntitlement).not.toHaveBeenCalled();
    expect(grantTopUp).toHaveBeenCalledWith(a, 'gA');
  });
});
