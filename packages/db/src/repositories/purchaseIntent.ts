import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Database } from '../client';
import { entitlement, type NewEntitlement, purchaseIntent } from '../schema';
import { upsertEntitlement } from './entitlements';

/**
 * Remember which guild a user launched a one-time-purchase button from. One-time
 * purchases (durable/consumable) are user-owned, so the ENTITLEMENT_CREATE payload
 * carries no guild_id — this lets us apply the purchase to the right guild. Latest
 * showing per (user, sku) wins, and a showing re-arms the intent (updated_at = showing
 * time, which is what the top-up buying sitting is measured from). `at` lets one ladder
 * showing stamp all of its packs with the same time.
 */
export async function recordPurchaseIntent(
  db: Database,
  intent: { userId: string; skuId: string; guildId: string },
  at: Date = new Date(),
): Promise<void> {
  // Stamp the showing with the app clock on insert and update alike.
  await db
    .insert(purchaseIntent)
    .values({ ...intent, updatedAt: at })
    .onConflictDoUpdate({
      target: [purchaseIntent.userId, purchaseIntent.skuId],
      set: { guildId: intent.guildId, updatedAt: at },
    });
}

/**
 * Length of a top-up "buying sitting". Showing the top-up ladder (the native Premium buy
 * buttons; Discord handles the actual click, we never see it) records an intent per
 * (user, pack SKU) stamped with the showing time. Then, per showing:
 *
 * - The FIRST pack bought from it always bridges to its guild, however long after the
 *   showing (a buyer may leave the menu open for hours).
 * - Each further pack bridges if bought within this long of the showing or of the
 *   previous pack bridged from it, whichever is later: one buying sitting.
 * - Anything later is stored unbridged and alerted to ops (bound by hand, then granted by
 *   reconcile), so a purchase long after the sitting never lands on a stale guild.
 *
 * Each pack's intent still bridges at most one purchase (per-SKU consumption): buying the
 * same pack again needs a fresh showing, which starts a new sitting.
 */
export const TOP_UP_SITTING_MS = 30 * 60 * 1000;

/** The top-up bridging rule: which SKUs count as packs, and the sitting length. */
export interface TopUpSitting {
  skuIds: readonly string[];
  windowMs: number;
}

/**
 * Whether a pack bought at `purchasedAt` belongs to the buying sitting of a showing at
 * `shownAt`, given the purchase times of the packs already bridged from that showing.
 * Only earlier bridged purchases count (made at/after the showing, at/before this one);
 * with none, this is the showing's first purchase and always qualifies.
 */
export function inBuyingSitting(
  shownAt: number,
  purchasedAt: number,
  bridgedAt: readonly number[],
  windowMs: number,
): boolean {
  const before = bridgedAt.filter((t) => t >= shownAt && t <= purchasedAt);
  if (before.length === 0) return true;
  return purchasedAt <= Math.max(shownAt, ...before) + windowMs;
}

/** Discord epoch (2015-01-01): snowflake ids carry their creation time from it. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Creation time of a Discord snowflake id, or undefined when the id isn't one. */
export function snowflakeTimeMs(id: string): number | undefined {
  if (!/^\d{1,20}$/.test(id)) return undefined;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/**
 * When the purchase was made: the entitlement id's snowflake time (never later than
 * `now`), else `now`. The buying sitting is measured to the PURCHASE, not to when we get
 * to process it, so a CREATE missed during a deploy / gateway reconnect and healed by
 * the reconcile pass an hour later still bridges a pack bought inside the sitting.
 */
export function purchaseTimeMs(entitlementId: string, now = Date.now()): number {
  const t = snowflakeTimeMs(entitlementId);
  return t === undefined ? now : Math.min(t, now);
}

/**
 * Atomically bridge a user-owned one-time purchase to a guild and store its entitlement
 * row: consume the buyer's intent for exactly this SKU (DELETE ... RETURNING, so of two
 * purchases racing for one intent only one gets it) and upsert the row with that guild,
 * in one transaction. Intents for other SKUs are untouched.
 *
 * - `sitting` (top-ups): the intent is used only if the purchase is in its showing's
 *   buying sitting (see TOP_UP_SITTING_MS / inBuyingSitting). The packs already bridged
 *   from the showing are the buyer's entitlement rows for `sitting.skuIds` bound to the
 *   intent's guild and bought at/after the showing (snowflake times; no extra state).
 *   The buyer's intent rows are locked first (FOR UPDATE), so one buyer's top-ups are
 *   decided one at a time: concurrent purchases each see the ones committed before
 *   them. Without `sitting` there is no age limit (the custom-domain purchase).
 *   Out-of-sitting intents are left in place, unused.
 * - Purchase time = the entitlement id's snowflake time (purchaseTimeMs); `now`
 *   overrides it in tests.
 * - Returns the guild the stored row is bound to, and the guild the intent supplied.
 * - If the row turns out to be bound already (a concurrent delivery of the same
 *   entitlement bridged it first, or ops bound it), the stored binding wins and the
 *   consumed intent is put back, so it stays available for the purchase it was for.
 *
 * Concurrent deliveries of the same entitlement are safe: the loser waits on the
 * winner's row locks, finds the intent gone, and its upsert then sees the winner's binding.
 */
export async function bridgeAndStoreEntitlement(
  db: Database,
  row: NewEntitlement & { userId: string },
  opts: { sitting?: TopUpSitting; now?: number } = {},
): Promise<{ guildId: string | null; bridged?: string }> {
  return db.transaction(async (tx) => {
    const mine = and(eq(purchaseIntent.userId, row.userId), eq(purchaseIntent.skuId, row.skuId));
    let consume = true;
    if (opts.sitting) {
      // Lock all of this buyer's intents (deterministic order: no deadlock between two
      // of their purchases), then decide against the purchases committed so far.
      const intents = await tx
        .select({
          skuId: purchaseIntent.skuId,
          guildId: purchaseIntent.guildId,
          updatedAt: purchaseIntent.updatedAt,
        })
        .from(purchaseIntent)
        .where(eq(purchaseIntent.userId, row.userId))
        .orderBy(purchaseIntent.skuId)
        .for('update');
      const hit = intents.find((i) => i.skuId === row.skuId);
      consume = false;
      if (hit && opts.sitting.skuIds.length > 0) {
        const prior = await tx
          .select({ id: entitlement.id })
          .from(entitlement)
          .where(
            and(
              eq(entitlement.userId, row.userId),
              eq(entitlement.guildId, hit.guildId),
              inArray(entitlement.skuId, [...opts.sitting.skuIds]),
              ne(entitlement.id, row.id),
            ),
          );
        const bridgedAt = prior.map((p) => snowflakeTimeMs(p.id)).filter((t): t is number => t !== undefined);
        consume = inBuyingSitting(
          new Date(hit.updatedAt).getTime(),
          opts.now ?? purchaseTimeMs(row.id),
          bridgedAt,
          opts.sitting.windowMs,
        );
      }
    }
    const [intent] = consume
      ? await tx
          .delete(purchaseIntent)
          .where(mine)
          .returning({ guildId: purchaseIntent.guildId, updatedAt: purchaseIntent.updatedAt })
      : [];
    const guildId = await upsertEntitlement(tx as unknown as Database, {
      ...row,
      guildId: intent?.guildId ?? row.guildId ?? null,
    });
    if (intent && guildId !== intent.guildId) {
      // Already bound elsewhere: this purchase didn't use the intent, so restore it
      // (unless a fresher showing re-recorded it meanwhile).
      await tx
        .insert(purchaseIntent)
        .values({
          userId: row.userId,
          skuId: row.skuId,
          guildId: intent.guildId,
          updatedAt: intent.updatedAt,
        })
        .onConflictDoNothing();
      return { guildId };
    }
    return { guildId, bridged: intent?.guildId };
  });
}
