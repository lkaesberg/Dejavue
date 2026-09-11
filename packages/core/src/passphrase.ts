import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * scrypt is deliberately expensive (~20ms per call here), which is the point for a
 * password hash — but the SYNC variant spends that time on the event loop. The web tier
 * is a single SSR process serving every tenant, and `verifyPassphrase` sits on two
 * unauthenticated endpoints (`POST /unlock`, `Authorization: Bearer` on `/mcp`), so a
 * blocking hash there let one client stall every other tenant's requests. Async keeps
 * the work on libuv's threadpool; the callers rate-limit the attempts themselves.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Hash a shared KB passphrase for storage (private knowledge-base gate). Format is
 * `scrypt$<saltHex>$<hashHex>` so it's self-describing and salt travels with the hash.
 * The passphrase is low-stakes (one shared secret per guild) but we never store it in
 * the clear. Used by `/dejavue customize` (bot) and verified by the web gate.
 */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(passphrase.normalize(), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Is this a non-empty, even-length run of hex digits?
 *
 * `Buffer.from(s, 'hex')` does NOT reject bad input — it decodes as far as it can and
 * silently returns a SHORTER buffer, empty if the very first pair is not hex. That turned
 * a malformed stored hash into an auth bypass: salt and expected both decoded to zero
 * bytes, scrypt was asked for a zero-length key, and `timingSafeEqual(empty, empty)` is
 * true — so any passphrase unlocked the knowledge base. Validate before decoding, so a
 * stored value we do not fully understand fails CLOSED.
 */
function isHex(s: string): boolean {
  return s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/** Constant-time check of a submitted passphrase against a stored `hashPassphrase` value. */
export async function verifyPassphrase(
  passphrase: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, hashHex, ...rest] = stored.split('$');
  if (scheme !== 'scrypt' || rest.length > 0) return false;
  if (!saltHex || !hashHex || !isHex(saltHex) || !isHex(hashHex)) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    // Belt and braces: never let a zero-length comparison stand in for a match.
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scryptAsync(passphrase.normalize(), salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
