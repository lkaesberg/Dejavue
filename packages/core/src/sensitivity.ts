/**
 * Similarity-threshold settings that accept either a named preset or a custom
 * number. The custom value is a **minimum similarity percentage** (0–100) —
 * the same scale as the "% match" badges shown on results — stored as a
 * numeric string in the same text column as the preset names, so no migration.
 */

/** Duplicate-suggestion presets: sensitivity name → minimum cosine similarity. */
export const DEDUP_PRESET_SIMILARITY = {
  /** Only near-identical reposts. */
  low: 0.8,
  /** Balanced (default). */
  medium: 0.65,
  /** Also flag loosely-related posts. */
  high: 0.5,
} as const;

/** `/dejavue search` match presets → minimum cosine similarity. */
export const SEARCH_PRESET_SIMILARITY = {
  broad: 0.35,
  balanced: 0.5,
  exact: 0.7,
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
