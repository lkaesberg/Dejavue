/**
 * Similarity-threshold settings that accept either a named preset or a custom
 * number. The custom value is a **minimum similarity percentage** (0–100) —
 * the same scale as the "% match" badges shown on results — stored as a
 * numeric string in the same text column as the preset names, so no migration.
 */

/**
 * Cosine thresholds are a property of the EMBEDDING MODEL, not a taste setting: each
 * model spreads similarity differently, so these numbers have to be re-anchored
 * whenever the default model changes. Measured for EmbeddingGemma-300m (768-d):
 *
 *   identical repost   0.93     same area, different question  0.50
 *   near-identical     0.89     same product, unrelated        0.17
 *   paraphrase         0.40     unrelated                      0.11
 *
 * The previous numbers (0.8 / 0.65 / 0.5) were anchored on bge-small, whose cosine
 * floor is far higher — carried over unchanged they would fire only on near-identical
 * reposts and miss every reworded duplicate.
 *
 * PROVISIONAL: the bracket above is a handful of synthetic pairs, not a calibration.
 * Re-fit these against real accepted duplicates (thread.duplicate_of_thread_id) before
 * treating them as settled.
 */

/** Duplicate-suggestion presets: sensitivity name → minimum cosine similarity. */
export const DEDUP_PRESET_SIMILARITY = {
  /** Only near-identical reposts. */
  low: 0.85,
  /** Balanced (default). */
  medium: 0.55,
  /** Also flag loosely-related posts. */
  high: 0.4,
} as const;

/** `/dejavue search` match presets → minimum cosine similarity. */
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
