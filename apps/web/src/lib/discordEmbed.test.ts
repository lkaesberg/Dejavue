import { describe, expect, it } from 'vitest';
import { buildComponentEmbed, type ComponentEmbedInput, escapeMarkdown } from './discordEmbed';

// Discord rejects the whole embed on any violation, so check every rule the spec
// states: one Container root, only allowed types, ≤ 40 components, link-only buttons
// with only the allowed keys, and media items holding nothing but `url`.
const ALLOWED_TYPES = new Set([1, 2, 9, 10, 11, 12, 14, 17]);
const BUTTON_KEYS = new Set(['type', 'url', 'style', 'label', 'emoji', 'disabled']);

function violations(payload: unknown): string[] {
  const errors: string[] = [];
  let count = 0;
  const visit = (c: Record<string, unknown>): void => {
    count += 1;
    if (!ALLOWED_TYPES.has(c.type as number)) errors.push(`type ${String(c.type)} not allowed`);
    if (c.type === 17 && count > 1) errors.push('nested container');
    if (c.type === 2) {
      if (c.style !== 5) errors.push('button is not style 5');
      for (const k of Object.keys(c)) if (!BUTTON_KEYS.has(k)) errors.push(`button key ${k}`);
      if (!c.label && !c.emoji) errors.push('button has neither label nor emoji');
    }
    if (c.type === 11) {
      const media = c.media as Record<string, unknown>;
      if (Object.keys(media).join() !== 'url') errors.push('thumbnail media has keys beyond url');
    }
    for (const child of (c.components as Record<string, unknown>[] | undefined) ?? []) visit(child);
    if (c.accessory) visit(c.accessory as Record<string, unknown>);
  };
  const root = (payload as { component?: Record<string, unknown> }).component;
  if (Object.keys(payload as object).join() !== 'component') errors.push('top-level keys beyond component');
  if (root?.type !== 17) errors.push('root is not a container');
  else visit(root);
  if (count > 40) errors.push(`${count} components (max 40)`);
  return errors;
}

const base: ComponentEmbedInput = {
  title: 'Dejavue | Discord Duplicate Question Bot & Knowledge Base',
  url: 'https://dejavue.app/',
  tagline: 'Stop answering the same questions',
  description: 'Dejavue is a Discord bot that catches duplicate questions.',
  thumbnailUrl: 'https://dejavue.app/web-app-manifest-512x512.png',
  accentColor: '#7C3AED',
  buttons: [
    { label: 'Pricing', url: 'https://dejavue.app/#pricing' },
    { label: 'Source code', url: 'https://github.com/lkaesberg/Dejavue' },
  ],
};

describe('buildComponentEmbed', () => {
  it('lays out heading + text beside a thumbnail, a divider, then link buttons', () => {
    const embed = buildComponentEmbed(base);
    expect(violations(embed)).toEqual([]);
    expect(embed).toEqual({
      component: {
        type: 17,
        accent_color: 0x7c3aed,
        components: [
          {
            type: 9,
            components: [
              {
                type: 10,
                content:
                  '## [Dejavue \\| Discord Duplicate Question Bot & Knowledge Base](https://dejavue.app/)\n-# Stop answering the same questions',
              },
              { type: 10, content: 'Dejavue is a Discord bot that catches duplicate questions.' },
            ],
            accessory: { type: 11, media: { url: 'https://dejavue.app/web-app-manifest-512x512.png' } },
          },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 1,
            components: [
              { type: 2, style: 5, label: 'Pricing', url: 'https://dejavue.app/#pricing' },
              { type: 2, style: 5, label: 'Source code', url: 'https://github.com/lkaesberg/Dejavue' },
            ],
          },
        ],
      },
    });
  });

  it('puts the text straight in the container when there is no image (a section needs an accessory)', () => {
    const embed = buildComponentEmbed({ ...base, thumbnailUrl: null });
    expect(violations(embed)).toEqual([]);
    expect(embed.component.components.map((c) => c.type)).toEqual([10, 10, 14, 1]);
  });

  it('drops buttons without an absolute URL, caps the row at 5, and omits an empty row', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ label: `B${i}`, url: `https://x.test/${i}` }));
    const embed = buildComponentEmbed({
      ...base,
      buttons: [{ label: 'Add', url: '#' }, { label: 'Nope', url: '' }, ...many],
    });
    const row = embed.component.components.at(-1) as { type: number; components: { label: string }[] };
    expect(row.type).toBe(1);
    expect(row.components.map((b) => b.label)).toEqual(['B0', 'B1', 'B2', 'B3', 'B4']);

    const none = buildComponentEmbed({ ...base, buttons: [{ label: 'Add', url: '#' }] });
    expect(none.component.components.map((c) => c.type)).toEqual([9]);
  });

  it('skips an unparseable accent and a non-http thumbnail', () => {
    const embed = buildComponentEmbed({
      ...base,
      accentColor: 'var(--accent)',
      thumbnailUrl: 'data:image/svg+xml,x',
    });
    expect(embed.component).not.toHaveProperty('accent_color');
    expect(embed.component.components[0]?.type).toBe(10);
  });

  it('encodes characters that would end the markdown link target early', () => {
    const embed = buildComponentEmbed({ ...base, thumbnailUrl: null, url: 'https://x.test/a (b)' });
    const heading = embed.component.components[0] as { content: string };
    expect(heading.content).toContain('](https://x.test/a%20%28b%29)');
  });
});

describe('escapeMarkdown', () => {
  it('escapes inline markdown so user titles render literally', () => {
    expect(escapeMarkdown('**bold** _it_ ~~s~~ `c` ||sp|| [a](b) \\')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\~\\~s\\~\\~ \\`c\\` \\|\\|sp\\|\\| \\[a\\](b) \\\\',
    );
  });

  it('neutralises mentions, timestamps and slash-command syntax', () => {
    expect(escapeMarkdown('<@123> <t:1700000000:R> </cmd:1>')).toBe(
      '\\<@123\\> \\<t:1700000000:R\\> \\</cmd:1\\>',
    );
  });

  it('collapses newlines and escapes line-start block syntax', () => {
    expect(escapeMarkdown('# Big\n- item\n> quote')).toBe('\\# Big - item \\> quote');
    expect(escapeMarkdown('-# subtext')).toBe('\\-# subtext');
    expect(escapeMarkdown('1. first')).toBe('1\\. first');
    expect(escapeMarkdown('+ plus')).toBe('\\+ plus');
  });
});
