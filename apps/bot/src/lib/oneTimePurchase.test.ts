import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = {
  getEntitlement: vi.fn(),
  resolvePurchaseIntent: vi.fn(),
  upsertEntitlement: vi.fn(),
  clearPurchaseIntent: vi.fn(),
};

vi.mock('@dejavue/core', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  getEnv: () => ({ SKU_CUSTOM_DOMAIN: 'sku-domain', SKU_BACKFILL: undefined }),
  isTopUpSku: () => false,
  notifyAsync: vi.fn(),
  topUpTiers: () => [],
}));
vi.mock('@dejavue/db', () => ({
  getDb: () => ({}),
  getEntitlement: (...a: unknown[]) => db.getEntitlement(...a),
  resolvePurchaseIntent: (...a: unknown[]) => db.resolvePurchaseIntent(...a),
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
import { storeAndFulfil } from './oneTimePurchase';

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
});
