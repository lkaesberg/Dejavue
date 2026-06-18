import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Hash a shared KB passphrase for storage (private knowledge-base gate). Format is
 * `scrypt$<saltHex>$<hashHex>` so it's self-describing and salt travels with the hash.
 * The passphrase is low-stakes (one shared secret per guild) but we never store it in
 * the clear. Used by `/dejavue customize` (bot) and verified by the web gate.
 */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase.normalize(), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time check of a submitted passphrase against a stored `hashPassphrase` value. */
export function verifyPassphrase(passphrase: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(passphrase.normalize(), salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
