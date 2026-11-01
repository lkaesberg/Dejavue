import { type APIEmbed, type BaseMessageOptions, embedLength } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { SUBCOMMANDS } from './commandCopy';
import { renderHelp } from './help';

/** Discord's embed limits. EmbedBuilder checks fields as they are added, not the total. */
const FIELD_MAX = 1024;
const EMBED_TOTAL_MAX = 6000;

const firstEmbed = ({ embeds }: BaseMessageOptions): APIEmbed => {
  const e = embeds?.[0];
  if (!e) throw new Error('no embed');
  return 'toJSON' in e ? e.toJSON() : e;
};

describe('renderHelp', () => {
  for (const admin of [true, false]) {
    it(`builds within Discord's limits (admin: ${admin})`, () => {
      // Throws if any field is over the limit — that was the production bug.
      const embed = firstEmbed(renderHelp({ admin }));
      for (const f of embed.fields ?? []) expect(f.value.length, f.name).toBeLessThanOrEqual(FIELD_MAX);
      expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
    });
  }

  it('lists every subcommand in exactly one of the command fields', () => {
    const text = (firstEmbed(renderHelp({ admin: true })).fields ?? [])
      .filter((f) => f.name.includes('Commands'))
      .map((f) => f.value)
      .join('\n');
    for (const c of SUBCOMMANDS) {
      expect(text.split(`\`/dejavue ${c.name}\``).length - 1, c.name).toBe(1);
    }
  });
});
