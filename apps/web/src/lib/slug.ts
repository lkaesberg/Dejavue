/**
 * Human-readable thread URLs: `/c/api-help/rotate-my-api-key-1234567890123456789`.
 *
 * The channel segment and title slug carry context for readers + SEO; the
 * trailing Discord snowflake stays the lookup key, so slugs can change (title
 * or channel renames) without breaking anything — requests with a stale or
 * missing slug 301 to the canonical path, and legacy `/t/…` urls redirect
 * permanently (see pages/c/[channel]/[thread].astro and pages/t/[threadId].ts).
 */

/** Compact url slug: lowercased, ascii, cut at a word boundary near `maxLen`. */
export function slugify(text: string, maxLen = 40): string {
  let slug = text
    .toLowerCase()
    .replace(/ß/g, 'ss') // no NFKD decomposition — would be dropped otherwise
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (post-NFKD)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) {
    const cut = slug.lastIndexOf('-', maxLen);
    slug = slug.slice(0, cut > 10 ? cut : maxLen).replace(/-+$/, '');
  }
  return slug;
}

export function threadSlug(title: string): string {
  return slugify(title) || 'q';
}

/** The channel path segment (cosmetic — the thread id alone identifies the row). */
export function channelSlug(name: string | null | undefined): string {
  return slugify(name ?? '', 30) || 'general';
}

/**
 * The channel listing path, e.g. `/c/api-help`. Pure slug — the listing page
 * resolves it back to a channel id by slugifying the known channel names
 * (legacy `/c/{snowflake}` urls 301 there). Accepts the various row shapes
 * that carry a channel name.
 */
export function channelPath(c: {
  name?: string | null;
  channelName?: string | null;
  channel?: string | null;
}): string {
  return `/c/${channelSlug(c.name ?? c.channelName ?? c.channel)}`;
}

/** The canonical site path for a thread (KbSearchResult names the channel `channel`). */
export function threadPath(t: {
  threadId: string;
  title: string;
  channelName?: string | null;
  channel?: string | null;
}): string {
  return `/c/${channelSlug(t.channelName ?? t.channel)}/${threadSlug(t.title)}-${t.threadId}`;
}

/** Pull the Discord snowflake out of a thread route param (slugged or bare id). */
export function extractThreadId(param: string): string | undefined {
  return /(\d{15,21})$/.exec(param)?.[1];
}
