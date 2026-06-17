import { describe, expect, it } from 'vitest';
import { buildSummaryContext } from './llm';

// ~245 chars each: 40 of them (~9.8k) exceed the whole-thread budget (8000) to force
// windowing, while the 15-message start window still fits the windowed input budget.
const long = (label: string) => `${label} ${'a'.repeat(240)}`;

describe('buildSummaryContext', () => {
  it('falls back to question + answer when there is no transcript', () => {
    const ctx = buildSummaryContext({
      title: 'Reset password',
      questionBody: 'I forgot my password.',
      acceptedAnswerText: 'Use the reset link.',
    });
    expect(ctx).toBe(
      'Thread title: Reset password\n\nQuestion:\nI forgot my password.\n\nAccepted answer / resolution:\nUse the reset link.',
    );
  });

  it('includes the WHOLE thread when it is short, marking the accepted answer', () => {
    const transcript = [
      { content: 'My build fails on CI.' },
      { content: 'Which Node version?' },
      { content: 'Pin the lockfile and clear the cache.' },
      { content: 'That worked, thanks!' },
    ];
    const ctx = buildSummaryContext({
      title: 'CI build fails',
      acceptedAnswerText: 'Pin the lockfile and clear the cache.',
      transcript,
    });
    expect(ctx).toContain('Thread title: CI build fails');
    expect(ctx).toContain('My build fails on CI.');
    expect(ctx).toContain('That worked, thanks!'); // whole thread present
    expect(ctx).toContain('[ACCEPTED ANSWER] Pin the lockfile and clear the cache.');
    expect(ctx).not.toContain('[…]'); // nothing omitted
  });

  it('keeps start + answer window and marks gaps when the thread is long', () => {
    const transcript = Array.from({ length: 40 }, (_, i) => ({ content: long(`M${i}`) }));
    const ctx = buildSummaryContext({
      title: 'Long thread',
      acceptedAnswerText: transcript[35]!.content, // answer near the end
      transcript,
    });
    // opening messages (start window of 15: M0..M14)
    expect(ctx).toContain('M0 ');
    expect(ctx).toContain('M14 ');
    // a gap is marked, and the middle is omitted
    expect(ctx).toContain('[…]');
    expect(ctx).not.toContain('M20 ');
    // window around the marked answer (M32..M38), answer tagged
    expect(ctx).toContain('[ACCEPTED ANSWER] M35 ');
    expect(ctx).toContain('M38 ');
  });

  it('uses the tail as the window when a long thread has no marked answer', () => {
    const transcript = Array.from({ length: 40 }, (_, i) => ({ content: long(`N${i}`) }));
    const ctx = buildSummaryContext({ title: 'Long unresolved', transcript });
    expect(ctx).toContain('N0 '); // start
    expect(ctx).toContain('[…]');
    expect(ctx).toContain('N39 '); // tail
    expect(ctx).not.toContain('[ACCEPTED ANSWER]'); // none marked
    expect(ctx).not.toContain('N20 '); // middle omitted
  });

  it('surfaces a paraphrased accepted answer that is not a transcript line', () => {
    const ctx = buildSummaryContext({
      title: 'Short thread',
      acceptedAnswerText: 'A paraphrased resolution not present verbatim.',
      transcript: [{ content: 'How do I do X?' }, { content: 'Try clicking the button.' }],
    });
    expect(ctx).not.toContain('[ACCEPTED ANSWER]'); // no exact match in transcript
    expect(ctx).toContain('Marked resolution:\nA paraphrased resolution not present verbatim.');
  });

  it('returns an empty string when there is nothing to summarize', () => {
    expect(buildSummaryContext({ title: '', transcript: [] })).toBe('');
  });

  it('bounds the windowed input size even with very long messages', () => {
    // 40 messages of 4000 chars each (~160k total) — without a cap this would be a
    // huge prompt. The windowed body must stay within the input ceiling.
    const transcript = Array.from({ length: 40 }, (_, i) => ({ content: `B${i} ${'z'.repeat(4000)}` }));
    const ctx = buildSummaryContext({
      title: 'Huge thread',
      acceptedAnswerText: transcript[38]!.content,
      transcript,
    });
    // Per-message clip (1500) + input ceiling (9000) → well under ~13k even with overhead.
    expect(ctx.length).toBeLessThan(13000);
    expect(ctx).toContain('…'); // a long message was clipped
    expect(ctx).toContain('[ACCEPTED ANSWER]'); // resolution still present
  });
});
