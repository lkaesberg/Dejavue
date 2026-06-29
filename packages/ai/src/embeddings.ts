import {
  env as hfEnv,
  type FeatureExtractionPipeline,
  pipeline,
} from '@huggingface/transformers';
import OpenAI from 'openai';
import { childLogger, getEnv, requireEnv } from '@dejavue/core';
import { findAnswerIndex } from './text';

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
   * Retrieval prefixes (local only). bge/e5 need an asymmetric query/passage
   * prefix; forgetting them silently degrades retrieval, so the prefix is bound
   * to the model here. OpenAI embedding models are instruction-free (no prefix).
   */
  queryPrefix: string;
  passagePrefix: string;
}

export const DEFAULT_DIM = 384;
const DEFAULT_OPENROUTER_MODEL = 'openai/text-embedding-3-large';

/** Self-hosted CPU models (Transformers.js). All 384-d so swaps are non-destructive. */
const LOCAL_MODELS: Record<string, Omit<ModelInfo, 'provider'>> = {
  'bge-small-en-v1.5': {
    id: 'bge-small-en-v1.5',
    repo: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    passagePrefix: '',
  },
  'multilingual-e5-small': {
    id: 'multilingual-e5-small',
    repo: 'Xenova/multilingual-e5-small',
    dim: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
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

function getPipeline(repo: string): Promise<FeatureExtractionPipeline> {
  let p = pipelines.get(repo);
  if (!p) {
    log.info({ repo }, 'loading embedding model (first use)');
    p = pipeline('feature-extraction', repo) as Promise<FeatureExtractionPipeline>;
    pipelines.set(repo, p);
  }
  return p;
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

async function embedViaApi(texts: string[], model: string, dim: number): Promise<number[][]> {
  // Empty strings are rejected by the API; substitute a single space.
  const input = texts.map((t) => (t ?? '').slice(0, MAX_CHARS) || ' ');
  const resp = await apiClient().embeddings.create({ model, input, dimensions: dim });
  return [...resp.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => l2normalize(d.embedding as number[]));
}

export interface EmbedSource {
  title: string;
  questionBody?: string | null;
  acceptedAnswerText?: string | null;
  transcript?: { content: string; reactions?: number }[] | null;
}

const QUESTION_WINDOW = 3; // start: the OP + the next couple of replies
const ANSWER_WINDOW = 1; // the accepted answer ± its neighbours
const TAIL_WINDOW = 3; // end: the closing messages
const HIGH_VALUE_COUNT = 3; // the most-reacted messages (high-signal middle content)
// Truncate any single message so one giant post can't crowd out the start/end/high-value
// balance, and cap the whole passage below embed()'s hard MAX_CHARS so the truncation
// there (which would blindly cut the tail) effectively never fires.
const PER_MESSAGE_CHARS = 1000;
const MAX_PASSAGE_CHARS = 7000;

function clampMsg(s: string): string {
  return s.length > PER_MESSAGE_CHARS ? `${s.slice(0, PER_MESSAGE_CHARS - 1)}…` : s;
}

/** De-dup (preserving order), truncate long messages, and cap the total passage size. */
function assemble(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;
  for (const raw of parts) {
    const p = clampMsg((raw ?? '').trim());
    if (!p || seen.has(p)) continue;
    if (used + p.length + 2 > MAX_PASSAGE_CHARS) break;
    seen.add(p);
    out.push(p);
    used += p.length + 2;
  }
  return out.join('\n\n');
}

/**
 * Build the passage text to embed for a thread. Rather than the first 8000 chars (which
 * would lose the middle and end), we select a balanced, high-signal subset:
 *   - the **start** (opening messages — what the thread is about),
 *   - the **end** (how it concluded),
 *   - the most **high-value** messages (by reaction count — the community's signal of
 *     what mattered, anywhere in the thread), and
 *   - for solved Q&A, the **accepted answer** plus its neighbours.
 * Each message is truncated and the whole passage is capped, so the three sources stay
 * balanced. Falls back to title + question + answer when no transcript was captured.
 */
export function buildEmbeddingText(src: EmbedSource): string {
  const title = (src.title ?? '').trim();
  const msgs = (src.transcript ?? []).map((m) => ({
    content: (m.content ?? '').trim(),
    reactions: m.reactions ?? 0,
  }));
  const hasContent = msgs.some((m) => m.content);

  // No transcript: fall back to title + question + answer.
  if (!hasContent) {
    return assemble([title, (src.questionBody ?? '').trim(), (src.acceptedAnswerText ?? '').trim()]);
  }

  const contents = msgs.map((m) => m.content);
  const chosen = new Set<number>();
  const add = (i: number): void => {
    if (i >= 0 && i < msgs.length && contents[i]) chosen.add(i);
  };

  // Start window.
  for (let i = 0; i < QUESTION_WINDOW; i++) add(i);
  // End window.
  for (let i = msgs.length - TAIL_WINDOW; i < msgs.length; i++) add(i);

  // Accepted answer ± neighbours (or the raw answer if it isn't a transcript message).
  const answer = (src.acceptedAnswerText ?? '').trim();
  let extraAnswer = '';
  if (answer) {
    const idx = findAnswerIndex(contents, answer);
    if (idx >= 0) for (let j = idx - ANSWER_WINDOW; j <= idx + ANSWER_WINDOW; j++) add(j);
    else extraAnswer = answer;
  }

  // High-value: the most-reacted messages, wherever they are in the thread.
  const topReacted = msgs
    .map((m, i) => ({ i, reactions: m.reactions }))
    .filter((m) => m.reactions > 0 && contents[m.i])
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, HIGH_VALUE_COUNT);
  for (const m of topReacted) add(m.i);

  // Assemble in chronological order (title + answer-not-in-transcript first).
  const ordered = [...chosen].sort((a, b) => a - b).map((i) => contents[i] ?? '');
  return assemble([title, extraAnswer, ...ordered]);
}

/**
 * A stable, fast (non-crypto) hash of the embed-source text — FNV-1a, hex. Stored on
 * the thread at embed time; when it changes (an edit/delete/answer change alters the
 * passage), the vector is stale and a re-embed is forced. Comparing the *embed input*
 * (not the raw transcript) means cosmetic churn outside the question/answer windows
 * doesn't trigger needless re-embeds.
 */
export function embedContentHash(src: EmbedSource): string {
  const text = buildEmbeddingText(src);
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return (h >>> 0).toString(16);
}

export type EmbedMode = 'query' | 'passage';

export interface EmbedOptions {
  mode: EmbedMode;
  /** Friendly model id; defaults to the env-configured model. */
  model?: string;
}

const MAX_CHARS = 8000;

/** Embed a batch of texts into normalized vectors using the active provider. */
export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const info = resolveModel(opts.model);

  let vectors: number[][];
  if (info.provider === 'openrouter') {
    vectors = await embedViaApi(texts, info.apiModel as string, info.dim);
  } else {
    const prefix = opts.mode === 'query' ? info.queryPrefix : info.passagePrefix;
    const inputs = texts.map((t) => prefix + (t ?? '').slice(0, MAX_CHARS));
    const extractor = await getPipeline(info.repo as string);
    const output = await extractor(inputs, { pooling: 'mean', normalize: true });
    vectors = output.tolist() as number[][];
  }

  for (const v of vectors) {
    if (v.length !== info.dim) {
      throw new Error(
        `embedding dim mismatch: expected ${info.dim}, got ${v.length} (model ${info.id}). ` +
          'Ensure EMBEDDING_DIM matches the vector() DB column.',
      );
    }
  }
  return vectors;
}

/** Embed a single text. */
export async function embedOne(text: string, opts: EmbedOptions): Promise<number[]> {
  const [vector] = await embed([text], opts);
  if (!vector) throw new Error('embedOne produced no vector');
  return vector;
}

/** Eagerly warm the model so the first real request isn't slow (local only). */
export async function warmup(model?: string): Promise<void> {
  if (resolveModel(model).provider !== 'local') return; // API providers: nothing to preload
  await embed(['warmup'], { mode: 'query', model });
}
