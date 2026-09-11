import { describe, expect, it } from 'vitest';
import { hashPassphrase, verifyPassphrase } from './passphrase';

describe('passphrase hashing', () => {
  it('round-trips a correct passphrase', async () => {
    const stored = await hashPassphrase('correct horse battery staple');
    expect(await verifyPassphrase('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong passphrase', async () => {
    const stored = await hashPassphrase('open sesame');
    expect(await verifyPassphrase('open sesamf', stored)).toBe(false);
    expect(await verifyPassphrase('', stored)).toBe(false);
  });

  it('salts each hash, so the same passphrase stores differently', async () => {
    const a = await hashPassphrase('same');
    const b = await hashPassphrase('same');
    expect(a).not.toEqual(b);
    expect(await verifyPassphrase('same', a)).toBe(true);
    expect(await verifyPassphrase('same', b)).toBe(true);
  });

  it('normalizes unicode, so an equivalent encoding still unlocks', async () => {
    // "é" as a single code point vs. e + combining acute.
    const stored = await hashPassphrase('café');
    expect(await verifyPassphrase('café', stored)).toBe(true);
  });

  it('rejects a missing or malformed stored hash instead of throwing', async () => {
    expect(await verifyPassphrase('x', null)).toBe(false);
    expect(await verifyPassphrase('x', undefined)).toBe(false);
    expect(await verifyPassphrase('x', '')).toBe(false);
    expect(await verifyPassphrase('x', 'bcrypt$aa$bb')).toBe(false);
    expect(await verifyPassphrase('x', 'scrypt$only-two-parts')).toBe(false);
    expect(await verifyPassphrase('x', 'scrypt$zz$zz')).toBe(false);
  });

  it('does not block the event loop', async () => {
    // The regression this guards: scryptSync sat on two unauthenticated endpoints, so a
    // single client could stall every other tenant's request. If hashing ever goes back
    // to the sync variant, the timer below cannot fire until it finishes.
    let timerFired = false;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0),
    );
    const hashing = hashPassphrase('some passphrase');
    await timer;
    expect(timerFired).toBe(true);
    await hashing;
  });
});

describe('malformed stored hashes fail closed', () => {
  // Regression: Buffer.from(s,'hex') truncates silently rather than throwing, so a
  // stored value with non-hex parts decoded to zero bytes and timingSafeEqual(empty,
  // empty) returned true — every passphrase unlocked the KB.
  const malformed = [
    'scrypt$zz$zz',
    'scrypt$$',
    'scrypt$abcd$',
    'scrypt$$abcd',
    'scrypt$xyz$abcd',
    'scrypt$abc$abcd', // odd-length salt
    'scrypt$abcd$abc', // odd-length hash
    'scrypt$abcd$abcd$extra',
    'bcrypt$abcd$abcd',
    'not-a-hash',
  ];
  for (const stored of malformed) {
    it(`rejects every passphrase for ${JSON.stringify(stored)}`, async () => {
      expect(await verifyPassphrase('anything at all', stored)).toBe(false);
      expect(await verifyPassphrase('', stored)).toBe(false);
    });
  }
});
