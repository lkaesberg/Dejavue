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
      noExternal: ['@dejavue/core', '@dejavue/db', '@dejavue/ai'],
      // …but keep heavy native deps external — sharp/onnxruntime use dynamic
      // native requires that break if Vite tries to bundle them.
      external: ['@huggingface/transformers', 'sharp', 'onnxruntime-node'],
    },
  },
});
