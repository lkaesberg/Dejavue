import { describe, expect, it } from 'vitest';
import { buildEmbeddingChunks, embedContentHash } from './embeddings';

/** A transcript long enough to span several chunks (~100 chars per message). */
const longTranscript = (n: number, edit?: { at: number; to: string }) =>
  Array.from({ length: n }, (_, i) => ({
    content: edit && edit.at === i ? edit.to : `message number ${i} ${'x'.repeat(80)}`,
  }));

describe('buildEmbeddingChunks', () => {
  it('puts the canonical title + question + answer in chunk 0', () => {
    const [chunk0] = buildEmbeddingChunks({
      title: 'How do I reset my password?',
      questionBody: 'I forgot it and the email never arrives.',
      acceptedAnswerText: 'Use the /reset command in #support.',
    });
    expect(chunk0?.index).toBe(0);
    expect(chunk0?.text).toBe(
      'How do I reset my password?\n\nI forgot it and the email never arrives.\n\nUse the /reset command in #support.',
    );
  });

  it('covers EVERY non-empty transcript message across the chunk set', () => {
    const transcript = longTranscript(60);
    const joined = buildEmbeddingChunks({ title: 'T', transcript })
      .map((c) => c.text)
      .join('\n\n');
    // The property the old sampled-passage design could not satisfy: nothing is dropped.
    for (const m of transcript) expect(joined).toContain(m.content);
  });

  it('splits an oversized single message across chunks instead of truncating it', () => {
    const huge = 'A'.repeat(5000) + 'NEEDLE_AT_THE_END';
    const joined = buildEmbeddingChunks({ title: 'T', transcript: [{ content: huge }] })
      .map((c) => c.text)
      .join('');
    expect(joined).toContain('NEEDLE_AT_THE_END');
  });

  it('produces multiple chunks for a long thread and one for a short one', () => {
    expect(buildEmbeddingChunks({ title: 'T', transcript: longTranscript(60) }).length).toBeGreaterThan(2);
    expect(buildEmbeddingChunks({ title: 'T', transcript: longTranscript(2) })).toHaveLength(2);
  });

  it('gives every chunk a unique, increasing index and a hash of its own text', () => {
    const chunks = buildEmbeddingChunks({ title: 'T', transcript: longTranscript(60) });
    const indices = chunks.map((c) => c.index);
    // Sparse by design (a reserved band per message-group), but unique and ordered.
    expect(new Set(indices).size).toBe(indices.length);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(indices[0]).toBe(0);
    expect(new Set(chunks.map((c) => c.hash)).size).toBe(chunks.length);
  });

  it('keeps chunk indices stable when an earlier message is edited', () => {
    const before = buildEmbeddingChunks({ title: 'T', transcript: longTranscript(60) });
    const after = buildEmbeddingChunks({
      title: 'T',
      transcript: longTranscript(60, { at: 10, to: 'a much shorter body' }),
    });
    // The whole point of position-pinned boundaries: a length change upstream must not
    // renumber (and therefore re-embed) every chunk downstream.
    expect(after.map((c) => c.index)).toEqual(before.map((c) => c.index));
  });

  it('returns nothing when there is nothing to embed', () => {
    expect(buildEmbeddingChunks({ title: '', transcript: [] })).toEqual([]);
  });

  describe('incremental re-embed cost', () => {
    const hashesOf = (transcript: { content: string }[]) =>
      buildEmbeddingChunks({ title: 'T', transcript }).map((c) => c.hash);

    it('changes at most two chunks when a mid-thread message is edited', () => {
      const before = hashesOf(longTranscript(60));
      const after = hashesOf(longTranscript(60, { at: 30, to: 'totally different content here' }));
      const changed = after.filter((h, i) => h !== before[i]).length;
      expect(changed).toBeGreaterThan(0); // the edit propagates at all
      expect(changed).toBeLessThanOrEqual(2); // ...but only locally (chunk + overlap)
    });

    it('leaves chunk 0 untouched when only the transcript changes', () => {
      const src = { title: 'T', questionBody: 'Q', acceptedAnswerText: 'A' };
      const before = buildEmbeddingChunks({ ...src, transcript: longTranscript(60) });
      const after = buildEmbeddingChunks({
        ...src,
        transcript: longTranscript(60, { at: 30, to: 'edited' }),
      });
      expect(after[0]?.hash).toBe(before[0]?.hash);
    });

    it('changes at most two chunks when a message is appended', () => {
      const before = hashesOf(longTranscript(60));
      const after = hashesOf([...longTranscript(60), { content: 'a brand new reply' }]);
      const changed = after.filter((h, i) => h !== before[i]).length;
      expect(changed).toBeLessThanOrEqual(2); // trailing chunk + at most one new chunk
    });
  });

  describe('EMBED_MAX_CHUNKS_PER_THREAD', () => {
    it('is unlimited at 0 (the default)', () => {
      const chunks = buildEmbeddingChunks({ title: 'T', transcript: longTranscript(80) }, 0);
      expect(chunks.length).toBeGreaterThan(4);
    });

    it('caps the chunk count while keeping chunk 0 and the accepted answer', () => {
      const transcript = longTranscript(80);
      const answer = transcript[40]!.content;
      const chunks = buildEmbeddingChunks({ title: 'T', acceptedAnswerText: answer, transcript }, 4);
      expect(chunks).toHaveLength(4);
      expect(chunks[0]?.text).toContain('T');
      // the resolution survives the cap
      expect(chunks.map((c) => c.text).join('\n\n')).toContain(answer);
    });
  });
});

describe('embedContentHash (stale-vector detection)', () => {
  it('is stable for identical embed-source content', () => {
    const src = { title: 'T', questionBody: 'Q', transcript: [{ content: 'a' }, { content: 'b' }] };
    expect(embedContentHash(src)).toBe(embedContentHash({ ...src }));
  });

  it('changes when a message is edited', () => {
    const base = embedContentHash({ title: 'T', transcript: [{ content: 'a' }, { content: 'b' }] });
    const edited = embedContentHash({ title: 'T', transcript: [{ content: 'a' }, { content: 'B!' }] });
    expect(edited).not.toBe(base);
  });

  it('NOW detects edits to middle messages (the old passage hash could not)', () => {
    const mk = (c30: string) => longTranscript(60, { at: 30, to: c30 });
    expect(embedContentHash({ title: 'T', transcript: mk('m30') })).not.toBe(
      embedContentHash({ title: 'T', transcript: mk('m30-edited') }),
    );
  });
});
