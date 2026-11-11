import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import { entitlement, purchaseIntent } from '../schema';

/**
 * Remember which guild a user launched a one-time-purchase button from. One-time
 * purchases (durable/consumable) are user-owned, so the ENTITLEMENT_CREATE payload
 * carries no guild_id — this lets us apply the purchase to the right guild. Latest
 * click per (user, sku) wins.
 */
export async function recordPurchaseIntent(
  db: Database,
  intent: { userId: string; skuId: string; guildId: string },
): Promise<void> {
  await db
    .insert(purchaseIntent)
    .values(intent)
    .onConflictDoUpdate({
      target: [purchaseIntent.userId, purchaseIntent.skuId],
      set: { guildId: intent.guildId, updatedAt: new Date() },
    });
}

/** Resolve the guild a user's one-time purchase should apply to (their latest click). */
export async function resolvePurchaseIntent(
  db: Database,
  userId: string,
  skuId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(purchaseIntent)
    .where(and(eq(purchaseIntent.userId, userId), eq(purchaseIntent.skuId, skuId)))
    .limit(1);
  return row?.guildId;
}

/** Discord epoch (2015-01-01) — snowflake ids carry their creation time from it. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Creation time of a Discord snowflake id, or undefined when the id isn't one. */
export function snowflakeTimeMs(id: string): number | undefined {
  if (!/^\d{1,20}$/.test(id)) return undefined;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/**
 * Resolve the guild for a top-up pack bought from the ladder. The ladder records one
 * intent per pack and a buyer may buy several packs (or the same pack again, once the
 * consumable is consumed) from one ladder message, so a top-up intent is NOT dropped
 * when it bridges a purchase — every pack bought from that message must bridge.
 *
 * It still must not live forever (a much later purchase made without clicking the
 * ladder again would land on whichever guild was clicked last), so once it has bridged
 * a pack it only keeps bridging within `reuseWindowMs` of the click. The first purchase
 * after a click always bridges, however late — exactly as before. "Has bridged" = the
 * buyer already holds a ladder-pack entitlement bound to that guild, created (snowflake
 * time) at or after the click.
 */
export async function resolveTopUpIntent(
  db: Database,
  input: {
    userId: string;
    skuId: string;
    entitlementId: string;
    ladderSkuIds: string[];
    reuseWindowMs: number;
    now?: number;
  },
): Promise<string | undefined> {
  const [intent] = await db
    .select()
    .from(purchaseIntent)
    .where(and(eq(purchaseIntent.userId, input.userId), eq(purchaseIntent.skuId, input.skuId)))
    .limit(1);
  if (!intent) return undefined;
  const clickedAt = intent.updatedAt.getTime();
  if ((input.now ?? Date.now()) - clickedAt <= input.reuseWindowMs) return intent.guildId;
  const skuIds = [...new Set([input.skuId, ...input.ladderSkuIds])];
  const bound = await db
    .select({ id: entitlement.id })
    .from(entitlement)
    .where(
      and(
        eq(entitlement.userId, input.userId),
        eq(entitlement.guildId, intent.guildId),
        inArray(entitlement.skuId, skuIds),
      ),
    );
  const spent = bound.some((e) => {
    if (e.id === input.entitlementId) return false;
    const t = snowflakeTimeMs(e.id);
    return t !== undefined && t >= clickedAt;
  });
  return spent ? undefined : intent.guildId;
}

/**
 * Drop an intent once it has bridged a purchase (call after the entitlement row is
 * stored with its guild), so it bridges exactly one purchase: a later purchase of the
 * same SKU made without clicking our button again must not silently land on whichever
 * guild was clicked last time. Used for the custom-domain purchase; top-up ladder
 * intents are kept and bounded by resolveTopUpIntent instead. Only removes intents for
 * the guild that was used — a newer click for another guild that raced in stays.
 */
export async function clearPurchaseIntent(
  db: Database,
  intent: { userId: string; skuIds: string[]; guildId: string },
): Promise<void> {
  if (intent.skuIds.length === 0) return;
  await db
    .delete(purchaseIntent)
    .where(
      and(
        eq(purchaseIntent.userId, intent.userId),
        inArray(purchaseIntent.skuId, intent.skuIds),
        eq(purchaseIntent.guildId, intent.guildId),
      ),
    );
}
