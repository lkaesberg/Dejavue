import type { GuildConfig } from '@dejavue/db';
import type { Tier } from '@dejavue/core';
import { describe, expect, it } from 'vitest';
import { websiteHubPayload, type WebsitePageId } from './customize';
import { MAX_ROWS } from './hubNav';

function cfg(patch: Partial<GuildConfig> = {}): GuildConfig {
  return {
    brandName: null,
    kbSlug: null,
    customDomain: null,
    kbPublishOptIn: false,
    kbPassphraseHash: null,
    kbImprint: null,
    kbTheme: 'light',
    kbAccent: 'indigo',
    kbCorners: 'rounded',
    kbHeadingFont: 'grotesk',
    ...patch,
  } as GuildConfig;
}

const PAGES: WebsitePageId[] = ['site', 'appearance'];
const TIERS: Tier[] = ['free', 'plus', 'pro', 'max'];
const build = (page: WebsitePageId, tier: Tier, c = cfg()) =>
  websiteHubPayload(c, tier, 'dejavue.app', page, { admin: true });

describe('website hub', () => {
  it('stays inside the five-row limit on every page and tier', () => {
    // The appearance page is exactly at the limit: four selects plus the nav
    // row. discord.js won't catch a sixth — it fails as a 400 in production.
    for (const page of PAGES) {
      for (const tier of TIERS) {
        expect(build(page, tier).components?.length, `${page}/${tier}`).toBeLessThanOrEqual(MAX_ROWS);
      }
    }
  });

  it('gives the appearance page a Back button instead of a dead Website slot', () => {
    const nav = build('appearance', 'plus').components?.at(-1) as {
      toJSON(): { components: { label?: string }[] };
    };
    const labels = nav.toJSON().components.map((b) => b.label);
    expect(labels).toContain('Back');
    expect(labels).not.toContain('Website');
  });

  it('renders a fully-configured public site without throwing', () => {
    const live = cfg({
      brandName: 'Helio',
      kbSlug: 'helio',
      customDomain: 'help.helio.dev',
      kbPublishOptIn: true,
      kbPassphraseHash: 'hash',
      kbImprint: { operator: 'Helio', contact: 'a@b.c' },
      kbTheme: 'dark',
    });
    for (const page of PAGES) expect(() => build(page, 'max', live)).not.toThrow();
  });

  it('warns on the site page when a public site has no imprint', () => {
    const naked = cfg({ kbSlug: 'helio', kbPublishOptIn: true });
    const embed = build('site', 'plus', naked).embeds?.[0] as { data: { description: string } };
    expect(embed.data.description).toContain('imprint is incomplete');
  });
});
