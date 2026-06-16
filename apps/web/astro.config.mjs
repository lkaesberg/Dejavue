import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// SSR (live from the DB) is required for wildcard-subdomain multi-tenancy.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port: 4321, host: true },
  vite: {
    // Workspace packages ship raw TS, so Vite must transpile them for SSR.
    ssr: { noExternal: ['@dejavue/core', '@dejavue/db'] },
  },
});
