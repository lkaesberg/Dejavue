import { describe, expect, it } from 'vitest';
import { backfillProgressEmbed, genProgressEmbed, reindexProgressEmbed, renderProgressBar } from './progress';

describe('renderProgressBar', () => {
  it('renders a percentage bar', () => {
    expect(renderProgressBar(3, 10, 10)).toBe('███░░░░░░░ 30%');
    expect(renderProgressBar(10, 10, 10)).toBe('██████████ 100%');
  });

  it('caps at 100% and never overflows the width', () => {
    expect(renderProgressBar(15, 10, 10)).toBe('██████████ 100%');
  });

  it('falls back to a scanned-count label when the total is unknown', () => {
    expect(renderProgressBar(0, 0)).toBe('starting…');
    expect(renderProgressBar(42, 0)).toBe('42 scanned');
  });
});

describe('reindexProgressEmbed', () => {
  it('summarizes the done state with counts and removals', () => {
    const e = reindexProgressEmbed({ channelLabel: '#x', kind: 'tracked', phase: 'done', done: 5, removed: 2 });
    expect(e.title).toContain('up to date');
    expect(e.description).toContain('5');
    expect(e.description).toContain('Removed 2');
  });

  it('uses "catching up" copy on the auto path', () => {
    const e = reindexProgressEmbed({ channelLabel: '#x', kind: 'tracked', phase: 'queued', auto: true });
    expect(e.title).toContain('Catching up');
  });

  it('says a deleted channel was dropped, without the unresolvable mention', () => {
    const e = reindexProgressEmbed({ channelLabel: '<#123>', kind: 'forum', phase: 'gone', removed: 4 });
    expect(e.title).toContain('no longer exists');
    expect(e.title).not.toContain('<#123>');
    expect(e.description).toContain('stopped watching it');
    expect(e.description).toContain('4 archived posts');
    expect(e.description).not.toContain('rescan');
    const none = reindexProgressEmbed({ channelLabel: '<#123>', kind: 'forum', phase: 'gone' });
    expect(none.description).not.toContain('archived');
  });

  it('renders a retryable failure', () => {
    const e = reindexProgressEmbed({ channelLabel: '#x', kind: 'forum', phase: 'failed', error: 'boom' });
    expect(e.description).toContain('boom');
    expect(e.description).toContain('rescan');
  });
});

describe('backfillProgressEmbed', () => {
  it('renders the importing phase with a progress bar', () => {
    const e = backfillProgressEmbed({ channelLabel: '<#1>', phase: 'importing', done: 3, total: 10 });
    expect(e.title).toContain('Importing existing posts');
    expect(e.description).toContain('%');
    expect(e.description).toContain('3 / 10');
  });

  it('summarizes the done state as up to date', () => {
    const e = backfillProgressEmbed({ channelLabel: '<#1>', phase: 'done', done: 42, total: 42 });
    expect(e.title).toContain('up to date');
    expect(e.description).toContain('Imported 42 posts');
    expect(e.description).toContain('indexed automatically');
  });

  it('mentions failed imports in the done state', () => {
    const e = backfillProgressEmbed({ channelLabel: '<#1>', phase: 'done', done: 40, total: 42, failedCount: 2 });
    expect(e.description).toContain('2 could not be imported');
    // A partial import is not "up to date".
    expect(e.title).not.toContain('up to date');
    expect(e.description).not.toContain('indexed automatically');
  });

  it('flags a re-scan with failed threads as partly indexed', () => {
    const ok = reindexProgressEmbed({ channelLabel: '<#1>', kind: 'forum', phase: 'done', done: 5 });
    expect(ok.title).toContain('up to date');
    const e = reindexProgressEmbed({ channelLabel: '<#1>', kind: 'forum', phase: 'done', done: 3, failedCount: 2 });
    expect(e.title).not.toContain('up to date');
    expect(e.description).toContain('2 could not be indexed');
    expect(e.description).not.toContain('Up to date');
  });

  it('explains the cap when the import stopped early', () => {
    const e = backfillProgressEmbed({ channelLabel: '<#1>', phase: 'done', done: 10, total: 42, capped: true });
    expect(e.title).toContain('index full');
    expect(e.description).toContain('rescan');
  });

  it('renders a resumable failure', () => {
    const e = backfillProgressEmbed({ channelLabel: '<#1>', phase: 'failed', error: 'boom' });
    expect(e.description).toContain('boom');
    expect(e.description).toContain('Progress is saved');
  });
});

describe('genProgressEmbed', () => {
  it('shows a placeholder when the final body is empty', () => {
    const e = genProgressEmbed({ kind: 'faq', phase: 'done', body: '' });
    expect(e.description).toContain('Nothing to show yet');
  });

  it('includes the rendered body when present', () => {
    const e = genProgressEmbed({ kind: 'cluster', phase: 'done', body: '• topic — 3 asks' });
    expect(e.description).toContain('• topic — 3 asks');
    expect(e.description).toContain('Updated just now');
  });
});
