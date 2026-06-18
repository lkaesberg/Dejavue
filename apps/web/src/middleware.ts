import { getEnv, tierLimits, verifyPassphrase } from '@dejavue/core';
import { defineMiddleware } from 'astro:middleware';
import { getDb, getGuildByCustomDomain, getGuildBySlug, resolveGuildTier } from '@dejavue/db';
import { gateCookieName, gateHtml, gateToken, isUnlocked } from './lib/gate';

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
  context.locals.cfg = null;
  context.locals.tier = 'free';
  context.locals.branded = true;

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
    context.locals.cfg = guild;

    const env = getEnv();
    const tier =
      env.DEV_FORCE_TIER ??
      (await resolveGuildTier(db, guild.guildId, { plus: env.SKU_PLUS, pro: env.SKU_PRO, max: env.SKU_MAX }));
    context.locals.tier = tier;
    context.locals.branded = !tierLimits(tier).removeBranding;

    // Private KB passphrase gate.
    if (guild.kbPassphraseHash) {
      const url = new URL(context.request.url);
      const cookieName = gateCookieName(guild.guildId);
      const unlocked = isUnlocked(context.cookies.get(cookieName)?.value, guild.guildId);

      if (url.pathname === '/unlock' && context.request.method === 'POST') {
        const form = await context.request.formData();
        const passphrase = String(form.get('passphrase') ?? '');
        if (verifyPassphrase(passphrase, guild.kbPassphraseHash)) {
          context.cookies.set(cookieName, gateToken(guild.guildId), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 30,
            secure: url.protocol === 'https:',
          });
          return context.redirect('/', 303);
        }
        return new Response(gateHtml(guild, { error: true, branded: context.locals.branded }), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (!unlocked) {
        return new Response(gateHtml(guild, { error: false, branded: context.locals.branded }), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }
  }
  return next();
});
