import node from '@astrojs/node';
import { defineConfig } from 'astro/config';

// SSR (live from the DB) is required for wildcard-subdomain multi-tenancy.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port: 4321, host: true },
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
