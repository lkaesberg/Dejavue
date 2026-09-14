import type { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { assertRowBudget, MAX_ROWS, navId, navRow, navTarget, navNeedsAdmin } from './hubNav';

/**
 * A button's JSON is a union that includes premium (SKU) buttons, which carry
 * neither a label nor a custom id. The nav row never builds those.
 */
interface PlainButton {
  label?: string;
  custom_id?: string;
  disabled?: boolean;
}
const buttons = (row: ActionRowBuilder<ButtonBuilder>): PlainButton[] =>
  row.components.map((b) => b.toJSON() as PlainButton);

describe('navRow', () => {
  it('never exceeds the five buttons an action row allows', () => {
    expect(navRow('dashboard', { admin: true }).components.length).toBeLessThanOrEqual(5);
  });

  it('shows a non-admin only the hubs they can open', () => {
    const labels = buttons(navRow('insights', { admin: false })).map((b) => b.label);
    expect(labels).toEqual(['Insights', 'Help']);
  });

  it('disables the hub you are already in', () => {
    const dash = buttons(navRow('dashboard', { admin: true }));
    expect(dash.find((b) => b.label === 'Dashboard')?.disabled).toBe(true);
    expect(dash.find((b) => b.label === 'Settings')?.disabled).toBeFalsy();
  });

  it('turns the active slot into an enabled Back button when a page needs one', () => {
    const row = buttons(navRow('website', { admin: true, backTo: 'dejavue:cust:site:back' }));
    const back = row.find((b) => b.label === 'Back');
    expect(back).toBeDefined();
    expect(back?.custom_id).toBe('dejavue:cust:site:back');
    expect(back?.disabled).toBeFalsy();
    expect(row.some((b) => b.label === 'Website')).toBe(false);
  });
});

describe('navTarget', () => {
  it('round-trips every hub id', () => {
    for (const hub of ['dashboard', 'settings', 'website', 'insights', 'help'] as const) {
      expect(navTarget(navId(hub))).toBe(hub);
    }
  });

  it('rejects ids that are not navigation', () => {
    expect(navTarget('dv:s:nudges:toggle')).toBeNull();
    expect(navTarget('dv:nav:nonsense')).toBeNull();
  });

  it('gates only the admin hubs', () => {
    expect(navNeedsAdmin('settings')).toBe(true);
    // Insights and help are open to every member — gating them would refuse a
    // permission the viewer does not actually need.
    expect(navNeedsAdmin('insights')).toBe(false);
    expect(navNeedsAdmin('help')).toBe(false);
  });
});

describe('assertRowBudget', () => {
  it('passes a payload at the limit and throws one over it', () => {
    const rows = Array.from({ length: MAX_ROWS }, (_, i) => i);
    expect(assertRowBudget(rows, 'test')).toBe(rows);
    // discord.js does not check this itself — without the assertion a sixth row
    // is a 400 in someone's server rather than a failing test.
    expect(() => assertRowBudget([...rows, 6], 'test')).toThrow(/exceeds Discord/);
  });
});
