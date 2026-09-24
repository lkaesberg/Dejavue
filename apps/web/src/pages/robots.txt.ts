import type { APIRoute } from 'astro';
import { publicOrigin } from '../lib/origin';

const robots = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * Thread + channel pages are the SEO value and stay crawlable. `/search` and `/api/`
 * are not: every KB search embeds the query, and `/api/summary/*.stream` enqueues a
 * (credit-metered) summary, so letting crawlers walk them turns bot traffic into
 * embedding + inference spend for no indexing benefit.
 */
const DISALLOW = 'Disallow: /search\nDisallow: /api/\n';

export const GET: APIRoute = ({ locals, request }) => {
  const origin = publicOrigin(request);
  // Live tenant KB → invite crawlers and point them at the sitemap.
  if (locals.tenant) return robots(`User-agent: *\nAllow: /\n${DISALLOW}Sitemap: ${origin}/sitemap.xml\n`);
  // Apex marketing site (no subdomain) → should be indexed; point crawlers at
  // the marketing sitemap so they discover the landing + legal pages.
  if (locals.slug === null) return robots(`User-agent: *\nAllow: /\n${DISALLOW}Sitemap: ${origin}/sitemap.xml\n`);
  // A subdomain that doesn't resolve to a published KB → keep junk out of the index.
  return robots('User-agent: *\nDisallow: /\n');
};
