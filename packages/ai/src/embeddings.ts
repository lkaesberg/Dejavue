import {
  AutoModel,
  AutoTokenizer,
  env as hfEnv,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  pipeline,
} from '@huggingface/transformers';
import OpenAI from 'openai';
import { childLogger, getEnv, requireEnv } from '@dejavue/core';

const log = childLogger({ mod: 'ai:embeddings' });

// Cache downloaded ONNX models under a local dir (gitignored).
hfEnv.cacheDir = process.env.TRANSFORMERS_CACHE ?? '.models';

export type EmbeddingProvider = 'local' | 'openrouter';

export interface ModelInfo {
  /** Friendly id stored in the DB (embedding.model_id) — also the search filter key. */
  id: string;
  provider: EmbeddingProvider;
  dim: number;
  /** local: Transformers.js / HF repo id (ONNX). */
  repo?: string;
  /** openrouter: the API model id (e.g. openai/text-embedding-3-large). */
  apiModel?: string;
  /**
   * Retrieval prefixes (local only). bge/e5/gemma need an asymmetric query/passage
   * prefix; forgetting them silently degrades retrieval, so the prefix is bound
   * to the model here. OpenAI embedding models are instruction-free (no prefix).
   */
  queryPrefix: string;
  passagePrefix: string;
  /**
   * How the local ONNX export turns tokens into one vector (local only):
   *  - 'pipeline' — feature-extraction + mean pooling over the last hidden state.
   *    Correct for the e5 family, which is trained with mean pooling.
   *  - 'sentence-embedding' — the export already contains pooling and the model's
   *    dense projection head, and emits a `sentence_embedding` output. Pooling the
   *    hidden states ourselves would BYPASS that head and produce off-spec vectors,
   *    so these models must go through AutoModel instead of the pipeline.
   */
  backend: 'pipeline' | 'sentence-embedding';
  /** ONNX weight precision (local only). Smaller = less RAM and faster on CPU. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Model context window in tokens — bounds how large a chunk may usefully get. */
  maxTokens: number;
}

export const DEFAULT_DIM = 768;
const DEFAULT_OPENROUTER_MODEL = 'openai/text-embedding-3-large';

/**
 * Self-hosted CPU models (Transformers.js).
 *
 * `dim` must match the vector() column in the DB, so switching between models of
 * DIFFERENT dimensions is a migration + full re-embed, not an env change. The 384-d
 * entries below are kept for self-hosters who ran the pre-768 schema; on the current
 * schema only the 768-d models are usable.
 *
 * Weights are downloaded from the Hub at runtime rather than vendored, so this repo
 * redistributes no model files and each model's own licence applies to the operator.
 */
const LOCAL_MODELS: Record<string, Omit<ModelInfo, 'provider'>> = {
  // Default. 300M params, 100+ languages, 768-d (MRL-truncatable to 512/256/128),
  // 2048-token context. The ONNX export emits `sentence_embedding` — it bundles the
  // mean pooling AND the two dense projection layers, which is why it can't go
  // through the feature-extraction pipeline. Licence: Gemma Terms of Use.
  // NOTE: the upstream card is explicit that activations do NOT support fp16.
  'embeddinggemma-300m': {
    id: 'embeddinggemma-300m',
    repo: 'onnx-community/embeddinggemma-300m-ONNX',
    dim: 768,
    // Exact strings from the model card — the task prefix is part of the contract,
    // and a mismatched one quietly costs retrieval quality.
    queryPrefix: 'task: search result | query: ',
    passagePrefix: 'title: none | text: ',
    backend: 'sentence-embedding',
    // q8 over fp32: ~4x less RAM per container, and bot/worker/web each load a copy.
    dtype: 'q8',
    maxTokens: 2048,
  },
  // 384-d, pre-768 schema only.
  'bge-small-en-v1.5': {
    id: 'bge-small-en-v1.5',
    repo: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
    // OFF-SPEC: bge is trained with CLS pooling, not mean. Correcting it would change
    // every vector this model produces, so it needs a new `id` (to re-embed via
    // kbStartupReconcile) rather than a silent flip that mismatches stored vectors
    // against live queries. Left as-is because the model is no longer the default.
    backend: 'pipeline',
    maxTokens: 512,
  },
  // 384-d, pre-768 schema only. Mean pooling is correct for the e5 family.
  'multilingual-e5-small': {
    id: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    backend: 'pipeline',
    maxTokens: 512,
  },
};

/**
 * Resolve the active embedding model. The provider is the master switch
 * (EMBEDDING_PROVIDER); EMBEDDING_MODEL names the model within it. An explicit
 * `id` (e.g. a per-guild model) is honored when it's valid for the active
 * provider, otherwise we fall back to the env default.
 */
export function resolveModel(id?: string): ModelInfo {
  const env = getEnv();
  if (env.EMBEDDING_PROVIDER === 'openrouter') {
    // An API model id looks like "provider/model"; bare ids (e.g. a stale local
    // default still in the DB) fall back to the configured / default API model.
    const apiModel = id?.includes('/')
      ? id
      : env.EMBEDDING_MODEL.includes('/')
        ? env.EMBEDDING_MODEL
        : DEFAULT_OPENROUTER_MODEL;
    return {
      id: apiModel,
      provider: 'openrouter',
      apiModel,
      dim: env.EMBEDDING_DIM,
      queryPrefix: '',
      passagePrefix: '',
      backend: 'pipeline', // unused on the API path
      maxTokens: 8192,
    };
  }

  const key = id && LOCAL_MODELS[id] ? id : env.EMBEDDING_MODEL;
  const info = LOCAL_MODELS[key];
  if (!info) {
    throw new Error(
      `unknown local embedding model "${key}" (known: ${Object.keys(LOCAL_MODELS).join(', ')})`,
    );
  }
  return { ...info, provider: 'local' };
}

/**
 * The id of the active embedding model — stored on each embedding (provenance)
 * and used to scope semantic search so vectors from a different model are never
 * compared against the current query.
 */
export function embeddingModelId(id?: string): string {
  return resolveModel(id).id;
}

// ---------------------------------------------------------------------------
// Local backend (Transformers.js, lazy-loaded)
// ---------------------------------------------------------------------------

const pipelines = new Map<string, Promise<FeatureExtractionPipeline>>();

function getPipeline(repo: string, dtype?: ModelInfo['dtype']): Promise<FeatureExtractionPipeline> {
  let p = pipelines.get(repo);
  if (!p) {
    log.info({ repo, dtype }, 'loading embedding model (first use)');
    p = pipeline('feature-extraction', repo, dtype ? { dtype } : undefined) as Promise<
      FeatureExtractionPipeline
    >;
    pipelines.set(repo, p);
  }
  return p;
}

/** Tokenizer + model for exports that emit `sentence_embedding` (see ModelInfo.backend). */
type SentenceEncoder = { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };
const encoders = new Map<string, Promise<SentenceEncoder>>();

function getEncoder(repo: string, dtype?: ModelInfo['dtype']): Promise<SentenceEncoder> {
  let e = encoders.get(repo);
  if (!e) {
    log.info({ repo, dtype }, 'loading sentence-embedding model (first use)');
    e = (async () => ({
      tokenizer: await AutoTokenizer.from_pretrained(repo),
      model: await AutoModel.from_pretrained(repo, dtype ? { dtype } : undefined),
    }))();
    encoders.set(repo, e);
  }
  return e;
}

/**
 * Run an export whose ONNX graph already contains pooling + the dense head. Returns
 * L2-normalized vectors: the head normalizes already, so this is a cheap no-op that
 * also guarantees the invariant cosine search depends on.
 */
async function encodeSentences(
  repo: string,
  inputs: string[],
  dtype?: ModelInfo['dtype'],
): Promise<number[][]> {
  const { tokenizer, model } = await getEncoder(repo, dtype);
  const tokens = await tokenizer(inputs, { padding: true });
  const output = await model(tokens);
  const embedding = output.sentence_embedding;
  if (!embedding) {
    throw new Error(
      `model ${repo} produced no sentence_embedding output — it is not a sentence-embedding export`,
    );
  }
  return (embedding.tolist() as number[][]).map(l2normalize);
}

// ---------------------------------------------------------------------------
// OpenRouter / OpenAI-compatible backend
// ---------------------------------------------------------------------------

let _apiClient: OpenAI | undefined;

function apiClient(): OpenAI {
  if (!_apiClient) {
    const env = getEnv();
    _apiClient = new OpenAI({
      apiKey: env.EMBEDDING_API_KEY ?? requireEnv('OPENROUTER_API_KEY'),
      baseURL: env.EMBEDDING_BASE_URL ?? 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_APP_URL,
        'X-Title': env.OPENROUTER_APP_NAME,
      },
    });
  }
  return _apiClient;
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

async function embedViaApi(
  texts: string[],
  model: string,
  dim: number,
): Promise<{ vectors: number[][]; tokens: number }> {
  // Empty strings are rejected by the API; substitute a single space.
  const input = texts.map((t) => (t ?? '').slice(0, MAX_CHARS) || ' ');
  const resp = await apiClient().embeddings.create({ model, input, dimensions: dim });
  const vectors = [...resp.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => l2normalize(d.embedding as number[]));
  // Prefer the provider's own count; fall back to an estimate so spend is never
  // silently recorded as zero when a backend omits `usage`.
  const tokens = resp.usage?.total_tokens ?? estimateTokens(input);
  return { vectors, tokens };
}

/** ~4 chars per token. Only used when the backend reports no usage (e.g. local CPU). */
function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + (t?.length ?? 0), 0) / 4);
}

export interface EmbedSource {
  title: string;
  questionBody?: string | null;
  acceptedAnswerText?: string | null;
  transcript?: { content: string; reactions?: number }[] | null;
}

/**
 * Target size of one chunk, in characters (~300 tokens). Small enough that a single
 * topic dominates its vector, large enough that a chunk carries real context.
 */
// Sized for the active model's context window, with generous headroom: 3000 chars is
// ~750 tokens against EmbeddingGemma's 2048, so a chunk never silently truncates even
// on token-dense text (code blocks, CJK). It was 1200 when the default model was
// bge-small, whose window is 512 tokens — a limit we no longer have.
const CHUNK_CHARS = 3000;
/**
 * Messages per chunk. Chunk boundaries are pinned to message POSITIONS, not to a
 * running character count, and that is load-bearing: with length-based packing, editing
 * one message changes its length and re-flows every chunk after it, so a one-word edit
 * would re-embed the whole thread. Position-based boundaries keep an edit local.
 */
const MESSAGES_PER_CHUNK = 12;
/**
 * Index slots reserved per message-group. A group whose messages are unusually long
 * splits into several sub-chunks; reserving a band per group keeps every chunk index
 * stable when a *different* group later splits or merges. Indices are therefore sparse,
 * which is fine — they only need to be unique and stable per thread.
 */
const SUB_SLOTS = 16;
/** The thread title is prefixed to every chunk as a context anchor; keep it short. */
const TITLE_PREFIX_CHARS = 200;
/** Floor on the per-chunk message budget, so a pathological title can't starve it. */
const MIN_BUDGET_CHARS = 400;

export interface EmbedChunk {
  /**
   * Stable position key within the thread. 0 is always the canonical title + question +
   * answer chunk; transcript chunks are numbered `1 + group * SUB_SLOTS + sub`, so the
   * numbering is sparse but does not shift when neighbouring content changes.
   */
  index: number;
  text: string;
  /** FNV-1a of `text` — the unit of change detection (see buildEmbeddingChunks). */
  hash: string;
}

/** A stable, fast (non-crypto) string hash — FNV-1a, hex. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(16);
}

function clampTitle(title: string): string {
  return title.length > TITLE_PREFIX_CHARS ? `${title.slice(0, TITLE_PREFIX_CHARS - 1)}…` : title;
}

/**
 * Split messages into parts guaranteed to fit a chunk. A message longer than the budget
 * is sliced across consecutive parts rather than truncated, so no content is ever lost.
 */
function toParts(contents: string[], budget: number): string[] {
  const parts: string[] = [];
  for (const raw of contents) {
    const c = (raw ?? '').trim();
    if (!c) continue;
    if (c.length <= budget) parts.push(c);
    else for (let i = 0; i < c.length; i += budget) parts.push(c.slice(i, i + budget));
  }
  return parts;
}

/** Greedily pack parts into groups of at most `budget` characters. */
function packParts(parts: string[], budget: number): string[][] {
  const groups: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of parts) {
    if (cur.length > 0 && len + p.length + 2 > budget) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length + 2;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Slice the transcript into fixed-stride message groups, each carrying the previous
 * group's last message as a one-message overlap so an exchange that straddles a boundary
 * is still retrievable from a single chunk.
 */
function messageGroups(contents: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < contents.length; i += MESSAGES_PER_CHUNK) {
    const group = contents.slice(i, i + MESSAGES_PER_CHUNK);
    if (i > 0) group.unshift(contents[i - 1]!);
    groups.push(group);
  }
  return groups;
}

/**
 * Apply EMBED_MAX_CHUNKS_PER_THREAD to the transcript groups. 0 means unlimited, which is
 * the default and the whole point of chunking — every message stays searchable.
 *
 * When a cap IS set we keep the group holding the accepted answer plus an even split of
 * head and tail groups, and DROP the middle. That reintroduces exactly the coverage gap
 * this design removes, so it is opt-in only.
 */
function applyChunkCap<T>(groups: T[], answerGroup: number, max: number): [T, number][] {
  const indexed = groups.map((g, i) => [g, i] as [T, number]);
  if (max <= 0 || indexed.length <= max) return indexed;
  const keep = new Set<number>();
  if (answerGroup >= 0 && answerGroup < groups.length) keep.add(answerGroup);
  for (let i = 0; keep.size < max && i < groups.length; i++) {
    keep.add(i);
    if (keep.size < max) keep.add(groups.length - 1 - i);
  }
  return [...keep].sort((a, b) => a - b).map((i) => indexed[i]!);
}

/**
 * Build the passages to embed for a thread.
 *
 * Chunk 0 is the canonical `title + question + accepted answer` — the summary view that
 * answers "what is this thread about", and the floor on retrieval quality. The remaining
 * chunks cover the FULL transcript in order, so every message a human wrote is searchable
 * instead of only the start, end, and accepted answer.
 *
 * Each chunk is hashed independently, and chunk indices are pinned to message positions.
 * That combination is what keeps this affordable: editing one message, or appending a
 * reply, dirties one or two chunks, so the re-embed cost is a chunk rather than a thread.
 */
export function buildEmbeddingChunks(src: EmbedSource, maxChunks?: number): EmbedChunk[] {
  const title = (src.title ?? '').trim();
  const prefix = clampTitle(title);
  const budget = Math.max(MIN_BUDGET_CHARS, CHUNK_CHARS - prefix.length - 2);

  const contents = (src.transcript ?? []).map((m) => (m.content ?? '').trim()).filter(Boolean);
  const answer = (src.acceptedAnswerText ?? '').trim();
  const question = (src.questionBody ?? '').trim();

  const out: EmbedChunk[] = [];
  const push = (index: number, text: string): void => {
    if (text) out.push({ index, text, hash: fnv1a(text) });
  };

  // Chunk 0 — the canonical Q&A.
  push(0, [title, question, answer].filter(Boolean).join('\n\n'));

  if (contents.length === 0) return out;

  const groups = messageGroups(contents);
  const answerGroup = answer
    ? groups.findIndex((g) => g.some((m) => m === answer || m.includes(answer)))
    : -1;
  // The cap counts the whole thread, and chunk 0 has already claimed a slot.
  const cap = maxChunks ?? getEnv().EMBED_MAX_CHUNKS_PER_THREAD;
  const kept = applyChunkCap(groups, answerGroup, cap > 0 ? Math.max(1, cap - out.length) : 0);

  for (const [group, gi] of kept) {
    const subs = packParts(toParts(group, budget), budget);
    // Collapse any overflow beyond the reserved band into the last slot rather than
    // colliding with the next group's indices.
    const bounded =
      subs.length <= SUB_SLOTS
        ? subs
        : [...subs.slice(0, SUB_SLOTS - 1), subs.slice(SUB_SLOTS - 1).flat()];
    bounded.forEach((sub, si) => {
      const body = sub.join('\n\n');
      push(1 + gi * SUB_SLOTS + si, prefix ? `${prefix}\n\n${body}` : body);
    });
  }
  return out;
}

/**
 * A hash over the thread's ENTIRE chunk set — the cheap "did anything change at all?"
 * short-circuit stored on `thread.embed_content_hash`. Unlike the old passage hash, this
 * covers every message, so a mid-thread edit is no longer invisible; the per-chunk hashes
 * on the embedding rows then localize *which* chunk actually has to be re-embedded.
 */
export function embedContentHash(src: EmbedSource): string {
  return fnv1a(
    buildEmbeddingChunks(src)
      .map((c) => `${c.index}:${c.hash}`)
      .join('|'),
  );
}

export type EmbedMode = 'query' | 'passage';

export interface EmbedOptions {
  mode: EmbedMode;
  /** Friendly model id; defaults to the env-configured model. */
  model?: string;
}

const MAX_CHARS = 8000;

export interface EmbedResult {
  vectors: number[][];
  /** Tokens billed for this call — provider-reported where available, else estimated. */
  tokens: number;
  /** The model that actually produced the vectors. */
  modelId: string;
}

/**
 * Embed a batch of texts, reporting token usage alongside the vectors.
 *
 * Callers that index content should prefer this over {@link embed} and record `tokens`,
 * so per-guild embedding spend is visible. On a paid embeddings backend this is the only
 * signal there is — nothing else in the system knows what indexing costs.
 */
export async function embedBatch(texts: string[], opts: EmbedOptions): Promise<EmbedResult> {
  const info = resolveModel(opts.model);
  if (texts.length === 0) return { vectors: [], tokens: 0, modelId: info.id };

  let vectors: number[][];
  let tokens: number;
  if (info.provider === 'openrouter') {
    ({ vectors, tokens } = await embedViaApi(texts, info.apiModel as string, info.dim));
  } else {
    const prefix = opts.mode === 'query' ? info.queryPrefix : info.passagePrefix;
    const inputs = texts.map((t) => prefix + (t ?? '').slice(0, MAX_CHARS));
    const repo = info.repo as string;
    if (info.backend === 'sentence-embedding') {
      vectors = await encodeSentences(repo, inputs, info.dtype);
    } else {
      const extractor = await getPipeline(repo, info.dtype);
      const output = await extractor(inputs, { pooling: 'mean', normalize: true });
      vectors = output.tolist() as number[][];
    }
    // Local inference costs CPU, not money, but keep the number for comparability.
    tokens = estimateTokens(inputs);
  }

  for (const v of vectors) {
    if (v.length !== info.dim) {
      throw new Error(
        `embedding dim mismatch: expected ${info.dim}, got ${v.length} (model ${info.id}). ` +
          'Ensure EMBEDDING_DIM matches the vector() DB column.',
      );
    }
  }
  return { vectors, tokens, modelId: info.id };
}

/** Embed a batch of texts into normalized vectors using the active provider. */
export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  return (await embedBatch(texts, opts)).vectors;
}

/** Embed a single text. */
export async function embedOne(text: string, opts: EmbedOptions): Promise<number[]> {
  const [vector] = await embed([text], opts);
  if (!vector) throw new Error('embedOne produced no vector');
  return vector;
}

/**
 * Small LRU for *query* embeddings.
 *
 * The public KB search page and the MCP endpoint are reachable by anyone, and each hit
 * previously embedded the query afresh — one paid API call per request, with popular and
 * repeated queries paying every time. Passage embeddings are deliberately NOT cached:
 * they are written once and keyed by content hash already.
 *
 * Per-process and bounded, so it is a cost/latency optimisation, never a source of truth.
 */
const QUERY_CACHE_MAX = 2_000;
const QUERY_CACHE_TTL_MS = 60 * 60 * 1000;
const queryCache = new Map<string, { vector: number[]; at: number }>();

/** Collapse cosmetic differences so "How  Do I RESET" and "how do i reset" share an entry. */
function queryKey(text: string, modelId: string): string {
  return `${modelId}\u0000${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export async function embedQueryCached(text: string, opts?: { model?: string }): Promise<number[]> {
  const info = resolveModel(opts?.model);
  const key = queryKey(text, info.id);
  const now = Date.now();

  const hit = queryCache.get(key);
  if (hit && now - hit.at < QUERY_CACHE_TTL_MS) {
    // Refresh recency (Map preserves insertion order, so re-insert moves it to the end).
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit.vector;
  }

  const vector = await embedOne(text, { mode: 'query', model: opts?.model });
  queryCache.set(key, { vector, at: now });
  // Evict oldest entries past the cap (and drop the stale hit we just replaced).
  while (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
  return vector;
}

/** Eagerly warm the model so the first real request isn't slow (local only). */
export async function warmup(model?: string): Promise<void> {
  if (resolveModel(model).provider !== 'local') return; // API providers: nothing to preload
  await embed(['warmup'], { mode: 'query', model });
}
