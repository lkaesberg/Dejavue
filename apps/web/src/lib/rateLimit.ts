/**
 * Minimal in-memory token bucket, used to burst-limit the per-tenant MCP
 * endpoint. In-memory is fine here: the web app is a single SSR process and
 * this is abuse protection, not accounting (searches cost no AI credits).
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Don't let one-off tenants accumulate forever.
const MAX_BUCKETS = 10_000;

/**
 * Take one token from `key`'s bucket. `perMinute` is both the refill rate and
 * the burst capacity. Returns false when the bucket is empty (rate-limited).
 */
export function takeToken(key: string, perMinute: number, now: number = Date.now()): boolean {
  if (perMinute <= 0) return false;
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    bucket = { tokens: perMinute, lastRefill: now };
    buckets.set(key, bucket);
  }
  const elapsedMin = (now - bucket.lastRefill) / 60_000;
  if (elapsedMin > 0) {
    bucket.tokens = Math.min(perMinute, bucket.tokens + elapsedMin * perMinute);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
