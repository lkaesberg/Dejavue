// Pure heuristic for the channel-fit feature: given how well a new question scores
// against each channel's topic, decide whether another channel is a clearly better
// home. Cosine similarities are model-dependent, so the test is RELATIVE (beat the
// current channel by a margin) with a small absolute floor to avoid suggesting a
// channel that's irrelevant to everything.

export interface ChannelFitScore {
  channelId: string;
  /** Cosine similarity in [0,1] of the question to this channel's topic. */
  score: number;
}

export interface FitSuggestion {
  channelId: string;
  score: number;
  currentScore: number;
}

/** The suggested channel must be at least this relevant to the question. */
export const FIT_MIN_BEST = 0.2;
/** …and must beat the channel the question landed in by at least this margin. */
export const FIT_MARGIN = 0.06;

/**
 * Return a better-fitting channel to suggest, or null when the current channel is
 * already the best fit (or nothing is clearly better). Deterministic + pure.
 *
 * @param scores      fit score per channel (any order)
 * @param currentChannelId the channel the question was posted in
 * @param candidateChannelIds if given, only these channels may be suggested
 */
export function suggestBetterChannel(
  scores: ChannelFitScore[],
  currentChannelId: string,
  candidateChannelIds?: ReadonlySet<string>,
): FitSuggestion | null {
  const current = scores.find((s) => s.channelId === currentChannelId);
  if (!current) return null; // no topic for the current channel → can't judge fit

  let best: ChannelFitScore | null = null;
  for (const s of scores) {
    if (s.channelId === currentChannelId) continue;
    if (candidateChannelIds && !candidateChannelIds.has(s.channelId)) continue;
    if (!best || s.score > best.score) best = s;
  }
  if (!best) return null;
  if (best.score < FIT_MIN_BEST) return null;
  if (best.score - current.score < FIT_MARGIN) return null;
  return { channelId: best.channelId, score: best.score, currentScore: current.score };
}
