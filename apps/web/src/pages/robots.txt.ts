import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ locals, request }) => {
  const origin = new URL(request.url).origin;
  // Only invite crawlers on real tenant subdomains.
  const body = locals.tenant
    ? `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
