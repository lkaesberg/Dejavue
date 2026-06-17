// Shared text helpers for building LLM/embedding context from a thread transcript.

/**
 * Minimum answer length before we trust a substring ("message contains the answer")
 * match. Short accepted answers ("yes", "restart") substring-match unrelated lines,
 * so below this we require an exact match only.
 */
const ANSWER_MATCH_MIN_CHARS = 24;

/**
 * Locate the accepted-answer message within a transcript. Prefers an exact match;
 * falls back to "a message that contains the answer text" only when the answer is
 * long enough to be distinctive. Scans from the END because a resolution clusters
 * near the end of a thread (and avoids matching an earlier quote of the answer).
 * Returns -1 when not found (e.g. the answer was paraphrased, not a verbatim line).
 *
 * Note: the inverse direction (answer contains the message) is deliberately NOT
 * used — a one-word reply is almost always a substring of a longer answer, which
 * mis-tags the wrong message and, in windowed mode, drops the real resolution.
 */
export function findAnswerIndex(messages: string[], answer: string): number {
  const a = (answer ?? '').trim();
  if (!a) return -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i] === a) return i;
  if (a.length >= ANSWER_MATCH_MIN_CHARS) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.includes(a)) return i;
  }
  return -1;
}
