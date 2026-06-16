import type { Tier } from './types';

/**
 * The minimal shape of an entitlement needed to decide access. Mirrors the
 * relevant fields of a Discord entitlement object (see @dejavue/db `entitlement`).
 */
export interface EntitlementLike {
  skuId: string;
  /** Set true on refund / manual removal / test-entitlement deletion. */
  deleted?: boolean | null;
  /**
   * When the entitlement stops being valid.
   *
   * IMPORTANT Discord semantics:
   *  - Active subscription  → `null` (no end date).
   *  - Lapsed/cancelled sub → an `ENTITLEMENT_UPDATE` sets this to the period end
   *    (it is NOT deleted).
   *  - Test entitlements    → have no start/end dates at all (→ `null` here),
   *    and are valid until explicitly deleted.
   */
  endsAt?: Date | string | null;
}

export interface TierSkus {
  plus?: string | undefined;
  pro?: string | undefined;
  max?: string | undefined;
}

/** Coerce a nullable Date|string into epoch ms, or null. */
function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Is this entitlement currently granting access?
 *
 * active = not deleted AND (no end date OR end date in the future).
 * The "no end date = active" branch covers both live subscriptions and test
 * entitlements — exactly the case naive `expiry` checks get wrong.
 */
export function isEntitlementActive(e: EntitlementLike, now: Date = new Date()): boolean {
  if (e.deleted) return false;
  const endsMs = toMs(e.endsAt);
  if (endsMs == null) return true;
  return endsMs > now.getTime();
}

/**
 * Derive a guild's tier purely from its entitlement rows. This is the single
 * source of truth for access — never gate on subscription events. Pro wins over
 * Plus when both are somehow present.
 */
export function deriveTier(
  entitlements: readonly EntitlementLike[],
  skus: TierSkus,
  now: Date = new Date(),
): Tier {
  let hasPlus = false;
  let hasPro = false;
  let hasMax = false;
  for (const e of entitlements) {
    if (!isEntitlementActive(e, now)) continue;
    if (skus.max && e.skuId === skus.max) hasMax = true;
    else if (skus.pro && e.skuId === skus.pro) hasPro = true;
    else if (skus.plus && e.skuId === skus.plus) hasPlus = true;
  }
  if (hasMax) return 'max';
  if (hasPro) return 'pro';
  if (hasPlus) return 'plus';
  return 'free';
}
