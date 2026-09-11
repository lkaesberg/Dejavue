import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@dejavue/core';
import type { GuildConfig } from '@dejavue/db';
import { brandOf, brandInitial, themeVars } from './theme';

// A private knowledge base is protected by one shared passphrase (set in
// `/dejavue customize`). On unlock we set a signed, HttpOnly cookie so the visitor
// stays in without re-entering it. The cookie is an HMAC over the guild id AND the
// current passphrase hash, so it can't be forged, is scoped to this tenant, and —
// critically — every existing cookie is invalidated the moment the admin changes the
// passphrase (the expected token changes, so old cookies no longer match).

/**
 * The gate cookie's HMAC key.
 *
 * The dev fallback below is a constant published in this repository, so treating it as a
 * signing key outside development means anyone can mint a cookie for any tenant whose
 * passphrase hash they learn. The hosted deploy always sets the variable
 * (docker-compose.coolify.yml uses `:?`), but `.env.example` ships it BLANK — so a
 * self-hoster who followed the example file used to silently run on the public constant.
 * Fail the boot instead: an unlockable private KB is not a degraded mode worth having.
 */
function secret(): string {
  const env = getEnv();
  if (env.KB_REVALIDATE_SECRET) return env.KB_REVALIDATE_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'KB_REVALIDATE_SECRET must be set in production: it signs the private knowledge-base ' +
        'gate cookie, and the development fallback is a constant published in this repository.',
    );
  }
  return 'dejavue-insecure-dev-secret';
}

export function gateCookieName(guildId: string): string {
  return `dvkb_${guildId}`;
}

export function gateToken(guildId: string, passphraseHash: string): string {
  return createHmac('sha256', secret()).update(`${guildId}:${passphraseHash}`).digest('hex');
}

export function isUnlocked(
  cookieValue: string | undefined,
  guildId: string,
  passphraseHash: string,
): boolean {
  if (!cookieValue) return false;
  const expected = gateToken(guildId, passphraseHash);
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A standalone, themed passphrase-gate HTML document (served by the middleware). */
export function gateHtml(cfg: GuildConfig, opts: { error?: boolean; branded: boolean }): string {
  const brand = esc(brandOf(cfg));
  const initial = esc(brandInitial(brand));
  const vars = themeVars(cfg);
  const errorBlock = opts.error
    ? `<div style="font-size:13px; color:#E5484D; margin-top:11px;">That passphrase doesn't match. Try again.</div>`
    : '';
  // Inline copy of the Echo mark (components/Echo.astro, tile "none") — this
  // page is a standalone HTML string, so it can't render the Astro component.
  const echoIcon = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" style="display:block;width:26px;height:26px;" aria-hidden="true"><g><rect x="344" y="320" width="448" height="348" rx="82" fill="#4F46E5"></rect><path d="M430 660 L452 762 L528 660 Z" fill="#4F46E5"></path><path d="M476 492 L540 558 L676 414" fill="none" stroke="#2DD4BF" stroke-width="60" stroke-linecap="round" stroke-linejoin="round"></path></g></svg>`;
  const poweredBy = opts.branded
    ? `<div style="margin-top:26px; padding-top:22px; border-top:1px solid var(--border); font-size:13px; color:var(--textmut); display:flex; align-items:center; justify-content:center; gap:7px;">${echoIcon}<span>powered by <strong style="font-family:var(--headfont); color:var(--textmid);">dejavue</strong></span></div>`
    : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${brand} | private knowledge base</title>
<style>
  :root, body { ${vars} }
  * { box-sizing:border-box; }
  body { margin:0; font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:48px 24px; }
  .card { width:430px; max-width:100%; text-align:center; }
  .logo { width:64px; height:64px; border-radius:16px; margin:0 auto; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; font-family:var(--headfont); font-weight:700; font-size:30px; }
  h1 { font-family:var(--headfont); font-weight:700; font-size:28px; letter-spacing:-0.025em; margin:22px 0 0; }
  p { font-size:15px; line-height:1.55; color:var(--textmid); margin:11px 0 0; }
  form { margin-top:24px; }
  .field { display:flex; align-items:center; gap:11px; background:var(--surface); border:1.5px solid var(--border2); border-radius:var(--rad); padding:14px 16px; }
  input { flex:1; border:none; outline:none; background:transparent; font-family:'JetBrains Mono',monospace; font-size:15px; letter-spacing:0.04em; color:var(--text); }
  button { width:100%; margin-top:14px; border:none; cursor:pointer; background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; font-size:15px; font-weight:600; padding:14px; border-radius:var(--rad); }
</style></head>
<body><div class="card">
  <div class="logo">${initial}</div>
  <div style="font-family:var(--headfont); font-weight:700; font-size:20px; margin-top:14px;">${brand} <span style="font-weight:500; color:var(--textmut);">Help Center</span></div>
  <h1>This knowledge base is private</h1>
  <p>Enter the passphrase to view ${brand}'s solved answers. No account needed.</p>
  <form method="POST" action="/unlock">
    <div class="field">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--textmut)" stroke-width="2.1"><rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      <input type="password" name="passphrase" placeholder="Enter passphrase" autofocus autocomplete="off">
    </div>
    ${errorBlock}
    <button type="submit">Unlock knowledge base</button>
  </form>
  ${poweredBy}
</div></body></html>`;
}
