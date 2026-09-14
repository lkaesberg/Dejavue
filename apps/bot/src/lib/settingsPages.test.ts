import type { GuildConfig } from '@dejavue/db';
import { describe, expect, it } from 'vitest';
import { MAX_ROWS } from './hubNav';
import {
  ctrl,
  DEFAULT_PAGE,
  PAGER_ID,
  pageOf,
  pagerRow,
  SETTINGS_PAGES,
  settingsPage,
} from './settingsPages';

/** Discord's per-option caps on a string select. */
const OPTION_LABEL_MAX = 100;
const OPTION_DESC_MAX = 100;

function cfg(patch: Partial<GuildConfig> = {}): GuildConfig {
  return {
    nudgeEnabled: false,
    nudgeAfterHours: 24,
    nudgeHelperRoleId: null,
    channelFitCheck: false,
    guardEnabled: false,
    guardAutoClose: false,
    guardSensitivity: 'medium',
    dedupSensitivity: 'medium',
    removeSolvedPrompt: true,
    brandingEnabled: true,
    ...patch,
  } as GuildConfig;
}

const CTXS = [{ brandingLocked: false }, { brandingLocked: true }];

describe('settings pages', () => {
  it('leaves room for the pager and the nav row on every page', () => {
    // The nudges page sits exactly at the limit: pager + 3 controls + nav = 5.
    for (const page of SETTINGS_PAGES) {
      for (const ctx of CTXS) {
        const rows = page.rows(cfg(), ctx).length;
        expect(1 + rows + 1, `${page.id} overflows the row budget`).toBeLessThanOrEqual(MAX_ROWS);
      }
    }
  });

  it('renders for both an untouched guild and a fully-configured one', () => {
    const configured = cfg({
      nudgeEnabled: true,
      nudgeHelperRoleId: '123',
      channelFitCheck: true,
      guardEnabled: true,
      guardAutoClose: true,
      dedupSensitivity: '72',
      removeSolvedPrompt: false,
      brandingEnabled: false,
    });
    for (const page of SETTINGS_PAGES) {
      for (const ctx of CTXS) {
        expect(() => page.fields(configured, ctx)).not.toThrow();
        expect(() => page.rows(configured, ctx)).not.toThrow();
        expect(page.fields(cfg(), ctx).length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the pager options inside the select limits', () => {
    const options = pagerRow(DEFAULT_PAGE).components[0]!.toJSON().options ?? [];
    expect(options.length).toBe(SETTINGS_PAGES.length);
    expect(options.length).toBeLessThanOrEqual(25);
    for (const o of options) {
      expect(o.label.length, o.label).toBeLessThanOrEqual(OPTION_LABEL_MAX);
      expect((o.description ?? '').length, o.label).toBeLessThanOrEqual(OPTION_DESC_MAX);
    }
  });

  it('marks the page you are on as the pager default', () => {
    const options = pagerRow('routing').components[0]!.toJSON().options ?? [];
    expect(options.filter((o) => o.default).map((o) => o.value)).toEqual(['routing']);
  });
});

describe('branding toggle', () => {
  const brandingButton = (ctx: { brandingLocked: boolean }, c = cfg()) =>
    settingsPage('cleanup')
      .rows(c, ctx)[0]!
      .toJSON()
      .components.map((b) => b as { custom_id?: string; label?: string; disabled?: boolean })
      .find((b) => b.custom_id === ctrl('cleanup', 'branding'))!;

  it('is locked on a plan that cannot remove the branding', () => {
    // Free always carries the footer — showBrandingFor doesn't even read the
    // column there, so the control must not look changeable.
    const btn = brandingButton({ brandingLocked: true }, cfg({ brandingEnabled: false }));
    expect(btn.disabled).toBe(true);
    expect(btn.label).toContain('Plus');
  });

  it('is usable on a paid plan', () => {
    const btn = brandingButton({ brandingLocked: false });
    expect(btn.disabled).toBeFalsy();
    expect(btn.label).not.toContain('Plus');
  });
});

describe('pageOf', () => {
  it('recovers the page from every control id a page renders', () => {
    // This is the whole of the hub's page state: a control names its own page,
    // so nothing has to be stashed on the message or read back off a select.
    for (const page of SETTINGS_PAGES) {
      for (const ctx of CTXS) {
        for (const row of page.rows(cfg(), ctx)) {
          for (const c of row.toJSON().components) {
            const id = (c as { custom_id?: string }).custom_id;
            expect(pageOf(id ?? ''), id).toBe(page.id);
          }
        }
      }
    }
  });

  it('carries the page through the custom-threshold modal round-trip', () => {
    // The modal used to re-render with no page context, bouncing the admin back
    // to Overview after typing a threshold.
    expect(pageOf(ctrl('duplicates', 'custommodal'))).toBe('duplicates');
  });

  it('has no page of its own for the pager, and rejects foreign ids', () => {
    expect(pageOf(PAGER_ID)).toBeNull();
    expect(pageOf('dv:d:rescan')).toBeNull();
    expect(pageOf('dv:s:nonsense:thing')).toBeNull();
  });
});

describe('settingsPage', () => {
  it('falls back to the default page for an unknown id', () => {
    expect(settingsPage('nope' as never).id).toBe(DEFAULT_PAGE);
  });
});
