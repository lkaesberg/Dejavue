import { getAttachment, getDb } from '@dejavue/db';
import type { APIRoute } from 'astro';

// Serve a re-hosted attachment (a compressed image), scoped to the tenant guild so
// one KB can never read another's bytes. We only ever store compressed webp here, but
// stay defensive: anything non-image is sent as a download, never rendered inline.
// (The passphrase gate in middleware also covers this route for private KBs.)
export const GET: APIRoute = async ({ locals, params }) => {
  const tenant = locals.tenant;
  const id = params.id;
  if (!tenant || !id) return new Response('Not found', { status: 404 });

  let att: Awaited<ReturnType<typeof getAttachment>>;
  try {
    att = await getAttachment(getDb(), tenant.guildId, id);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!att) return new Response('Not found', { status: 404 });

  const isImage = !!att.contentType && att.contentType.toLowerCase().startsWith('image/');
  // A passphrase-gated KB must NOT be publicly cacheable — otherwise a shared
  // CDN/proxy could serve gated bytes to a visitor who never unlocked the gate.
  const gated = !!locals.cfg?.kbPassphraseHash;
  const headers: Record<string, string> = {
    'content-type': isImage ? att.contentType! : 'application/octet-stream',
    'cache-control': gated ? 'private, no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  };
  if (gated) headers.vary = 'Cookie';
  if (!isImage) {
    const safe = att.name.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'file';
    headers['content-disposition'] = `attachment; filename="${safe}"`;
  }
  return new Response(new Uint8Array(att.data), { headers });
};
