import { defineMiddleware } from 'astro:middleware';
import { getDb, getGuildByCustomDomain, getGuildBySlug } from '@dejavue/db';

/** Extract the tenant subdomain from a Host header (handles localhost dev). */
function extractSubdomain(host: string): string | null {
  const h = (host.split(':')[0] ?? '').toLowerCase();
  const parts = h.split('.');
  if (h === 'localhost') return null;
  if (h.endsWith('.localhost')) return parts[0] ?? null;
  // production: {slug}.dejavue.app → at least 3 labels
  if (parts.length >= 3) {
    const sub = parts[0]!;
    return sub === 'www' ? null : sub;
  }
  return null;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const rawHost = context.request.headers.get('host') ?? '';
  const host = (rawHost.split(':')[0] ?? '').toLowerCase();
  const slug = extractSubdomain(rawHost);
  context.locals.slug = slug;
  context.locals.tenant = null;

  const db = getDb();
  // Subdomain ({slug}.dejavue.app) first, then a custom domain (help.acme.com).
  let guild = slug ? await getGuildBySlug(db, slug) : undefined;
  if (!guild && host) guild = await getGuildByCustomDomain(db, host);

  if (guild) {
    context.locals.tenant = {
      guildId: guild.guildId,
      slug: guild.kbSlug ?? host,
      embeddingModel: guild.embeddingModel,
    };
  }
  return next();
});
