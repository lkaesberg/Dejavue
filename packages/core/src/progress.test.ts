import { describe, expect, it } from 'vitest';
import { genProgressEmbed, reindexProgressEmbed, renderProgressBar } from './progress';

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

  it('renders a retryable failure', () => {
    const e = reindexProgressEmbed({ channelLabel: '#x', kind: 'forum', phase: 'failed', error: 'boom' });
    expect(e.description).toContain('boom');
    expect(e.description).toContain('rescan');
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
