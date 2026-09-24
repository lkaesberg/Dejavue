import { getDb, getPublishedThreads } from '@dejavue/db';
import type { APIRoute } from 'astro';
import { threadPath } from '../lib/slug';
import { publicOrigin } from '../lib/origin';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

type SitemapUrl = { loc: string; lastmod?: string };

function sitemapResponse(urls: SitemapUrl[]): Response {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
      )
      .join('\n') +
    '\n</urlset>\n';

  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}

export const GET: APIRoute = async ({ locals, request }) => {
  const origin = publicOrigin(request);
  const tenant = locals.tenant;

  // Apex marketing site (no subdomain) → static sitemap of the public, indexable
  // pages so Google can discover and crawl the landing + legal pages. A subdomain
  // that doesn't resolve to a published KB is kept out of the index entirely (404).
  if (!tenant) {
    if (locals.slug !== null) return new Response('Not found', { status: 404 });
    return sitemapResponse(['/', '/imprint', '/privacy', '/terms'].map((p) => ({ loc: `${origin}${p}` })));
  }

  // Tenant KB → homepage + every published thread.
  // 50,000 URLs is the sitemap-protocol cap for a single file; guilds beyond
  // that need a sitemap index (deferred until any tenant approaches the limit).
  const threads = await getPublishedThreads(getDb(), tenant.guildId, 50_000);
  return sitemapResponse([
    { loc: `${origin}/` },
    ...threads.map((t) => ({
      loc: `${origin}${threadPath(t)}`,
      lastmod: (t.solvedAt ?? t.updatedAt)?.toISOString(),
    })),
  ]);
};
