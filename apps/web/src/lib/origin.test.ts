import { describe, expect, it } from 'vitest';
import { publicOrigin } from './origin';

const req = (url: string, headers: Record<string, string> = {}): Request => new Request(url, { headers });

describe('publicOrigin', () => {
  it("uses the proxy's scheme, not the socket's", () => {
    expect(publicOrigin(req('http://dejavue.app/c/x', { 'x-forwarded-proto': 'https' }))).toBe(
      'https://dejavue.app',
    );
    expect(publicOrigin(req('http://help.acme.com/', { 'x-forwarded-proto': 'https,http' }))).toBe(
      'https://help.acme.com',
    );
  });

  it('keeps the request scheme and port without the header', () => {
    expect(publicOrigin(req('http://demo.localhost:4321/search?q=a'))).toBe('http://demo.localhost:4321');
  });

  it('ignores a header that is not a web scheme', () => {
    expect(publicOrigin(req('http://dejavue.app/', { 'x-forwarded-proto': 'javascript' }))).toBe(
      'http://dejavue.app',
    );
  });
});
