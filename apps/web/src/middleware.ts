import { getEnv, tierLimits, verifyPassphrase } from '@dejavue/core';
import { defineMiddleware } from 'astro:middleware';
import { getDb, getGuildByCustomDomain, getGuildBySlug, resolveGuildTier } from '@dejavue/db';
import { clientIp } from './lib/clientIp';
import { gateCookieName, gateHtml, gateToken, isUnlocked } from './lib/gate';
import { takeAll } from './lib/rateLimit';

/**
 * Passphrase attempts per minute on `POST /unlock`.
 *
 * Two limits, because the per-visitor one is keyed on an IP we cannot fully trust (see
 * lib/clientIp.ts). The per-guild ceiling is keyed on the tenant resolved from the Host
 * header via the database, which a client cannot choose, so it holds even against a
 * forged IP. Both are needed: without the ceiling a spoofed IP restores unlimited
 * guessing, and without the per-visitor limit one attacker starves real visitors.
 *
 * This guards two things at once. A passphrase is one shared human-chosen secret, so
 * unlimited guesses are a real risk; and verifying one is a deliberately expensive scrypt
 * hash, so unlimited attempts were also a cheap way to keep every CPU on the single web
 * process busy — for every tenant, not just the one being attacked.
 */
const UNLOCK_PER_IP_PER_MIN = 10;
const UNLOCK_PER_GUILD_PER_MIN = 60;

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

  // Container liveness probe. Answered before any tenant lookup so it depends on
  // neither the Host header nor the database: the container runtime probes over
  // 127.0.0.1, which extractSubdomain would read as the tenant slug "127" and
  // render as a 404, and Traefik drops containers that report unhealthy from its
  // routing table entirely — so a probe that can 404 or 500 takes the whole site
  // offline rather than just flagging it.
  if (new URL(context.request.url).pathname === '/health') {
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Canonicalize the marketing domain's www alias to the bare apex
  // (www.dejavue.app → dejavue.app) with a permanent redirect, so search engines
  // consolidate ranking signals on one host instead of splitting them across two
  // self-canonicalizing copies. Scoped to KB_BASE_DOMAIN so tenant custom domains
  // — which may legitimately live on www.<their-domain> — are never touched. Runs
  // before any DB lookup: a redirected request needs no tenant resolution.
  // Compare against the port-stripped base domain: `host` above has already had its port
  // removed, so a KB_BASE_DOMAIN carrying one (`localhost:4321`, as local dev sets) could
  // never match and the redirect silently did nothing. Production sets a bare domain, so
  // this only ever showed up as "the canonical redirect doesn't work on my machine".
  const baseDomain = (getEnv().KB_BASE_DOMAIN.split(':')[0] ?? '').toLowerCase();
  if (baseDomain && host === `www.${baseDomain}`) {
    // Force https + drop any port so it's a single hop straight to the secure
    // apex (the base domain is always TLS-served in prod; this branch never
    // matches localhost). Path + query are preserved by reusing the URL.
    const url = new URL(context.request.url);
    url.protocol = 'https:';
    url.hostname = baseDomain;
    url.port = '';
    return context.redirect(url.href, 301);
  }

  const slug = extractSubdomain(rawHost);
  context.locals.slug = slug;
  context.locals.tenant = null;
  context.locals.cfg = null;
  context.locals.tier = 'free';
  context.locals.branded = true;
  // Default off: the apex marketing site never carries ads, only tenant KBs can.
  context.locals.showAds = false;

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
    // Ads are Free-tier only, and only when a network is actually configured — so a
    // self-hosted instance (ADS_PROVIDER unset) never shows them.
    context.locals.showAds = tierLimits(tier).ads && env.ADS_PROVIDER !== 'none';

    // Private KB passphrase gate. The cookie token is bound to the current passphrase
    // hash, so changing the passphrase instantly revokes every already-unlocked visitor.
    // /mcp is exempt: AI clients can't use the browser cookie, so the MCP route does its
    // own header-based auth (Authorization: Bearer <passphrase>) — see pages/mcp.ts.
    if (guild.kbPassphraseHash) {
      const url = new URL(context.request.url);

      if (url.pathname === '/unlock' && context.request.method === 'POST') {
        // Own CSRF guard (Astro's built-in checkOrigin is disabled — see
        // astro.config.mjs). Compare the browser's Origin host to our real host,
        // ignoring scheme/port so the TLS-terminating proxy doesn't cause a false
        // reject. A present-but-mismatched Origin is a cross-site POST → block.
        const originHeader = context.request.headers.get('origin');
        if (originHeader) {
          let originHost: string | null = null;
          try {
            originHost = new URL(originHeader).hostname;
          } catch {
            originHost = null;
          }
          if (originHost === null || originHost.toLowerCase() !== host) {
            return new Response('Cross-site POST form submissions are forbidden', { status: 403 });
          }
        }

        // The proxy terminates TLS, so the socket-derived url.protocol is http;
        // trust x-forwarded-proto to decide whether the gate cookie is Secure.
        const forwardedProto = context.request.headers.get('x-forwarded-proto');
        const isHttps = forwardedProto ? forwardedProto.split(',')[0]!.trim() === 'https' : url.protocol === 'https:';

        // Throttle BEFORE the scrypt verify, so a refused attempt costs us nothing.
        const ip = clientIp(context.request, context.clientAddress);
        const withinAttemptBudget = takeAll([
          { key: `unlock:${guild.guildId}:${ip}`, perMinute: UNLOCK_PER_IP_PER_MIN },
          { key: `unlock:${guild.guildId}`, perMinute: UNLOCK_PER_GUILD_PER_MIN },
        ]);
        if (!withinAttemptBudget) {
          return new Response(gateHtml(guild, { error: true, branded: context.locals.branded }), {
            status: 429,
            headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' },
          });
        }

        const form = await context.request.formData();
        const passphrase = String(form.get('passphrase') ?? '');
        if (await verifyPassphrase(passphrase, guild.kbPassphraseHash)) {
          context.cookies.set(gateCookieName(guild.guildId), gateToken(guild.guildId, guild.kbPassphraseHash), {
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 30,
            secure: isHttps,
          });
          return context.redirect('/', 303);
        }
        return new Response(gateHtml(guild, { error: true, branded: context.locals.branded }), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      // /api/health is exempt like /mcp: it exposes no tenant data and deploy
      // orchestration can't hold a passphrase cookie.
      if (url.pathname !== '/mcp' && url.pathname !== '/api/health') {
        const unlocked = isUnlocked(
          context.cookies.get(gateCookieName(guild.guildId))?.value,
          guild.guildId,
          guild.kbPassphraseHash,
        );
        if (!unlocked) {
          // Browser API routes (e.g. the summary stream) carry the cookie; if it's
          // missing return a clear 401 JSON rather than the HTML gate.
          if (url.pathname.startsWith('/api/')) {
            return new Response(
              JSON.stringify({ error: 'This knowledge base is private. A passphrase is required.' }),
              { status: 401, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(gateHtml(guild, { error: false, branded: context.locals.branded }), {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      }
    }
  }
  return next();
});
