import { getDb, getPublishedThreads } from '@dejavue/db';
import type { APIRoute } from 'astro';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );
}

export const GET: APIRoute = async ({ locals, request }) => {
  const tenant = locals.tenant;
  if (!tenant) return new Response('Not found', { status: 404 });

  const origin = new URL(request.url).origin;
  const threads = await getPublishedThreads(getDb(), tenant.guildId, 5000);
  const urls = [
    { loc: `${origin}/` },
    ...threads.map((t) => ({
      loc: `${origin}/t/${t.threadId}`,
      lastmod: (t.solvedAt ?? t.updatedAt)?.toISOString(),
    })),
  ];

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map(
        (u) =>
          `  <url><loc>${escapeXml(u.loc)}</loc>${'lastmod' in u && u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`,
      )
      .join('\n') +
    '\n</urlset>\n';

  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
