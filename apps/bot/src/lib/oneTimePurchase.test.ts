import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  getEntitlement: vi.fn(),
  resolvePurchaseIntent: vi.fn(),
  resolveTopUpIntent: vi.fn(),
  upsertEntitlement: vi.fn(),
  clearPurchaseIntent: vi.fn(),
};

vi.mock('@dejavue/core', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getEnv: () => ({ SKU_CUSTOM_DOMAIN: 'sku-domain', SKU_BACKFILL: undefined }),
  isTopUpSku: (_env: unknown, sku: string) => sku.startsWith('sku-topup'),
  notifyAsync: vi.fn(),
  topUpTiers: () => [
    { skuId: 'sku-topup-500', credits: 500 },
    { skuId: 'sku-topup-1000', credits: 1000 },
  ],
}));
vi.mock('@dejavue/db', () => ({
  getDb: () => ({}),
  getEntitlement: (...a: unknown[]) => db.getEntitlement(...a),
  resolvePurchaseIntent: (...a: unknown[]) => db.resolvePurchaseIntent(...a),
  resolveTopUpIntent: (...a: unknown[]) => db.resolveTopUpIntent(...a),
  upsertEntitlement: (...a: unknown[]) => db.upsertEntitlement(...a),
  clearPurchaseIntent: (...a: unknown[]) => db.clearPurchaseIntent(...a),
  hasOtherLiveEntitlement: vi.fn(),
  revokeTopUpGrant: vi.fn(),
  updateGuildConfig: vi.fn(),
}));
vi.mock('./customDomain', () => ({ grantCustomDomain: vi.fn(async () => undefined) }));
vi.mock('./topUp', () => ({ grantTopUp: vi.fn(async () => undefined) }));

import type { Entitlement } from 'discord.js';
import { grantCustomDomain } from './customDomain';
import { storeAndFulfil, TOP_UP_INTENT_REUSE_MS } from './oneTimePurchase';
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

describe('storeAndFulfil', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bridges a first sighting from the intent and clears it', async () => {
    db.getEntitlement.mockResolvedValue(undefined);
    db.resolvePurchaseIntent.mockResolvedValue('gA');
    db.upsertEntitlement.mockResolvedValue('gA');
    expect(await storeAndFulfil(ent)).toBe('gA');
    expect(db.clearPurchaseIntent).toHaveBeenCalledWith({}, { userId: 'u1', skuIds: ['sku-domain'], guildId: 'gA' });
    expect(grantCustomDomain).toHaveBeenCalledWith(ent, 'gA');
  });

  it('never re-bridges an already-bound purchase to a newer intent for another guild', async () => {
    db.getEntitlement.mockResolvedValue({ id: 'e1', guildId: 'gA' });
    db.resolvePurchaseIntent.mockResolvedValue('gB');
    db.upsertEntitlement.mockResolvedValue('gA');
    expect(await storeAndFulfil(ent)).toBe('gA');
    expect(db.resolvePurchaseIntent).not.toHaveBeenCalled();
    expect(db.clearPurchaseIntent).not.toHaveBeenCalled();
    expect(grantCustomDomain).toHaveBeenCalledWith(ent, 'gA');
  });

  it('bridges every top-up pack bought from one ladder message and keeps the intents', async () => {
    db.getEntitlement.mockResolvedValue(undefined);
    db.resolveTopUpIntent.mockResolvedValue('gA');
    db.upsertEntitlement.mockResolvedValue('gA');
    const a = { ...ent, id: 'e500', skuId: 'sku-topup-500' } as unknown as Entitlement;
    const b = { ...ent, id: 'e1000', skuId: 'sku-topup-1000' } as unknown as Entitlement;
    expect(await storeAndFulfil(a)).toBe('gA');
    expect(await storeAndFulfil(b)).toBe('gA');
    expect(db.resolveTopUpIntent).toHaveBeenLastCalledWith(
      {},
      {
        userId: 'u1',
        skuId: 'sku-topup-1000',
        entitlementId: 'e1000',
        ladderSkuIds: ['sku-topup-500', 'sku-topup-1000'],
        reuseWindowMs: TOP_UP_INTENT_REUSE_MS,
      },
    );
    expect(db.resolvePurchaseIntent).not.toHaveBeenCalled();
    expect(db.clearPurchaseIntent).not.toHaveBeenCalled();
    expect(grantTopUp).toHaveBeenCalledWith(a, 'gA');
    expect(grantTopUp).toHaveBeenCalledWith(b, 'gA');
  });

  it('never re-bridges an already-bound top-up', async () => {
    db.getEntitlement.mockResolvedValue({ id: 'e500', guildId: 'gA' });
    db.upsertEntitlement.mockResolvedValue('gA');
    const a = { ...ent, id: 'e500', skuId: 'sku-topup-500' } as unknown as Entitlement;
    expect(await storeAndFulfil(a)).toBe('gA');
    expect(db.resolveTopUpIntent).not.toHaveBeenCalled();
  });
});
