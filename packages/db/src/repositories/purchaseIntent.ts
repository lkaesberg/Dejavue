import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../client';
import { type NewEntitlement, purchaseIntent } from '../schema';
import { upsertEntitlement } from './entitlements';

/**
 * Remember which guild a user launched a one-time-purchase button from. One-time
 * purchases (durable/consumable) are user-owned, so the ENTITLEMENT_CREATE payload
 * carries no guild_id — this lets us apply the purchase to the right guild. Latest
 * click per (user, sku) wins, and a click re-arms the intent (updated_at = click time,
 * which is what TOP_UP_INTENT_TTL_MS is measured from).
 */
export async function recordPurchaseIntent(
  db: Database,
  intent: { userId: string; skuId: string; guildId: string },
): Promise<void> {
  // Stamp the click with the app clock on insert and update alike: the TTL check
  // compares against the app clock too.
  const clickedAt = new Date();
  await db
    .insert(purchaseIntent)
    .values({ ...intent, updatedAt: clickedAt })
    .onConflictDoUpdate({
      target: [purchaseIntent.userId, purchaseIntent.skuId],
      set: { guildId: intent.guildId, updatedAt: clickedAt },
    });
}

/**
 * How long a ladder click keeps each pack's intent valid. Showing the top-up ladder (the
 * native Premium buy buttons; Discord handles the actual click, we never see it) records
 * an intent per (user, pack SKU) stamped with that time; each stays usable for this
 * long, so a buyer can pick several different packs from the same ladder message in one
 * sitting. Fulfilling a pack consumes only that pack's intent; its siblings stay until
 * this window ends. A purchase after the window needs a fresh ladder click (or ops binds
 * it by hand), so a much later purchase never lands on whichever guild was clicked last.
 */
export const TOP_UP_INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * Atomically bridge a user-owned one-time purchase to a guild and store its entitlement
 * row: consume the buyer's intent for exactly this SKU (DELETE ... RETURNING, so of two
 * purchases racing for one intent only one gets it) and upsert the row with that guild,
 * in one transaction. Intents for other SKUs are untouched.
 *
 * - `maxAgeMs`: only an intent clicked within this long counts (expired ones are left
 *   in place, unused). Omit for no age limit (the custom-domain purchase).
 * - Returns the guild the stored row is bound to, and the guild the intent supplied.
 * - If the row turns out to be bound already (a concurrent delivery of the same
 *   entitlement bridged it first, or ops bound it), the stored binding wins and the
 *   consumed intent is put back, so it stays available for the purchase it was for.
 *
 * Concurrent deliveries of the same entitlement are safe: the loser's DELETE waits on
 * the winner's row lock, finds nothing, and its upsert then sees the winner's binding.
 */
export async function bridgeAndStoreEntitlement(
  db: Database,
  row: NewEntitlement & { userId: string },
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<{ guildId: string | null; bridged?: string }> {
  return db.transaction(async (tx) => {
    const conds = [eq(purchaseIntent.userId, row.userId), eq(purchaseIntent.skuId, row.skuId)];
    if (opts.maxAgeMs !== undefined) {
      conds.push(gt(purchaseIntent.updatedAt, new Date((opts.now ?? Date.now()) - opts.maxAgeMs)));
    }
    const [intent] = await tx
      .delete(purchaseIntent)
      .where(and(...conds))
      .returning({ guildId: purchaseIntent.guildId, updatedAt: purchaseIntent.updatedAt });
    const guildId = await upsertEntitlement(tx as unknown as Database, {
      ...row,
      guildId: intent?.guildId ?? row.guildId ?? null,
    });
    if (intent && guildId !== intent.guildId) {
      // Already bound elsewhere: this purchase didn't use the intent, so restore it
      // (unless a fresher click re-recorded it meanwhile).
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
