import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The client reads EMBEDDING_SERVICE_URL through getEnv, which memoizes on first use —
// so the env has to be in place before anything imports @dejavue/ai.
const stub = vi.hoisted(() => {
  process.env.DISCORD_TOKEN = 'test-token';
  process.env.EMBEDDING_PROVIDER = 'local';
  process.env.EMBEDDING_MODEL = 'embeddinggemma-300m';
  process.env.EMBEDDING_DIM = '768';
  return { modelId: 'embeddinggemma-300m', calls: [] as { texts: string[]; mode: string }[] };
});

// The real client and the real endpoint; only the model itself is replaced.
vi.mock('@dejavue/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dejavue/ai')>();
  return {
    ...actual,
    embedBatchLocal: vi.fn(async (texts: string[], opts: { mode: string }) => {
      stub.calls.push({ texts, mode: opts.mode });
      return {
        vectors: texts.map((_, i) => Array(768).fill(i + 1)),
        tokens: texts.length,
        modelId: stub.modelId,
      };
    }),
  };
});

const { embedBatch, embedServiceToken } = await import('@dejavue/ai');
const { handleEmbedRequest } = await import('./embedService');

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => void handleEmbedRequest(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.EMBEDDING_SERVICE_URL = url;
  // getEnv may have been memoized before the port was known; reset its cache.
  const { resetEnvCache } = await import('@dejavue/core');
  resetEnvCache();
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown, auth = `Bearer ${embedServiceToken()}`) =>
  fetch(`${url}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('embedding service', () => {
  it('serves embedBatch from another process, in the requested mode', async () => {
    stub.calls.length = 0;
    const out = await embedBatch(['how do I reset my password?'], { mode: 'query' });
    expect(out.vectors).toHaveLength(1);
    expect(out.vectors[0]).toHaveLength(768);
    expect(out.modelId).toBe('embeddinggemma-300m');
    expect(stub.calls).toEqual([{ texts: ['how do I reset my password?'], mode: 'query' }]);
  });

  it('splits large batches into requests the endpoint accepts', async () => {
    stub.calls.length = 0;
    const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
    const out = await embedBatch(texts, { mode: 'passage' });
    expect(out.vectors).toHaveLength(100);
    expect(stub.calls.map((c) => c.texts.length)).toEqual([64, 36]);
  });

  it('rejects a request without the shared token', async () => {
    expect((await post({ texts: ['x'], mode: 'query' }, 'Bearer wrong')).status).toBe(401);
    expect((await post({ texts: ['x'], mode: 'query' }, '')).status).toBe(401);
  });

  it('rejects malformed requests', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ texts: [], mode: 'query' })).status).toBe(400);
    expect((await post({ texts: [1], mode: 'query' })).status).toBe(400);
    expect((await post({ texts: Array(65).fill('x'), mode: 'query' })).status).toBe(400);
    expect((await post({ texts: ['x'], mode: 'nonsense' })).status).toBe(400);
  });

  it('refuses vectors from a different model than this process expects', async () => {
    stub.modelId = 'some-other-model';
    await expect(embedBatch(['x'], { mode: 'query' })).rejects.toThrow(/expected embeddinggemma-300m/);
    stub.modelId = 'embeddinggemma-300m';
  });
});
