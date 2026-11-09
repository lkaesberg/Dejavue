import type { KbImprint } from '@dejavue/db';

// The imprint-before-public gate (Terms of Service § 4): a knowledge base may only
// be publicly reachable when its imprint identifies the operating community. These
// are pure predicates — enforcement lives in customize.ts, the only writer of the
// visibility fields.

/** The fields that decide whether a KB is reachable by the public. */
export interface KbVisibility {
  kbPublishOptIn?: boolean;
  kbSlug?: string | null;
  customDomain?: string | null;
  kbPassphraseHash?: string | null;
}

/** One derived visibility state instead of four fields read ad hoc. `needs_address`
 *  only exists for in-memory patches: the DB forbids a site that is on with no
 *  address (guild_config_kb_site_needs_address). */
export type KbVisibilityStatus = 'off' | 'needs_address' | 'private' | 'public';

/** A slug or a custom domain — somewhere the site can be served. */
export function hasKbAddress(cfg: KbVisibility): boolean {
  return Boolean(cfg.kbSlug || cfg.customDomain);
}

export function kbVisibilityStatus(cfg: KbVisibility): KbVisibilityStatus {
  if (!cfg.kbPublishOptIn) return 'off';
  if (!hasKbAddress(cfg)) return 'needs_address';
  return cfg.kbPassphraseHash ? 'private' : 'public';
}

/** Publicly reachable: site on, a slug or custom domain set, and no passphrase gate. */
export function isPubliclyLive(cfg: KbVisibility): boolean {
  return kbVisibilityStatus(cfg) === 'public';
}

/**
 * The details-modal save, normalized: removing the last address while the site is on
 * also turns the site off, so "on" always means reachable (the publish toggle enforces
 * the same going in). Returns the patch unchanged otherwise.
 */
export function withSiteOffIfAddressless<P extends KbVisibility>(cfg: KbVisibility, patch: P): P {
  if (cfg.kbPublishOptIn && !hasKbAddress({ ...cfg, ...patch })) return { ...patch, kbPublishOptIn: false };
  return patch;
}

/** The legal minimum for a public site's imprint: an operator and a reachable contact. */
export function imprintComplete(imprint: KbImprint | null | undefined): boolean {
  return Boolean(imprint?.operator?.trim() && imprint?.contact?.trim());
}
