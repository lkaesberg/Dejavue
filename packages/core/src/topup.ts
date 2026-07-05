/**
 * AI-credit top-up packs. Each pack is a one-time consumable Discord SKU that
 * grants a fixed number of credits (1 credit = 1,000 tokens; see types.ts).
 *
 * The credit amounts are a product decision and live here in code. Only the SKU
 * *ids* are environment-specific (Discord assigns them per app), so those come
 * from env (`SKU_TOPUP_<credits>`). Keeping the amount in code means every
 * consumer — grant, entitlement mapping, ops labels, buy buttons — agrees on how
 * much a given pack is worth without another env var to keep in sync.
 */

export interface TopUpTier {
  /** AI credits this pack grants. */
  credits: number;
  /** Discord SKU id for the pack (from env; only configured packs are surfaced). */
  skuId: string;
}

/** The pack ladder, cheapest → best value. Fixed; the larger packs are the deal. */
export const TOP_UP_PACK_CREDITS = [500, 1000, 2000, 5000] as const;

/** The env fields the top-up helpers read — a subset of the full Env. */
export interface TopUpEnv {
  SKU_TOPUP_500?: string | undefined;
  SKU_TOPUP_1000?: string | undefined;
  SKU_TOPUP_2000?: string | undefined;
  SKU_TOPUP_5000?: string | undefined;
}

/**
 * The configured top-up packs in ascending order. Packs whose SKU id is unset
 * (e.g. locally, or a pack you've chosen not to sell) are omitted, so callers can
 * safely iterate over "the packs that actually exist".
 */
export function topUpTiers(env: TopUpEnv): TopUpTier[] {
  const byCredits: Record<(typeof TOP_UP_PACK_CREDITS)[number], string | undefined> = {
    500: env.SKU_TOPUP_500,
    1000: env.SKU_TOPUP_1000,
    2000: env.SKU_TOPUP_2000,
    5000: env.SKU_TOPUP_5000,
  };
  return TOP_UP_PACK_CREDITS.flatMap((credits) => {
    const skuId = byCredits[credits];
    return skuId ? [{ credits, skuId }] : [];
  });
}

/** Credits granted by a top-up SKU, or `undefined` if the id isn't a top-up pack. */
export function topUpCreditsForSku(env: TopUpEnv, skuId: string): number | undefined {
  return topUpTiers(env).find((t) => t.skuId === skuId)?.credits;
}

/** Whether a SKU id is one of the configured top-up packs. */
export function isTopUpSku(env: TopUpEnv, skuId: string): boolean {
  return topUpCreditsForSku(env, skuId) !== undefined;
}
