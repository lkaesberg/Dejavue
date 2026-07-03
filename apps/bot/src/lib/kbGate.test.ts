import { describe, expect, it } from 'vitest';
import { imprintComplete, isPubliclyLive } from './kbGate';

const base = { kbPublishOptIn: true, kbSlug: 'helio', customDomain: null, kbPassphraseHash: null };

describe('isPubliclyLive', () => {
  it('is live with the site on and a slug, no passphrase', () => {
    expect(isPubliclyLive(base)).toBe(true);
  });

  it('is live via a custom domain without a slug', () => {
    expect(isPubliclyLive({ ...base, kbSlug: null, customDomain: 'help.acme.com' })).toBe(true);
  });

  it('is not live when the site is off', () => {
    expect(isPubliclyLive({ ...base, kbPublishOptIn: false })).toBe(false);
  });

  it('is not live without a slug or domain', () => {
    expect(isPubliclyLive({ ...base, kbSlug: null })).toBe(false);
  });

  it('is not public when passphrase-gated', () => {
    expect(isPubliclyLive({ ...base, kbPassphraseHash: 'hash' })).toBe(false);
  });

  it('detects the go-public transitions the details modal must gate', () => {
    const slugless = { ...base, kbSlug: null };
    expect(isPubliclyLive(slugless)).toBe(false);
    expect(isPubliclyLive({ ...slugless, kbSlug: 'helio' })).toBe(true); // first slug goes public

    const gated = { ...base, kbPassphraseHash: 'hash' };
    expect(isPubliclyLive(gated)).toBe(false);
    expect(isPubliclyLive({ ...gated, kbPassphraseHash: null })).toBe(true); // clearing the gate goes public
  });
});

describe('imprintComplete', () => {
  it('requires operator and contact', () => {
    expect(imprintComplete({ operator: 'Helio Community', contact: 'team@helio.dev' })).toBe(true);
  });

  it('rejects missing or blank pieces and empty imprints', () => {
    expect(imprintComplete(undefined)).toBe(false);
    expect(imprintComplete(null)).toBe(false);
    expect(imprintComplete({})).toBe(false);
    expect(imprintComplete({ operator: 'Helio Community' })).toBe(false);
    expect(imprintComplete({ contact: 'team@helio.dev' })).toBe(false);
    expect(imprintComplete({ operator: '  ', contact: 'team@helio.dev' })).toBe(false);
  });

  it('does not require the optional fields', () => {
    expect(imprintComplete({ operator: 'Helio', contact: 'a@b.c', representedBy: undefined })).toBe(true);
  });
});
