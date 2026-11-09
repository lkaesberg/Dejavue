import { and, eq, ne, sql } from 'drizzle-orm';
import { deriveTier, type Tier, type TierSkus } from '@dejavue/core';
import type { Database } from '../client';
import { entitlement, type Entitlement, type NewEntitlement } from '../schema';

/**
 * Mirror a Discord entitlement. Returns the guild the stored row is bound to.
 *
 * A user-owned one-time purchase arrives without a guild_id and is bridged to a
 * guild once (from the purchase intent); Discord's later UPDATEs for it (e.g. after
 * consume()) still carry no guild, so an incoming null never erases a stored guild.
 * `consumed` only ever moves false → true: Discord payloads don't report it, and a
 * re-sync must not re-arm a purchase we already fulfilled.
 */
export async function upsertEntitlement(
  db: Database,
  row: NewEntitlement,
): Promise<string | null> {
  const [stored] = await db
    .insert(entitlement)
    .values(row)
    .onConflictDoUpdate({
      target: entitlement.id,
      set: {
        skuId: row.skuId,
        // The stored binding wins: an entitlement's guild never changes once bound, so a
        // later bridge attempt (a newer intent for another guild) can't move it.
        guildId: sql`coalesce(${entitlement.guildId}, excluded.guild_id)`,
        userId: sql`coalesce(excluded.user_id, ${entitlement.userId})`,
        type: row.type ?? 'unknown',
        startsAt: row.startsAt ?? null,
        endsAt: row.endsAt ?? null,
        deleted: row.deleted ?? false,
        consumed: sql`(${entitlement.consumed} or excluded.consumed)`,
        raw: row.raw ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ guildId: entitlement.guildId });
  return stored?.guildId ?? row.guildId ?? null;
}

/**
 * Mark an entitlement deleted (refund / removal). Returns the stored row as it was
 * bound — for user-owned purchases the Discord payload has no guild, the row does —
 * and whether this call was the one that flipped it (so a refund is reversed once).
 */
/** The stored mirror of one entitlement, if any. */
export async function getEntitlement(db: Database, id: string): Promise<Entitlement | undefined> {
  const [row] = await db.select().from(entitlement).where(eq(entitlement.id, id)).limit(1);
  return row;
}

export async function markEntitlementDeleted(
  db: Database,
  id: string,
): Promise<{ row: Entitlement; flipped: boolean } | undefined> {
  const [flipped] = await db
    .update(entitlement)
    .set({ deleted: true, updatedAt: new Date() })
    .where(and(eq(entitlement.id, id), eq(entitlement.deleted, false)))
    .returning();
  if (flipped) return { row: flipped, flipped: true };
  const [existing] = await db.select().from(entitlement).where(eq(entitlement.id, id)).limit(1);
  return existing ? { row: existing, flipped: false } : undefined;
}

/** Whether a guild still holds another live (not refunded) entitlement for a SKU. */
export async function hasOtherLiveEntitlement(
  db: Database,
  guildId: string,
  skuId: string,
  exceptId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: entitlement.id })
    .from(entitlement)
    .where(
      and(
        eq(entitlement.guildId, guildId),
        eq(entitlement.skuId, skuId),
        eq(entitlement.deleted, false),
        ne(entitlement.id, exceptId),
      ),
    )
    .limit(1);
  return !!row;
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
    // One-time purchases (durable/consumable) are user-owned; Discord's per-guild
    // entitlement list never returns them, so they'd look "missing" and be wrongly
    // deleted. Only reconcile subscription rows against the authoritative list.
    if (e.type === 'durable' || e.type === 'consumable') continue;
    if (!present.has(e.id) && !e.deleted) await markEntitlementDeleted(db, e.id);
  }
}
