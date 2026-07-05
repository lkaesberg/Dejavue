import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLOR } from './embeds';

export interface UpsellOptions {
  title: string;
  description: string;
  /** The SKU to surface a native Premium upgrade button for (if configured). */
  skuId?: string | undefined;
  /**
   * Multiple SKUs to surface, one button each (e.g. the top-up pack ladder).
   * Takes precedence over {@link UpsellOptions.skuId}.
   */
  skuIds?: readonly string[] | undefined;
}

/** Discord allows at most 5 buttons per action row. */
const MAX_BUTTONS_PER_ROW = 5;

/**
 * Native Premium (SKU) buy buttons — one per SKU — chunked into Discord's
 * 5-per-row limit. `sendPremiumRequired()` is removed in discord.js v14; a
 * `ButtonStyle.Premium` button with `setSKUId` is the only path (no custom
 * label/emoji — Discord renders the SKU name + price).
 */
export function premiumButtonRows(
  skuIds: readonly string[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < skuIds.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        skuIds
          .slice(i, i + MAX_BUTTONS_PER_ROW)
          .map((sku) => new ButtonBuilder().setStyle(ButtonStyle.Premium).setSKUId(sku)),
      ),
    );
  }
  return rows;
}

/** Build an upsell payload: an embed plus native Premium buy button(s). */
export function upsellPayload(opts: UpsellOptions): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(opts.title)
    .setDescription(opts.description);

  const skus = opts.skuIds ?? (opts.skuId ? [opts.skuId] : []);
  return { embeds: [embed], components: premiumButtonRows(skus) };
}
