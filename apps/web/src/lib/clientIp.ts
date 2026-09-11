import { getEnv } from '@dejavue/core';

/**
 * Best-effort client IP for rate-limit keys.
 *
 * `X-Forwarded-For` is a client-supplied header that each proxy APPENDS to. Reading
 * element [0] — which this used to do — therefore reads whatever the client sent, so
 * rotating the header minted unlimited rate-limit keys and bypassed the limit entirely.
 * The only entries that mean anything are the ones our own proxies wrote, and those are
 * at the END of the list: with N trusted proxies in front of us, `list[len - N]` is the
 * address the outermost trusted proxy observed, and everything to its left is forgeable.
 *
 * TRUSTED_PROXY_HOPS is therefore deployment configuration, not a tuning knob:
 *   0 — app is directly exposed. Forwarding headers are ignored entirely and the socket
 *       peer address is used. This is the safe default: a misconfiguration degrades to
 *       "everyone behind one proxy shares a bucket", never to "the limit does nothing".
 *   1 — one reverse proxy (e.g. Traefik alone).
 *   2 — Cloudflare in front of Traefik, the hosted topology.
 *
 * IMPORTANT: no header-based scheme can survive a request that reaches the origin
 * DIRECTLY, bypassing the proxy chain — such a request looks identical to a proxied one,
 * so `cf-connecting-ip` and the tail of XFF are both attacker-controlled on that path.
 * The origin must only accept connections from the proxy. Because that is an
 * infrastructure guarantee we cannot verify from here, every caller stacks a
 * non-forgeable per-tenant ceiling under the per-IP key (see lib/rateLimit takeAll), so
 * a bypass costs an attacker extra fairness allowance and nothing more.
 */
export function clientIp(request: Request, socketAddress?: string | undefined): string {
  const hops = getEnv().TRUSTED_PROXY_HOPS;
  if (hops <= 0) return socketAddress || 'unknown';

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const list = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Count from the right: list[len - hops] was written by our outermost trusted proxy.
    const ip = list[list.length - hops];
    if (ip) return ip;
  }
  // Fewer hops present than configured (a request that skipped part of the chain, or a
  // stripped header) — fall back to the socket peer rather than to a forgeable entry.
  return socketAddress || 'unknown';
}
