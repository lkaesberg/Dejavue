import { describe, expect, it } from 'vitest';
import { channelPath, channelSlug, extractThreadId, threadPath, threadSlug } from './slug';

describe('threadSlug', () => {
  it('turns titles into url-safe slugs', () => {
    expect(threadSlug('How do I rotate my API key?')).toBe('how-do-i-rotate-my-api-key');
    expect(threadSlug('  Weird  --  spacing!! ')).toBe('weird-spacing');
  });

  it('strips diacritics and expands ß', () => {
    expect(threadSlug('Café crème übergroß')).toBe('cafe-creme-ubergross');
  });

  it('keeps slugs short, cutting at a word boundary', () => {
    const slug = threadSlug('How can I configure the webhook retry policy for outgoing integrations');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('how-can-i-configure-the-webhook-retry');
  });

  it('falls back for titles with no usable characters', () => {
    expect(threadSlug('🔥🔥🔥')).toBe('q');
  });
});

describe('channelSlug / channelPath', () => {
  it('slugs channel names with a general fallback', () => {
    expect(channelSlug('API Help')).toBe('api-help');
    expect(channelSlug(null)).toBe('general');
    expect(channelSlug('💬')).toBe('general');
  });

  it('builds the channel listing path from any row shape', () => {
    expect(channelPath({ name: 'API Help' })).toBe('/c/api-help');
    expect(channelPath({ channelName: 'API Help' })).toBe('/c/api-help');
    expect(channelPath({ channel: 'API Help' })).toBe('/c/api-help');
    // Matches the channel segment of thread paths, so threads nest under it.
    const thread = { threadId: '1234567890123456789', title: 'Q', channelName: 'API Help' };
    expect(threadPath(thread).startsWith(`${channelPath(thread)}/`)).toBe(true);
  });
});

describe('threadPath / extractThreadId', () => {
  const t = {
    threadId: '1234567890123456789',
    title: 'How do I rotate my API key?',
    channelName: 'API Help',
  };

  it('builds /c/{channel}/{slug}-{id} and the id survives', () => {
    const path = threadPath(t);
    expect(path).toBe('/c/api-help/how-do-i-rotate-my-api-key-1234567890123456789');
    expect(extractThreadId(path.split('/').pop()!)).toBe(t.threadId);
  });

  it('accepts KbSearchResult rows, which name the channel `channel`', () => {
    expect(threadPath({ threadId: t.threadId, title: t.title, channel: 'API Help' })).toBe(
      threadPath(t),
    );
  });

  it('accepts bare ids (legacy urls) and rejects junk', () => {
    expect(extractThreadId('1234567890123456789')).toBe('1234567890123456789');
    expect(extractThreadId('some-title-with-no-id')).toBeUndefined();
    expect(extractThreadId('short-123')).toBeUndefined();
  });

  it('extracts the id even when the title itself ends in digits', () => {
    expect(extractThreadId('error-404-1234567890123456789')).toBe('1234567890123456789');
  });
});
