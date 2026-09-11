import { describe, expect, it } from 'vitest';
import { ALLOWED_PROPS, EVENTS, sanitize } from './index';

/**
 * These tests ARE the privacy guarantee. Dejavue publicly states that it does not profile
 * visitors and never processes message content for analytics; `sanitize` is what makes
 * that structurally true rather than a matter of call-site discipline. A failure here
 * means content can leave the process — treat it as a release blocker, not a warning.
 */
describe('sanitize (privacy boundary)', () => {
  it('drops every key that is not explicitly allowed', () => {
    const out = sanitize({
      // The things that must never leave: content, identity, and free text.
      content: 'my database password is hunter2',
      title: 'How do I reset my password?',
      query: 'sensitive internal search term',
      user_id: '123456789012345678',
      author_name: 'somebody',
      email: 'a@b.com',
      message: 'hello',
      // ...alongside one legitimate key.
      tier: 'plus',
    });
    expect(out).toEqual({ tier: 'plus' });
  });

  it('drops long strings even under an allowed key', () => {
    // Guards against smuggling free text through an enum-shaped field.
    expect(sanitize({ reason: 'x'.repeat(500) })).toEqual({});
    expect(sanitize({ reason: 'backfill' })).toEqual({ reason: 'backfill' });
  });

  it('drops non-scalar values (no nested objects or arrays escape)', () => {
    expect(sanitize({ tier: { nested: 'object' } as never })).toEqual({});
    expect(sanitize({ tier: ['a', 'b'] as never })).toEqual({});
  });

  it('drops null, undefined and non-finite numbers', () => {
    expect(sanitize({ tokens: null, chunks: undefined, cap: Number.NaN })).toEqual({});
    expect(sanitize({ tokens: 0, chunks: 12 })).toEqual({ tokens: 0, chunks: 12 });
  });

  it('keeps booleans', () => {
    expect(sanitize({ success: false })).toEqual({ success: false });
  });

  it('returns an empty object for no props', () => {
    expect(sanitize(undefined)).toEqual({});
  });

  it('has no free-text field in the allowlist', () => {
    // If one of these ever becomes allowed, content has somewhere to hide.
    for (const banned of ['content', 'text', 'title', 'query', 'body', 'message', 'name', 'summary']) {
      expect(ALLOWED_PROPS.has(banned)).toBe(false);
    }
  });

  it('has no user-identifying field in the allowlist', () => {
    for (const banned of ['user_id', 'author_id', 'username', 'email', 'ip']) {
      expect(ALLOWED_PROPS.has(banned)).toBe(false);
    }
  });
});

describe('event vocabulary', () => {
  it('is unique and non-empty', () => {
    expect(new Set(EVENTS).size).toBe(EVENTS.length);
    expect(EVENTS.length).toBeGreaterThan(0);
  });
});
