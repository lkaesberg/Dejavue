import { describe, expect, it } from 'vitest';
import { renderDiscordMarkdown, resolveMentions } from './discordText';

describe('resolveMentions', () => {
  const aliasOf = (id: string): string => (id === '111111111' ? 'Original poster' : 'Helper 1');

  it('maps user mentions to the anonymized alias', () => {
    expect(resolveMentions('thanks <@111111111>!', aliasOf)).toBe('thanks @Original poster!');
    expect(resolveMentions('ping <@!222222222>', aliasOf)).toBe('ping @Helper 1');
  });

  it('falls back to Member without an alias resolver', () => {
    expect(resolveMentions('cc <@333333333>')).toBe('cc @Member');
  });

  it('strips ids from role and channel mentions and custom emoji', () => {
    expect(resolveMentions('ask <@&444444444> in <#555555555>')).toBe('ask @role in #channel');
    expect(resolveMentions('nice <:pepe:666666666> <a:party:777777777>')).toBe('nice :pepe: :party:');
  });

  it('leaves plain text and short bracketed numbers alone', () => {
    expect(resolveMentions('a < b and x <@12> y')).toBe('a < b and x <@12> y');
  });
});

describe('renderDiscordMarkdown — safety', () => {
  it('escapes HTML so scripts cannot be injected', () => {
    const out = renderDiscordMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('only linkifies http(s) — never javascript: schemes', () => {
    const out = renderDiscordMarkdown('[click](javascript:alert(1))').toLowerCase();
    expect(out).not.toContain('href="javascript');
    expect(out).not.toContain('<a href="javascript');
  });

  it('does not corrupt bare numbers as code placeholders', () => {
    expect(renderDiscordMarkdown('run step 3 then step 12')).toBe('run step 3 then step 12');
  });
});

describe('renderDiscordMarkdown — formatting', () => {
  it('renders bold, italic, and strikethrough', () => {
    expect(renderDiscordMarkdown('**b**')).toContain('<strong>b</strong>');
    expect(renderDiscordMarkdown('a *i* b')).toContain('<em>i</em>');
    expect(renderDiscordMarkdown('~~s~~')).toContain('<del>s</del>');
  });

  it('renders inline and fenced code without treating * inside as emphasis', () => {
    expect(renderDiscordMarkdown('use `npm i`')).toContain('<code class="kb-code-inline">npm i</code>');
    const fenced = renderDiscordMarkdown('```\na * b * c\n```');
    expect(fenced).toContain('<pre class="kb-code"><code>');
    expect(fenced).toContain('a * b * c');
    expect(fenced).not.toContain('<em>');
  });

  it('linkifies markdown and bare http(s) links with a safe rel', () => {
    const mdLink = renderDiscordMarkdown('see [docs](https://example.com/x)');
    expect(mdLink).toContain('<a href="https://example.com/x" target="_blank" rel="noopener nofollow"');
    expect(mdLink).toContain('>docs</a>');
    expect(renderDiscordMarkdown('visit https://example.com now')).toContain('<a href="https://example.com"');
  });

  it('does not italicize underscores inside snake_case identifiers', () => {
    expect(renderDiscordMarkdown('call my_func_name()')).not.toContain('<em>');
  });
});
