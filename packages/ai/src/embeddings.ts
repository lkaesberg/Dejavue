import {
  env as hfEnv,
  type FeatureExtractionPipeline,
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
