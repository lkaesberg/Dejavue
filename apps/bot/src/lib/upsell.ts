import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLOR } from './embeds';

export interface UpsellOptions {
  title: string;
  description: string;
  /** The SKU to surface a native Premium upgrade button for (if configured). */
  skuId?: string | undefined;
}

/**
 * Build an upsell payload. `sendPremiumRequired()` is removed in discord.js v14 —
 * the only path is a `ButtonStyle.Premium` button with `setSKUId` (no custom
 * label/emoji; Discord renders the SKU name + price).
 */
export function upsellPayload(opts: UpsellOptions): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(opts.title)
    .setDescription(opts.description);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (opts.skuId) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(opts.skuId),
      ),
    );
  }
  return { embeds: [embed], components };
}
