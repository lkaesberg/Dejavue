/**
 * Minimal in-memory token bucket, used to burst-limit the per-tenant MCP endpoint, the
 * public KB search, and passphrase attempts on the private-KB gate. In-memory is fine
 * here: the web app is a single SSR process and this is abuse protection, not accounting.
 *
 * Note these endpoints are not free — a semantic search embeds the query, which is a paid
 * API call on the OpenRouter backend, and a passphrase check is a deliberately expensive
 * scrypt hash — so the limit is a real cost control, not just politeness. The query cache
 * in @dejavue/ai absorbs repeats; this bounds the rest.
 *
 * Keys that embed a client IP are only ever as trustworthy as the proxy chain (see
 * lib/clientIp.ts). Every caller that uses one MUST also take a token from a key derived
 * from something the client cannot choose — the resolved tenant guild id — so that a
 * forged IP buys extra fairness allowance but can never lift the absolute ceiling.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Don't let one-off tenants (or forged IPs) accumulate forever.
const MAX_BUCKETS = 10_000;
/**
 * How many of the least-recently-used buckets to drop when the map is full.
 *
 * This used to `clear()` the entire map, which handed an attacker an amplification
 * primitive: minting MAX_BUCKETS distinct keys wiped every OTHER tenant's bucket too,
 * resetting their limits along with the attacker's. Evicting the oldest entries instead
 * bounds memory without ever touching an active tenant's bucket. Map iterates in
 * insertion order and `take` re-inserts on use, so the head of the map is the LRU end.
 */
const EVICT_BATCH = 1_000;

function evictIfFull(): void {
  if (buckets.size < MAX_BUCKETS) return;
  let dropped = 0;
  for (const key of buckets.keys()) {
    buckets.delete(key);
    if (++dropped >= EVICT_BATCH) break;
  }
}

/**
 * Take one token from `key`'s bucket. `perMinute` is both the refill rate and
 * the burst capacity. Returns false when the bucket is empty (rate-limited).
 */
export function takeToken(key: string, perMinute: number, now: number = Date.now()): boolean {
  if (perMinute <= 0) return false;
  let bucket = buckets.get(key);
  if (!bucket) {
    evictIfFull();
    bucket = { tokens: perMinute, lastRefill: now };
  } else {
    // Re-insert so the key moves to the recent end of the iteration order.
    buckets.delete(key);
  }
  buckets.set(key, bucket);

  const elapsedMin = (now - bucket.lastRefill) / 60_000;
  if (elapsedMin > 0) {
    bucket.tokens = Math.min(perMinute, bucket.tokens + elapsedMin * perMinute);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Take a token from every key, consuming from ALL of them (no short-circuit) so a
 * request that is refused by one limit still counts against the others. Use this to
 * stack a forgeable per-visitor key under a non-forgeable per-tenant ceiling.
 */
export function takeAll(
  limits: readonly { key: string; perMinute: number }[],
  now: number = Date.now(),
): boolean {
  let allowed = true;
  for (const { key, perMinute } of limits) {
    if (!takeToken(key, perMinute, now)) allowed = false;
  }
  return allowed;
}

/** Test-only: drop all state so cases can't leak buckets into each other. */
export function __resetBuckets(): void {
  buckets.clear();
}
