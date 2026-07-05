import type { APIRoute } from 'astro';

const robots = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

export const GET: APIRoute = ({ locals, request }) => {
  const origin = new URL(request.url).origin;
  // Live tenant KB → invite crawlers and point them at the sitemap.
  if (locals.tenant) return robots(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  // Apex marketing site (no subdomain) → should be indexed; point crawlers at
  // the marketing sitemap so they discover the landing + legal pages.
  if (locals.slug === null) return robots(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  // A subdomain that doesn't resolve to a published KB → keep junk out of the index.
  return robots('User-agent: *\nDisallow: /\n');
};
