import { getEnv, quotasFromEnv, tierLimits, verifyPassphrase } from '@dejavue/core';
import { getDb, getKbAnswersByRowIds, hybridSearch, resolveGuildTier } from '@dejavue/db';
import type { APIRoute } from 'astro';
import { takeToken } from '../lib/rateLimit';
import { threadPath } from '../lib/slug';

// Minimal MCP (Streamable HTTP, stateless) server exposing each Pro guild's
// knowledge base as a `search_knowledge_base` tool. Served per-tenant at
// {slug}.{KB_BASE_DOMAIN}/mcp — add that URL as a remote MCP server in an AI client.

const SERVER = { name: 'dejavue-kb', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
/**
 * Bearer-token checks per minute, per tenant, on a private KB. Generous enough that a
 * legitimately configured AI client reconnecting never notices, tight enough that
 * guessing a shared passphrase over this endpoint is hopeless.
 */
const AUTH_ATTEMPTS_PER_MIN = 20;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-allow-methods': 'POST, OPTIONS',
};

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const TOOLS = [
  {
    name: 'search_knowledge_base',
    description:
      "Search this community's solved-question knowledge base and return the most relevant answers, with source links.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want an answer for.' },
        limit: { type: 'integer', description: 'Maximum results (1-10, default 5).' },
      },
      required: ['query'],
    },
  },
];

async function search(
  guildId: string,
  model: string,
  origin: string,
  args: Record<string, unknown> | undefined,
): Promise<string> {
  const query = String(args?.query ?? '')
    .slice(0, 1000)
    .trim();
  const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10);
  if (!query) return 'No query provided.';

  const db = getDb();
  const { embedQueryCached, embeddingModelId } = await import('@dejavue/ai');
  // Cached: this endpoint is open to the internet and agents loop fast, so repeated
  // queries must not each cost an embedding call.
  const vector = await embedQueryCached(query, { model });
  // Hybrid: exact-term overlap boosts semantic matches — AI clients often
  // search for literal error messages or command names.
  const matches = await hybridSearch(db, {
    guildId,
    query,
    queryVector: vector,
    limit,
    minSimilarity: 0.3,
    modelId: embeddingModelId(model),
  });
  if (matches.length === 0) return 'No matching solved questions found.';

  const answers = new Map(
    (await getKbAnswersByRowIds(db, matches.map((m) => m.rowId))).map((a) => [a.rowId, a]),
  );
  return matches
    .map((m, i) => {
      const a = answers.get(m.rowId);
      const meta = [m.channelName ? `#${m.channelName}` : null, `${Math.round(m.score * 100)}% match`]
        .filter(Boolean)
        .join(' · ');
      return `${i + 1}. ${m.title} (${meta})\n${a?.answer || '(no recorded answer)'}\nSource: ${origin}${threadPath(m)}`;
    })
    .join('\n\n');
}

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: CORS });
export const GET: APIRoute = () =>
  new Response('Method Not Allowed. POST JSON-RPC (MCP Streamable HTTP).', {
    status: 405,
    headers: CORS,
  });

export const POST: APIRoute = async ({ locals, request }) => {
  const tenant = locals.tenant;
  if (!tenant) return new Response('Not found', { status: 404, headers: CORS });

  // Private KB: authenticate with the passphrase as a bearer token. AI clients can't
  // use the browser cookie gate, so MCP carries the passphrase in an Authorization header.
  const passphraseHash = locals.cfg?.kbPassphraseHash;
  if (passphraseHash) {
    // Throttle the AUTH attempt, not just the search below: the bearer check is a
    // deliberately expensive scrypt hash, so an unauthenticated caller could previously
    // both brute-force the passphrase and burn the single web process's CPU without ever
    // reaching the rate limit on `tools/call`. Keyed per tenant (from the resolved Host,
    // which the caller cannot choose) so a rotating source IP cannot lift the ceiling.
    if (!takeToken(`mcpauth:${tenant.guildId}`, AUTH_ATTEMPTS_PER_MIN)) {
      return new Response(
        JSON.stringify({ error: 'Too many authentication attempts. Retry in a minute.' }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60', ...CORS },
        },
      );
    }
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!(await verifyPassphrase(token, passphraseHash))) {
      return new Response(
        JSON.stringify({
          error: 'This knowledge base is private. Send your passphrase as `Authorization: Bearer <passphrase>`.',
        }),
        { status: 401, headers: { 'content-type': 'application/json', ...CORS } },
      );
    }
  }

  const env = getEnv();
  const tier =
    env.DEV_FORCE_TIER ??
    (await resolveGuildTier(getDb(), tenant.guildId, {
      plus: env.SKU_PLUS,
      pro: env.SKU_PRO,
      max: env.SKU_MAX,
    }));
  const limits = tierLimits(tier, quotasFromEnv(env));
  if (!limits.mcp) {
    return new Response(JSON.stringify({ error: 'The MCP server is available on Pro and Max.' }), {
      status: 402,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  let body: RpcMessage | RpcMessage[];
  try {
    body = (await request.json()) as RpcMessage | RpcMessage[];
  } catch {
    return new Response(JSON.stringify(fail(null, -32700, 'Parse error')), {
      status: 400,
      headers: { 'content-type': 'application/json', ...CORS },
    });
  }

  const origin = new URL(request.url).origin;
  const messages = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];

  for (const msg of messages) {
    const id = msg?.id;
    if (id === undefined || id === null) continue; // notification → no response
    try {
      switch (msg.method) {
        case 'initialize':
          responses.push(
            ok(id, {
              protocolVersion: (msg.params?.protocolVersion as string) ?? DEFAULT_PROTOCOL,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER,
            }),
          );
          break;
        case 'tools/list':
          responses.push(ok(id, { tools: TOOLS }));
          break;
        case 'tools/call': {
          const name = msg.params?.name as string;
          if (name !== 'search_knowledge_base') {
            responses.push(fail(id, -32602, `Unknown tool: ${name}`));
            break;
          }
          // Burst protection per tenant — searches are cheap but not free
          // (embedding + vector query), and MCP clients can loop fast.
          if (!takeToken(`mcp:${tenant.guildId}`, limits.mcpRequestsPerMinute)) {
            responses.push(fail(id, -32000, 'Rate limited. Retry in a few seconds.'));
            break;
          }
          const text = await search(
            tenant.guildId,
            tenant.embeddingModel,
            origin,
            msg.params?.arguments as Record<string, unknown> | undefined,
          );
          responses.push(ok(id, { content: [{ type: 'text', text }] }));
          break;
        }
        case 'ping':
          responses.push(ok(id, {}));
          break;
        default:
          responses.push(fail(id, -32601, `Method not found: ${msg.method}`));
      }
    } catch (e) {
      responses.push(fail(id, -32603, e instanceof Error ? e.message : 'Internal error'));
    }
  }

  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', ...CORS },
  });
};
