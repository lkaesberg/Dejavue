import { describe, expect, it } from 'vitest';
import { buildEmbeddingText, embedContentHash } from './embeddings';

describe('buildEmbeddingText', () => {
  it('falls back to title + question + answer when there is no transcript', () => {
    const text = buildEmbeddingText({
      title: 'How do I reset my password?',
      questionBody: 'I forgot it and the email never arrives.',
      acceptedAnswerText: 'Use the /reset command in #support.',
    });
    expect(text).toBe(
      'How do I reset my password?\n\nI forgot it and the email never arrives.\n\nUse the /reset command in #support.',
    );
  });

  it('includes the question window and the accepted-answer window around the answer', () => {
    const transcript = [
      { content: 'Q: My build fails on CI but works locally.' }, // 0 (question window)
      { content: 'Which Node version?' }, // 1 (question window)
      { content: 'Node 22.' }, // 2 (question window)
      { content: 'Have you tried clearing the cache?' }, // 3 (answer-1 neighbour)
      { content: 'Pin the lockfile and delete node_modules.' }, // 4 (accepted answer)
      { content: 'That fixed it, thanks!' }, // 5 (answer+1 neighbour)
    ];
    const text = buildEmbeddingText({
      title: 'CI build fails',
      acceptedAnswerText: 'Pin the lockfile and delete node_modules.',
      transcript,
    });
    const parts = text.split('\n\n');
    expect(parts[0]).toBe('CI build fails');
    // question window (first 3 messages)
    expect(parts).toContain('Q: My build fails on CI but works locally.');
    expect(parts).toContain('Node 22.');
    // answer ± 1 neighbours
    expect(parts).toContain('Have you tried clearing the cache?');
    expect(parts).toContain('Pin the lockfile and delete node_modules.');
    expect(parts).toContain('That fixed it, thanks!');
  });

  it('includes the tail when there is no accepted answer (knowledge channel)', () => {
    const transcript = [
      { content: 'Today we shipped the new caching layer.' },
      { content: 'It reduced p99 latency by 40%.' },
      { content: 'Config lives in cache.yaml.' },
      { content: 'Remember to set TTLs per route.' },
      { content: 'Follow-up: monitor eviction rates next week.' },
    ];
    const text = buildEmbeddingText({ title: 'Caching layer notes', transcript });
    const parts = text.split('\n\n');
    expect(parts[0]).toBe('Caching layer notes');
    // opening window
    expect(parts).toContain('Today we shipped the new caching layer.');
    // tail (last messages) are appended for context around the "answer"
    expect(parts).toContain('Follow-up: monitor eviction rates next week.');
  });

  it('de-duplicates overlapping windows and preserves order', () => {
    const transcript = [
      { content: 'one' },
      { content: 'two' },
      { content: 'three' }, // both the 3rd question-window message AND the accepted answer
    ];
    const text = buildEmbeddingText({
      title: 'short thread',
      acceptedAnswerText: 'three',
      transcript,
    });
    const parts = text.split('\n\n');
    // "three" appears once despite being in both windows
    expect(parts.filter((p) => p === 'three')).toHaveLength(1);
    expect(parts).toEqual(['short thread', 'one', 'two', 'three']);
  });

  it('returns an empty string when there is nothing to embed', () => {
    expect(buildEmbeddingText({ title: '', transcript: [] })).toBe('');
  });

  it('selects start, end, and high-value (most-reacted) messages', () => {
    const transcript = Array.from({ length: 12 }, (_, i) => ({
      content: `m${i}`,
      reactions: i === 6 ? 9 : 0,
    }));
    const parts = buildEmbeddingText({ title: 'T', transcript }).split('\n\n');
    // start window
    expect(parts).toContain('m0');
    expect(parts).toContain('m2');
    // end window
    expect(parts).toContain('m9');
    expect(parts).toContain('m11');
    // high-value middle message (9 reactions) is pulled in despite being mid-thread
    expect(parts).toContain('m6');
    // a low-value middle message in no window is left out
    expect(parts).not.toContain('m4');
  });
});

describe('embedContentHash (stale-vector detection)', () => {
  it('is stable for identical embed-source content', () => {
    const src = { title: 'T', questionBody: 'Q', transcript: [{ content: 'a' }, { content: 'b' }] };
    expect(embedContentHash(src)).toBe(embedContentHash({ ...src }));
  });

  it('changes when content within the embed window changes (edit/delete propagates)', () => {
    const base = embedContentHash({ title: 'T', transcript: [{ content: 'a' }, { content: 'b' }] });
    const edited = embedContentHash({ title: 'T', transcript: [{ content: 'a' }, { content: 'B!' }] });
    expect(edited).not.toBe(base);
  });

  it('ignores edits to middle messages outside the start/end/high-value windows', () => {
    const mk = (c5: string) =>
      Array.from({ length: 12 }, (_, i) => ({ content: i === 5 ? c5 : `m${i}`, reactions: 0 }));
    expect(embedContentHash({ title: 'T', transcript: mk('m5') })).toBe(
      embedContentHash({ title: 'T', transcript: mk('m5-edited') }),
    );
  });
});
