import { type APIEmbed, type BaseMessageOptions, embedLength } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { arrivalNotice, setupGuide } from './welcome';

/** Discord's limits. EmbedBuilder checks fields as they are added, not the total. */
const FIELD_MAX = 1024;
const MESSAGE_EMBEDS_MAX = 6000;

const embedsOf = ({ embeds }: BaseMessageOptions): APIEmbed[] =>
  (embeds ?? []).map((e) => ('toJSON' in e ? e.toJSON() : e));

const totalLength = (msg: BaseMessageOptions) => embedsOf(msg).reduce((sum, e) => sum + embedLength(e), 0);

describe('setupGuide', () => {
  // The longest guild name Discord allows, so the title is at its worst case.
  const longName = 'x'.repeat(100);

  for (const inChannel of [false, true]) {
    it(`stays within Discord's limits (inChannel: ${inChannel})`, () => {
      const msg = setupGuide(longName, { inChannel });
      for (const e of embedsOf(msg)) {
        for (const f of e.fields ?? []) expect(f.value.length, f.name).toBeLessThanOrEqual(FIELD_MAX);
      }
      expect(totalLength(msg)).toBeLessThanOrEqual(MESSAGE_EMBEDS_MAX);
    });
  }
});

describe('arrivalNotice', () => {
  it("stays within Discord's limits and mentions the installer", () => {
    const msg = arrivalNotice('123456789012345678');
    expect(totalLength(msg)).toBeLessThanOrEqual(MESSAGE_EMBEDS_MAX);
    expect(JSON.stringify(embedsOf(msg))).toContain('<@123456789012345678>');
  });
});
