/**
 * Discord component embeds: a link preview built from message components instead of
 * the plain Open Graph card. Discord's crawler reads the payload from
 * `<script id="discord:component-embed" type="application/json">` in the server-rendered
 * <head> (it runs no JS), and falls back to the og:/twitter: tags whenever the payload
 * is missing or invalid, so those stay in place.
 * Spec: https://github.com/discord/discord-api-docs/pull/8606 (link-previews/component-embeds).
 *
 * The payload is strict: one Container holding at most 40 components, only types
 * 1/2/9/10/11/12/14/17, link buttons (style 5) with no keys beyond type/url/style/label/
 * emoji/disabled, and media items with only `url`. One stray key invalidates the whole
 * embed, so the builder emits exactly those shapes and nothing else.
 */

export interface EmbedButton {
  label: string;
  url: string;
}

export interface ComponentEmbedInput {
  /** Page title (same as og:title). Rendered as a heading that links to `url`. */
  title: string;
  /** Canonical page URL (same as og:url). */
  url: string;
  /** Short line under the heading, rendered as Discord subtext. */
  tagline?: string;
  /** Page description (same as og:description). */
  description?: string;
  /** Absolute, publicly fetchable image shown beside the text. */
  thumbnailUrl?: string | null;
  /** Container accent as `#RRGGBB`. */
  accentColor?: string;
  /** Link buttons, in order. Ones without an absolute http(s) URL are dropped. */
  buttons: EmbedButton[];
}

type TextDisplay = { type: 10; content: string };
type Thumbnail = { type: 11; media: { url: string } };
type Section = { type: 9; components: TextDisplay[]; accessory: Thumbnail };
type Separator = { type: 14; divider: boolean; spacing: 1 | 2 };
type LinkButton = { type: 2; style: 5; label: string; url: string };
type ActionRow = { type: 1; components: LinkButton[] };
type Container = {
  type: 17;
  accent_color?: number;
  components: (TextDisplay | Section | Separator | ActionRow)[];
};
export interface ComponentEmbed {
  component: Container;
}

// Discord's component limits: button labels ≤ 80 chars, link-button URLs ≤ 512,
// media URLs ≤ 2048, and at most 5 buttons in one action row.
const LABEL_MAX = 80;
const BUTTON_URL_MAX = 512;
const MEDIA_URL_MAX = 2048;
const ROW_MAX = 5;
// Matches the standard preview's description budget (350 bytes); titles here are
// thread names (≤ 100 chars) or fixed marketing strings, so 200 is only a backstop.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 350;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/**
 * Make dynamic text render literally in Discord markdown. Whitespace is collapsed to
 * one line first, so the only line start left is the beginning of the string. Discord
 * treats a backslash before any punctuation as an escape, so over-escaping is harmless;
 * `<` and `>` are included to neutralise mention/timestamp/command syntax and quotes.
 */
export function escapeMarkdown(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat
    .replace(/[\\*_~`|[\]<>]/g, '\\$&')
    .replace(/^[#+-]/, '\\$&')
    .replace(/^(\d+)\./, '$1\\.');
}

/** A URL safe inside a markdown link target `(…)`. */
const linkTarget = (url: string): string =>
  url.replace(/[()<> ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const isHttpUrl = (url: string | null | undefined, max: number): url is string =>
  !!url && url.length <= max && /^https?:\/\/[^\s]+$/i.test(url);

const hexToInt = (hex: string | undefined): number | undefined =>
  hex && /^#[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : undefined;

export function buildComponentEmbed(input: ComponentEmbedInput): ComponentEmbed {
  const heading = `## [${escapeMarkdown(clip(input.title, TITLE_MAX))}](${linkTarget(input.url)})`;
  const tagline = input.tagline ? `\n-# ${escapeMarkdown(input.tagline)}` : '';
  const texts: TextDisplay[] = [{ type: 10, content: heading + tagline }];
  if (input.description?.trim()) {
    texts.push({ type: 10, content: escapeMarkdown(clip(input.description.trim(), DESCRIPTION_MAX)) });
  }

  const components: Container['components'] = isHttpUrl(input.thumbnailUrl, MEDIA_URL_MAX)
    ? [{ type: 9, components: texts, accessory: { type: 11, media: { url: input.thumbnailUrl } } }]
    : texts;

  const buttons: LinkButton[] = input.buttons
    .filter((b) => b.label.trim() && isHttpUrl(b.url, BUTTON_URL_MAX))
    .slice(0, ROW_MAX)
    .map((b) => ({ type: 2, style: 5, label: clip(b.label.trim(), LABEL_MAX), url: b.url }));
  if (buttons.length > 0) {
    components.push({ type: 14, divider: true, spacing: 1 }, { type: 1, components: buttons });
  }

  const accent = hexToInt(input.accentColor);
  return { component: { type: 17, ...(accent !== undefined ? { accent_color: accent } : {}), components } };
}
