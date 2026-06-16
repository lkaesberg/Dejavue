import OpenAI from 'openai';
import { childLogger, getEnv, requireEnv } from '@dejavue/core';

const log = childLogger({ mod: 'ai:llm' });

let _client: OpenAI | undefined;

function client(): OpenAI {
  if (!_client) {
    const env = getEnv();
    _client = new OpenAI({
      apiKey: requireEnv('OPENROUTER_API_KEY'),
      baseURL: 'https://openrouter.ai/api/v1',
      // OpenRouter uses these for app attribution / ranking.
      defaultHeaders: {
        'HTTP-Referer': env.OPENROUTER_APP_URL,
        'X-Title': env.OPENROUTER_APP_NAME,
      },
    });
  }
  return _client;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface ChatOptions {
  system?: string;
  user: string;
  /** Defaults to OPENROUTER_MODEL (deepseek/deepseek-v4-pro). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** One-shot chat completion via OpenRouter. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model = opts.model ?? getEnv().OPENROUTER_MODEL;
  const resp = await client().chat.completions.create({
    model,
    messages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.user },
    ],
    max_tokens: opts.maxTokens ?? 700,
    temperature: opts.temperature ?? 0.3,
  });
  const choice = resp.choices[0];
  return {
    text: choice?.message?.content ?? '',
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    model,
  };
}

const DRAFT_SYSTEM =
  'You are a community support assistant. Using ONLY the provided past solved answers, ' +
  "draft a concise answer to the user's question. If the sources do not clearly answer it, " +
  'say you are not certain and suggest waiting for a human. Keep it under 120 words. Never invent facts.';

/** Draft a likely answer from past solved threads (Pro, quota-metered). */
export async function draftAnswer(input: {
  question: string;
  sources: { title: string; answer: string }[];
  model?: string;
}): Promise<ChatResult> {
  const context = input.sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.answer}`)
    .join('\n\n')
    .slice(0, 6000);
  log.debug({ sources: input.sources.length }, 'drafting answer');
  return chat({
    system: DRAFT_SYSTEM,
    user: `Question:\n${input.question}\n\nPast solved answers:\n${context}`,
    model: input.model,
    maxTokens: 400,
  });
}

const SUMMARY_SYSTEM =
  'Summarize the resolved support thread into one clean, self-contained canonical answer for a ' +
  'public knowledge base. Be concise and neutral. Output only the answer text, no preamble.';

/** Summarize a solved thread into a canonical KB answer (Pro, quota-metered). */
export async function summarizeThread(input: {
  question: string;
  answer: string;
  model?: string;
}): Promise<ChatResult> {
  return chat({
    system: SUMMARY_SYSTEM,
    user: `Question:\n${input.question}\n\nAccepted answer:\n${input.answer}`,
    model: input.model,
    maxTokens: 450,
  });
}

/** Name a cluster of recurring questions with a short canonical title (Pro). */
export async function clusterLabel(representatives: string[], model?: string): Promise<ChatResult> {
  return chat({
    system:
      'These are example questions users keep asking. Output a short canonical title (3-8 words) ' +
      'naming the shared topic. Output only the title — no quotes, no punctuation at the end.',
    user: representatives.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    model,
    maxTokens: 24,
    temperature: 0.2,
  });
}

/** Generate a concise FAQ answer from a question + supporting context (Pro). */
export async function generateFaq(input: {
  question: string;
  context: string;
  model?: string;
}): Promise<ChatResult> {
  return chat({
    system:
      'Write a concise, self-contained FAQ answer (2-4 sentences) to the question using the ' +
      'provided context. Output only the answer.',
    user: `Question: ${input.question}\n\nContext:\n${input.context.slice(0, 5000)}`,
    model: input.model,
    maxTokens: 300,
  });
}
