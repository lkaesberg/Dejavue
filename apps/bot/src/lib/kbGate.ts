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

/** Publicly reachable: site on, a slug or custom domain set, and no passphrase gate. */
export function isPubliclyLive(cfg: KbVisibility): boolean {
  return Boolean(cfg.kbPublishOptIn) && Boolean(cfg.kbSlug || cfg.customDomain) && !cfg.kbPassphraseHash;
}

/** The legal minimum for a public site's imprint: an operator and a reachable contact. */
export function imprintComplete(imprint: KbImprint | null | undefined): boolean {
  return Boolean(imprint?.operator?.trim() && imprint?.contact?.trim());
}
