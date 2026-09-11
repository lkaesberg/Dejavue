import { resetEnvCache } from '@dejavue/core';
import { afterEach, describe, expect, it } from 'vitest';
import { clientIp } from './clientIp';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://acme.dejavue.app/search', { headers });
}

function withHops(hops: string | undefined, fn: () => void): void {
  const prev = process.env.TRUSTED_PROXY_HOPS;
  if (hops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = hops;
  resetEnvCache();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = prev;
    resetEnvCache();
  }
}

afterEach(() => resetEnvCache());

describe('clientIp', () => {
  it('ignores forwarding headers entirely when no proxy is configured', () => {
    // The safe default: a directly exposed app must not believe a header.
    withHops('0', () => {
      const r = req({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' });
      expect(clientIp(r, '10.0.0.1')).toBe('10.0.0.1');
    });
  });

  it('defaults to zero hops when the variable is unset', () => {
    withHops(undefined, () => {
      expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), '10.0.0.1')).toBe('10.0.0.1');
    });
  });

  it('reads the entry our own proxy wrote, counting from the right', () => {
    withHops('1', () => {
      // One proxy appended "9.9.9.9"; everything left of it is client-supplied.
      const r = req({ 'x-forwarded-for': 'forged-a, forged-b, 9.9.9.9' });
      expect(clientIp(r, '10.0.0.1')).toBe('9.9.9.9');
    });
  });

  it('reads past the innermost proxy in a two-hop chain', () => {
    withHops('2', () => {
      // Cloudflare wrote the real client IP; Traefik then appended the CF edge address.
      const r = req({ 'x-forwarded-for': 'forged, 203.0.113.7, 172.16.0.2' });
      expect(clientIp(r, '10.0.0.1')).toBe('203.0.113.7');
    });
  });

  it('cannot be steered by a forged prefix — THE regression this fix exists for', () => {
    withHops('1', () => {
      // Rotating the left-hand entries used to mint a fresh rate-limit key per request.
      const a = clientIp(req({ 'x-forwarded-for': 'attacker-1, 9.9.9.9' }), '10.0.0.1');
      const b = clientIp(req({ 'x-forwarded-for': 'attacker-2, 9.9.9.9' }), '10.0.0.1');
      const c = clientIp(req({ 'x-forwarded-for': '9.9.9.9' }), '10.0.0.1');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });

  it('never trusts cf-connecting-ip on its own', () => {
    // It is only meaningful if the request actually came via Cloudflare, which we
    // cannot verify from here — so it is not a source at all.
    withHops('2', () => {
      const r = req({ 'cf-connecting-ip': 'attacker', 'x-forwarded-for': 'a, 203.0.113.7, b' });
      expect(clientIp(r, '10.0.0.1')).toBe('203.0.113.7');
    });
  });

  it('falls back to the socket peer when the chain is shorter than configured', () => {
    withHops('3', () => {
      expect(clientIp(req({ 'x-forwarded-for': 'a, b' }), '10.0.0.1')).toBe('10.0.0.1');
      expect(clientIp(req(), '10.0.0.1')).toBe('10.0.0.1');
    });
  });

  it('returns a stable placeholder when nothing is knowable', () => {
    withHops('0', () => expect(clientIp(req(), undefined)).toBe('unknown'));
  });
});
