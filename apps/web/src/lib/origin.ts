/**
 * The origin visitors actually use, for every absolute URL the site prints (canonical,
 * og:url/og:image, sitemap, robots, MCP links, the Discord card).
 *
 * The standalone Node adapter builds the request URL from the socket and ignores
 * `x-forwarded-proto` (see astro.config.mjs), so behind our TLS-terminating proxy
 * `new URL(request.url).origin` is `http://…` and the live og:url, og:image and sitemap
 * all said http — Cloudflare's HTTPS rewrite fixes `<link href>`s but not meta content.
 * Trust the proxy's header, as middleware.ts already does for the gate cookie's Secure
 * flag; with no header (local dev, a self-host without a proxy) keep the request's own
 * scheme. A client that forges the header only changes the URLs in its own response.
 */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  return url.origin;
}
