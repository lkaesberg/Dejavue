import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EMBED_SERVICE_MAX_TEXTS,
  type EmbedMode,
  embedBatchLocal,
  isEmbedServiceAuthorized,
} from '@dejavue/ai';
import { childLogger } from '@dejavue/core';

const log = childLogger({ mod: 'embed-service' });

/** 64 texts of the 8,000 characters a text is cut to, with room for JSON overhead. */
const MAX_BODY_BYTES = 2_000_000;
const MODES: readonly EmbedMode[] = ['query', 'passage', 'similarity'];

/**
 * POST /embed — the embedding service. The worker is the one process that loads the local
 * model; the bot and web set EMBEDDING_SERVICE_URL and send their texts here instead of
 * each holding a ~1.6 GB copy. Body: { texts: string[], mode, model? }. Answers the same
 * EmbedResult a local embedBatch would.
 */
export async function handleEmbedRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  if (!isEmbedServiceAuthorized(req.headers.authorization)) return void reply(401, { error: 'unauthorized' });

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return void reply(413, { error: 'request too large' });
    chunks.push(chunk as Buffer);
  }
  let body: { texts?: unknown; mode?: unknown; model?: unknown };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return void reply(400, { error: 'invalid JSON' });
  }

  const { texts, mode, model } = body;
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > EMBED_SERVICE_MAX_TEXTS ||
    !texts.every((t) => typeof t === 'string')
  ) {
    return void reply(400, { error: `texts must be 1–${EMBED_SERVICE_MAX_TEXTS} strings` });
  }
  if (!MODES.includes(mode as EmbedMode)) return void reply(400, { error: 'invalid mode' });
  if (model !== undefined && typeof model !== 'string') return void reply(400, { error: 'invalid model' });

  try {
    reply(200, await embedBatchLocal(texts, { mode: mode as EmbedMode, model }));
  } catch (err) {
    log.warn({ err }, 'embed request failed');
    reply(500, { error: 'embedding failed' });
  }
}
