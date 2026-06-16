import { defineMiddleware } from 'astro:middleware';
import { getDb, getGuildBySlug } from '@dejavue/db';

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
  const host = context.request.headers.get('host') ?? '';
  const slug = extractSubdomain(host);
  context.locals.slug = slug;
  context.locals.tenant = null;

  if (slug) {
    const guild = await getGuildBySlug(getDb(), slug);
    if (guild && guild.kbSlug) {
      context.locals.tenant = {
        guildId: guild.guildId,
        slug: guild.kbSlug,
        embeddingModel: guild.embeddingModel,
      };
    }
  }
  return next();
});
