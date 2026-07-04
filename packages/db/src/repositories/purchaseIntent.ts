import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { purchaseIntent } from '../schema';

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
