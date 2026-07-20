import type { SearchMatch } from '@dejavue/db';
import type { ActionRowBuilder, BaseMessageOptions, ButtonBuilder, EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  draftingMessage,
  duplicatesMessage,
  noMatchesMessage,
  searchingMessage,
} from './embeds';

interface EmbedJson {
  title?: string;
  description?: string;
  footer?: { text: string };
  fields?: { name: string; value: string }[];
}

function embedJson(payload: BaseMessageOptions): EmbedJson {
  const [embed] = payload.embeds as EmbedBuilder[];
  return embed!.toJSON() as EmbedJson;
}

function buttonIds(payload: BaseMessageOptions): (string | undefined)[] {
  const [row] = payload.components as ActionRowBuilder<ButtonBuilder>[];
  return row!.components.map((b) => (b.toJSON() as { custom_id?: string }).custom_id);
}

const match = (over: Partial<SearchMatch>): SearchMatch =>
  ({
    rowId: 'r1',
    threadId: '111',
    title: 'Rotating API keys',
    channelName: 'api-help',
    kind: 'semantic',
    score: 0.96,
    ...over,
  }) as SearchMatch;

describe('searchingMessage', () => {
  it('compares meaning on semantic tiers', () => {
    const e = embedJson(searchingMessage({ indexedCount: 1247, semantic: true, showBranding: true }));
    expect(e.title).toBe('🔎 Searching solved answers…');
    expect(e.description).toContain('Comparing meaning across **1,247** indexed messages');
    expect(e.footer?.text).toBe('Powered by Dejavue');
  });

  it('matches keywords on the free tier, without branding when removed', () => {
    const e = embedJson(searchingMessage({ indexedCount: 10, semantic: false, showBranding: false }));
    expect(e.description).toContain('Matching keywords across **10** indexed messages');
    expect(e.footer).toBeUndefined();
  });
});

describe('noMatchesMessage', () => {
  it('reassures without buttons', () => {
    const payload = noMatchesMessage(true);
    const e = embedJson(payload);
    expect(e.title).toBe('✨ Looks like a new question');
    expect(e.description).toContain('No similar solved posts found');
    expect(payload.components).toEqual([]);
  });
});

describe('draftingMessage', () => {
  it('pluralizes match counts', () => {
    expect(embedJson(draftingMessage(1, false)).description).toContain('**1 solved post matches**');
    expect(embedJson(draftingMessage(3, false)).description).toContain('**3 solved posts match**');
    expect(embedJson(draftingMessage(3, false)).description).toContain('drafting a suggested answer');
  });
});

describe('duplicatesMessage', () => {
  const matches = [match({}), match({ threadId: '222', title: 'Webhooks pause?', score: 0.84 })];

  it('leads with the match count and keeps per-match percentages', () => {
    const e = embedJson(duplicatesMessage('g1', matches, false));
    expect(e.title).toBe("💡 I've seen this before");
    expect(e.description).toContain('**2 solved posts match**');
    expect(e.description).toContain('96% match');
    expect(e.description).toContain('#api-help');
  });

  it('offers one accept button per match plus dismiss (stable customIds)', () => {
    const ids = buttonIds(duplicatesMessage('g1', matches, false));
    expect(ids).toEqual(['dejavue:accept:111', 'dejavue:accept:222', 'dejavue:dismiss']);
  });

  it('uses a single accept button when there is only one match', () => {
    const ids = buttonIds(duplicatesMessage('g1', [match({})], false));
    expect(ids).toEqual(['dejavue:accept:111', 'dejavue:dismiss']);
  });

  it('renders elapsed time and branding in one footer', () => {
    const both = embedJson(duplicatesMessage('g1', matches, true, { elapsedMs: 2100 }));
    expect(both.footer?.text).toBe('Found in 2.1s · Powered by Dejavue');
    const timeOnly = embedJson(duplicatesMessage('g1', matches, false, { elapsedMs: 2100 }));
    expect(timeOnly.footer?.text).toBe('Found in 2.1s');
    const none = embedJson(duplicatesMessage('g1', matches, false));
    expect(none.footer).toBeUndefined();
  });

  it('adds the AI draft as a suggested-answer field', () => {
    const e = embedJson(duplicatesMessage('g1', matches, false, { draft: 'Rotate in Settings → API.' }));
    expect(e.fields?.[0]?.name).toBe('✦ Suggested answer (AI draft)');
    expect(e.fields?.[0]?.value).toContain('Rotate in Settings');
  });
});
