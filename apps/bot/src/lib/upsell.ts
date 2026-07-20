import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { type Tier, tierLimits } from '@dejavue/core';
import { COLOR } from './embeds';

/**
 * "Upgrade to **Plus** (5), **Pro** (10), or **Max** (unlimited)." — the per-tier
 * channel caps derived from tierLimits so the upsell copy can never drift from the
 * limits actually enforced.
 */
export function channelCapUpsellLine(kind: 'forum' | 'tracked'): string {
  const cap = (tier: Tier): string => {
    const limits = tierLimits(tier);
    const n = kind === 'forum' ? limits.maxForumChannels : limits.maxTrackedChannels;
    return Number.isFinite(n) ? String(n) : 'unlimited';
  };
  return `Upgrade to **Plus** (${cap('plus')}), **Pro** (${cap('pro')}), or **Max** (${cap('max')}).`;
}

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
