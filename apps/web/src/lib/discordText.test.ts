import { describe, expect, it } from 'vitest';
import { resolveMentions } from './discordText';

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
