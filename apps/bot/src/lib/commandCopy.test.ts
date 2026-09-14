import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandDescription, SUBCOMMANDS } from './commandCopy';

/** Discord's limits on a subcommand. */
const NAME_MAX = 32;
const DESC_MAX = 100;

describe('SUBCOMMANDS', () => {
  it('keeps every description inside the Discord limit, suffix included', () => {
    for (const c of SUBCOMMANDS) {
      expect(c.name.length, c.name).toBeLessThanOrEqual(NAME_MAX);
      expect(commandDescription(c.name).length, c.name).toBeLessThanOrEqual(DESC_MAX);
    }
  });

  it('has no duplicate names', () => {
    const names = SUBCOMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks only the admin subcommands as admin', () => {
    const admin = SUBCOMMANDS.filter((c) => c.who === 'admin').map((c) => c.name);
    expect(admin).toEqual(['dashboard', 'setup', 'settings', 'website', 'rescan']);
  });
});

describe('README', () => {
  // The README can't import this table, so it drifts silently — the old command
  // list outlived two renames. This is the cheapest guard against that.
  it('documents every subcommand', () => {
    const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
    for (const c of SUBCOMMANDS) {
      expect(readme, `README is missing /dejavue ${c.name}`).toContain(`/dejavue ${c.name}`);
    }
  });
});
