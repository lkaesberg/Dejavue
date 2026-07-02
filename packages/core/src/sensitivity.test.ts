import { describe, expect, it } from 'vitest';
import {
  customSimilarity,
  DEDUP_PRESET_SIMILARITY,
  dedupMinSimilarity,
  dedupSettingLabel,
} from './sensitivity';

describe('customSimilarity', () => {
  it('parses whole percentages into a 0–1 similarity', () => {
    expect(customSimilarity('0')).toBe(0);
    expect(customSimilarity('65')).toBe(0.65);
    expect(customSimilarity('100')).toBe(1);
  });

  it('rejects presets, out-of-range and junk values', () => {
    expect(customSimilarity('medium')).toBeUndefined();
    expect(customSimilarity('101')).toBeUndefined();
    expect(customSimilarity('-5')).toBeUndefined();
    expect(customSimilarity('')).toBeUndefined();
    expect(customSimilarity('  ')).toBeUndefined();
    expect(customSimilarity(null)).toBeUndefined();
    expect(customSimilarity(undefined)).toBeUndefined();
  });
});

describe('dedupMinSimilarity', () => {
  it('resolves presets to their similarity floors', () => {
    expect(dedupMinSimilarity('low')).toBe(DEDUP_PRESET_SIMILARITY.low);
    expect(dedupMinSimilarity('high')).toBe(DEDUP_PRESET_SIMILARITY.high);
  });

  it('prefers a stored custom percentage', () => {
    expect(dedupMinSimilarity('72')).toBe(0.72);
  });

  it('falls back to medium for unknown or missing values', () => {
    expect(dedupMinSimilarity(undefined)).toBe(DEDUP_PRESET_SIMILARITY.medium);
    expect(dedupMinSimilarity('bogus')).toBe(DEDUP_PRESET_SIMILARITY.medium);
  });
});

describe('dedupSettingLabel', () => {
  it('labels presets as-is and customs with their percentage', () => {
    expect(dedupSettingLabel('medium')).toBe('medium');
    expect(dedupSettingLabel('72')).toBe('custom (≥72%)');
    expect(dedupSettingLabel('bogus')).toBe('medium');
    expect(dedupSettingLabel(null)).toBe('medium');
  });
});
