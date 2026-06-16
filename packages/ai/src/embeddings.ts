import {
  env as hfEnv,
  type FeatureExtractionPipeline,
  pipeline,
} from '@huggingface/transformers';
import { childLogger, getEnv } from '@dejavue/core';

const log = childLogger({ mod: 'ai:embeddings' });

// Cache downloaded ONNX models under a local dir (gitignored).
hfEnv.cacheDir = process.env.TRANSFORMERS_CACHE ?? '.models';

export interface ModelInfo {
  /** Friendly id stored in the DB (embedding.model_id). */
  id: string;
  /** Transformers.js / HF repo id (ONNX). */
  repo: string;
  dim: number;
  /**
   * Retrieval prefixes. Both models need an asymmetric query/passage prefix;
   * forgetting them silently degrades retrieval, so the prefix is bound to the
   * model here and the caller can't get it wrong.
   */
  queryPrefix: string;
  passagePrefix: string;
}

const MODELS: Record<string, ModelInfo> = {
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

export const DEFAULT_DIM = 384;

export function resolveModel(id?: string): ModelInfo {
  const key = id ?? getEnv().EMBEDDING_MODEL;
  const info = MODELS[key];
  if (!info) {
    throw new Error(
      `unknown embedding model "${key}" (known: ${Object.keys(MODELS).join(', ')})`,
    );
  }
  return info;
}

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

export type EmbedMode = 'query' | 'passage';

export interface EmbedOptions {
  mode: EmbedMode;
  /** Friendly model id; defaults to env EMBEDDING_MODEL. */
  model?: string;
}

const MAX_CHARS = 8000;

/** Embed a batch of texts into normalized 384-d vectors. */
export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  if (texts.length === 0) return [];
  const info = resolveModel(opts.model);
  const prefix = opts.mode === 'query' ? info.queryPrefix : info.passagePrefix;
  const inputs = texts.map((t) => prefix + (t ?? '').slice(0, MAX_CHARS));

  const extractor = await getPipeline(info.repo);
  const output = await extractor(inputs, { pooling: 'mean', normalize: true });
  const vectors = output.tolist() as number[][];

  for (const v of vectors) {
    if (v.length !== info.dim) {
      throw new Error(`embedding dim mismatch: expected ${info.dim}, got ${v.length}`);
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

/** Eagerly warm the model so the first real request isn't slow. */
export async function warmup(model?: string): Promise<void> {
  await embed(['warmup'], { mode: 'query', model });
}
