/**
 * Similarity-threshold settings that accept either a named preset or a custom
 * number. The custom value is a **minimum similarity percentage** (0–100) —
 * the same scale as the "% match" badges shown on results — stored as a
 * numeric string in the same text column as the preset names, so no migration.
 */

/**
 * Cosine thresholds are a property of the EMBEDDING MODEL *and* of the prompt each side
 * was embedded with, so they must be re-fitted whenever either changes. The two preset
 * sets below are on DIFFERENT scales and are not comparable with each other.
 *
 * Duplicate detection compares a new question against each thread's 'dedup' vector —
 * both embedded with EmbeddingGemma's symmetric similarity prompt. Measured:
 *
 *   exact repost            0.86      adjacent question        0.55
 *   reworded, same problem  0.68      same domain, other bug   0.63
 *   paraphrase              0.64      unrelated                0.50
 *
 * Note the OVERLAP: "same domain, other bug" (0.63) lands between two genuine
 * paraphrases (0.64, 0.68). No threshold separates those cleanly, so `medium` is set
 * below the paraphrases and accepts that a same-area question sometimes gets suggested.
 * That trade is deliberate — a suggestion is dismissible in one click and at most three
 * are shown, whereas a missed duplicate is the failure users actually notice.
 *
 * PROVISIONAL: fitted on a handful of synthetic pairs. Re-fit against real accepted
 * duplicates (thread.duplicate_of_thread_id) before treating these as settled.
 */

/** Duplicate-suggestion presets: sensitivity name → minimum cosine similarity. */
export const DEDUP_PRESET_SIMILARITY = {
  /** Only near-identical reposts. */
  low: 0.8,
  /** Balanced (default). */
  medium: 0.6,
  /** Also flag loosely-related posts. */
  high: 0.5,
} as const;

/**
 * `/dejavue search` match presets → minimum cosine similarity.
 *
 * A different scale from the dedup presets above: search compares a query-prompted
 * question against document-prompted retrieval chunks, whose cosines run lower — a
 * genuine hit measured ~0.67 where the same pair scores ~0.86 symmetrically.
 */
export const SEARCH_PRESET_SIMILARITY = {
  broad: 0.25,
  balanced: 0.4,
  exact: 0.6,
} as const;

/** Parse a custom "0"–"100" percentage into a 0–1 similarity, else undefined. */
export function customSimilarity(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n / 100;
}

/** Resolve a stored dedup setting (preset name or custom %) to a similarity floor. */
export function dedupMinSimilarity(setting: string | null | undefined): number {
  return (
    customSimilarity(setting) ??
    DEDUP_PRESET_SIMILARITY[setting as keyof typeof DEDUP_PRESET_SIMILARITY] ??
    DEDUP_PRESET_SIMILARITY.medium
  );
}

/** Human label for a stored dedup setting: `medium` or `custom (≥72%)`. */
export function dedupSettingLabel(setting: string | null | undefined): string {
  const custom = customSimilarity(setting);
  if (custom !== undefined) return `custom (≥${Math.round(custom * 100)}%)`;
  return setting && setting in DEDUP_PRESET_SIMILARITY ? setting : 'medium';
}
