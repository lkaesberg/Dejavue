// Attachment policy, shared by the worker (image compressor) and the web (serve +
// render). Strategy:
//   • images  → downloaded while the Discord url is fresh, compressed to a tiny webp,
//               and re-hosted (served from /a/<id>) so they survive url expiry.
//   • videos  → left on Discord; the KB shows a labelled chip that links out.
//   • files   → same as videos (a download chip linking to Discord).

/** Cap on the *source* image we'll download to compress (Discord's upload ceiling). */
export const ATTACHMENT_DOWNLOAD_MAX_BYTES = 26 * 1024 * 1024;

/** Raster image types we re-host (compressed). Animated GIF / SVG are treated as files. */
const REHOST_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

export type AttachmentKind = 'image' | 'video' | 'file';

/** Classify an attachment by its content type → how the KB stores + renders it. */
export function attachmentKind(contentType: string | null | undefined): AttachmentKind {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (REHOST_IMAGE_TYPES.has(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

/** Only Discord's own CDN hosts may be downloaded (prevents SSRF via crafted urls). */
export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'cdn.discordapp.com' || h === 'media.discordapp.net';
  } catch {
    return false;
  }
}
