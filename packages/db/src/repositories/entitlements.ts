import { eq } from 'drizzle-orm';
import { deriveTier, type Tier, type TierSkus } from '@dejavue/core';
import type { Database } from '../client';
import { entitlement, type Entitlement, type NewEntitlement } from '../schema';

export async function upsertEntitlement(db: Database, row: NewEntitlement): Promise<void> {
  await db
    .insert(entitlement)
    .values(row)
    .onConflictDoUpdate({
      target: entitlement.id,
      set: {
        skuId: row.skuId,
        guildId: row.guildId ?? null,
        userId: row.userId ?? null,
        type: row.type ?? 'unknown',
        startsAt: row.startsAt ?? null,
        endsAt: row.endsAt ?? null,
        deleted: row.deleted ?? false,
        consumed: row.consumed ?? false,
        raw: row.raw ?? null,
        updatedAt: new Date(),
      },
    });
}

export async function markEntitlementDeleted(db: Database, id: string): Promise<void> {
  await db
    .update(entitlement)
    .set({ deleted: true, updatedAt: new Date() })
    .where(eq(entitlement.id, id));
}

export async function markEntitlementConsumed(db: Database, id: string): Promise<void> {
  await db
    .update(entitlement)
    .set({ consumed: true, updatedAt: new Date() })
    .where(eq(entitlement.id, id));
}

export async function getGuildEntitlements(
  db: Database,
  guildId: string,
): Promise<Entitlement[]> {
  return db.select().from(entitlement).where(eq(entitlement.guildId, guildId));
}

/** Find an active, unconsumed one-time-purchase entitlement for a SKU (backfill/top-up). */
export async function getActiveOtp(
  db: Database,
  guildId: string,
  skuId: string,
): Promise<Entitlement | undefined> {
  const rows = await getGuildEntitlements(db, guildId);
  return rows.find((r) => r.skuId === skuId && !r.deleted && !r.consumed);
}

/** Resolve a guild's tier purely from its stored entitlement rows. */
export async function resolveGuildTier(
  db: Database,
  guildId: string,
  skus: TierSkus,
  now: Date = new Date(),
): Promise<Tier> {
  const rows = await getGuildEntitlements(db, guildId);
  return deriveTier(
    rows.map((r) => ({ skuId: r.skuId, deleted: r.deleted, endsAt: r.endsAt })),
    skus,
    now,
  );
}

/**
 * Reconcile a guild's entitlements against an authoritative set (Discord LIST):
 * upsert everything present, mark anything no longer present as deleted.
 */
export async function reconcileGuildEntitlements(
  db: Database,
  guildId: string,
  rows: NewEntitlement[],
): Promise<void> {
  const present = new Set(rows.map((r) => r.id));
  for (const row of rows) await upsertEntitlement(db, row);
  const existing = await getGuildEntitlements(db, guildId);
  for (const e of existing) {
    if (!present.has(e.id) && !e.deleted) await markEntitlementDeleted(db, e.id);
  }
}
