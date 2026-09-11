// Load the monorepo-root .env before anything reads process.env. `astro dev` does NOT
// do this on its own (Vite only populates import.meta.env), which used to be invisible
// because DATABASE_URL happens to default to the local Docker DB — every other var
// silently fell back to its default in local dev. The bot and worker already preload
// the same file; production passes env through the container instead.
import '@dejavue/core/env-preload';
import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// SSR (live from the DB) is required for wildcard-subdomain multi-tenancy.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port: 4321, host: true },
  // Astro's built-in CSRF origin check compares the browser's `Origin` header to
  // an origin it derives from the request. The standalone Node adapter builds that
  // origin from `req.socket.encrypted` and IGNORES `x-forwarded-proto`, so behind
  // our TLS-terminating proxy it computes `http://<host>` while the browser sends
  // `https://<host>` — the schemes never match and every form POST (the /unlock
  // passphrase gate) 403s with "Cross-site POST form submissions are forbidden".
  // We disable it here and do our own scheme-agnostic same-origin check on /unlock
  // in src/middleware.ts, which is the only form-encoded POST in the app.
  security: { checkOrigin: false },
  vite: {
    ssr: {
      // Workspace packages ship raw TS, so Vite must transpile them for SSR.
      noExternal: ['@dejavue/core', '@dejavue/db', '@dejavue/ai', '@dejavue/queue'],
      // …but keep heavy/native deps external — sharp/onnxruntime use dynamic
      // native requires, and pg-boss pulls in pg, that break if Vite bundles them.
      external: ['@huggingface/transformers', 'sharp', 'onnxruntime-node', 'pg-boss'],
    },
  },
});
