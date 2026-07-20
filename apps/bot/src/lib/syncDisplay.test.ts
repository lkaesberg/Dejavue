import type { ChannelSync } from '@dejavue/db';
import { describe, expect, it } from 'vitest';
import { channelSyncDisplay, joinChannelLines, sinceLabel, staleReasonLabel } from './syncDisplay';

const NOW = 1_700_000_000_000;

function sync(patch: Partial<ChannelSync>): ChannelSync {
  return {
    state: 'synced',
    staleReason: null,
    indexedMessageCount: 0,
    lastReindexAt: null,
    ...patch,
  } as ChannelSync;
}

describe('sinceLabel', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(sinceLabel(NOW - 5_000, NOW)).toBe('5s');
    expect(sinceLabel(NOW - 3 * 60_000, NOW)).toBe('3m');
    expect(sinceLabel(NOW - 2 * 3_600_000, NOW)).toBe('2h');
  });
});

describe('staleReasonLabel', () => {
  it('explains each stale reason in plain language', () => {
    expect(staleReasonLabel('cap')).toBe('index full — upgrade or free space');
    expect(staleReasonLabel('gap')).toBe('catching up on missed messages');
    expect(staleReasonLabel('edit')).toBe('syncing recent changes');
    expect(staleReasonLabel('delete')).toBe('syncing recent changes');
    expect(staleReasonLabel(null)).toContain('rescan');
  });
});

describe('joinChannelLines', () => {
  it('joins with newlines when everything fits', () => {
    expect(joinChannelLines(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('returns an empty string for no channels', () => {
    expect(joinChannelLines([])).toBe('');
  });

  it('truncates and appends a count when the field limit would overflow', () => {
    // 40 blocks of a realistic 2-line status; must never exceed Discord's 1024 cap.
    const block = '✅ up to date · 50,000 msgs · scanned 12h ago\n<#123456789012345678>';
    const out = joinChannelLines(Array.from({ length: 40 }, () => block));
    expect(out.length).toBeLessThanOrEqual(1024);
    expect(out).toMatch(/…and \d+ more channels$/);
  });

  it('keeps every block when the joined length is exactly within the limit', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    expect(joinChannelLines(blocks, 1024)).toBe(blocks.join('\n'));
  });
});

describe('channelSyncDisplay', () => {
  it('shows a live first-setup import with progress', () => {
    const line = channelSyncDisplay(undefined, { processed: 42, total: 100, flavor: 'import' }, NOW);
    expect(line).toBe('📥 importing history… 42%');
  });

  it('shows a live re-scan with progress', () => {
    const line = channelSyncDisplay(sync({}), { processed: 1, total: 2, flavor: 'rescan' }, NOW);
    expect(line).toBe('🔄 re-scanning… 50%');
  });

  it('omits the percentage when the total is not known yet', () => {
    const line = channelSyncDisplay(undefined, { processed: 0, total: 0, flavor: 'import' }, NOW);
    expect(line).toBe('📥 importing history…');
  });

  it('nudges toward a rescan when never indexed', () => {
    expect(channelSyncDisplay(undefined, undefined, NOW)).toContain('not indexed yet');
    expect(channelSyncDisplay(sync({ state: 'never' }), undefined, NOW)).toContain('not indexed yet');
  });

  it('shows a re-scan in flight without a job row', () => {
    expect(channelSyncDisplay(sync({ state: 'reindexing' }), undefined, NOW)).toBe('🔄 re-scanning…');
  });

  it('explains stale states', () => {
    expect(channelSyncDisplay(sync({ state: 'stale', staleReason: 'cap' }), undefined, NOW)).toBe(
      '⚠️ index full — upgrade or free space',
    );
  });

  it('confirms up to date with counts and last-scan age', () => {
    const line = channelSyncDisplay(
      sync({ indexedMessageCount: 1247, lastReindexAt: new Date(NOW - 3 * 60_000) }),
      undefined,
      NOW,
    );
    expect(line).toBe('✅ up to date · 1,247 msgs · scanned 3m ago');
  });

  it('confirms up to date without a scan timestamp', () => {
    expect(channelSyncDisplay(sync({ indexedMessageCount: 3 }), undefined, NOW)).toBe(
      '✅ up to date · 3 msgs',
    );
  });
});
