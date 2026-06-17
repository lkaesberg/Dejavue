import OpenAI from 'openai';
import { childLogger, getEnv, requireEnv } from '@dejavue/core';
import { findAnswerIndex } from './text';

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
  'Write a SHORT summary (2-4 sentences) of this support thread for a knowledge base. ' +
  'You are given the discussion (the full thread when short, otherwise the opening messages plus the ' +
  'messages around the resolution; any accepted answer is tagged [ACCEPTED ANSWER] and "[…]" marks omitted parts). ' +
  'If a problem was solved, focus on HOW it was solved — the resolution and the key steps that fixed it. ' +
  'Otherwise summarize the key information. Be concise, neutral, plain prose. This sits ABOVE the full ' +
  'discussion log, so do not reproduce the whole answer — just recap. Output only the summary, no preamble or heading.';

export interface SummarySource {
  title: string;
  questionBody?: string | null;
  acceptedAnswerText?: string | null;
  transcript?: { content: string }[] | null;
}

// Send the WHOLE discussion when it fits this budget; otherwise a generous window
// from the start plus a window around the marked answer (resolutions cluster there).
const SUMMARY_WHOLE_MAX_CHARS = 8000;
const SUMMARY_START_MESSAGES = 15;
const SUMMARY_ANSWER_WINDOW = 3;
// Hard ceilings so the windowed prompt can't blow up the (metered) input: clip any
// one very long message, and stop adding opening messages once the body is full.
// The answer window is always kept (the resolution is the point of the summary).
const SUMMARY_INPUT_MAX_CHARS = 9000;
const SUMMARY_PER_MSG_MAX = 1500;

const clipMsg = (s: string): string =>
  s.length > SUMMARY_PER_MSG_MAX ? `${s.slice(0, SUMMARY_PER_MSG_MAX)}…` : s;

/**
 * Build the prompt context for a thread summary. Prefers the entire thread; when
 * that is too long, keeps the opening messages (where the problem is stated) plus a
 * window around the accepted answer (or the tail, if no answer was marked), with
 * "[…]" marking the gaps. Falls back to question + answer when no transcript exists.
 * The windowed path is bounded by SUMMARY_INPUT_MAX_CHARS so input cost stays capped.
 */
export function buildSummaryContext(src: SummarySource): string {
  const msgs = (src.transcript ?? []).map((m) => (m.content ?? '').trim()).filter(Boolean);
  const answer = (src.acceptedAnswerText ?? '').trim();
  const header = src.title ? `Thread title: ${src.title}` : '';

  if (msgs.length === 0) {
    const parts = [header];
    if (src.questionBody?.trim()) parts.push(`Question:\n${src.questionBody.trim()}`);
    if (answer) parts.push(`Accepted answer / resolution:\n${answer}`);
    return parts.filter(Boolean).join('\n\n');
  }

  const answerIdx = findAnswerIndex(msgs, answer);
  const totalChars = msgs.reduce((n, m) => n + m.length, 0);

  let indices: number[];
  if (totalChars <= SUMMARY_WHOLE_MAX_CHARS) {
    indices = msgs.map((_, i) => i); // whole thread fits
  } else {
    // Always keep the answer window (or the tail when no answer was marked)…
    const center = answerIdx >= 0 ? answerIdx : msgs.length - 1;
    const winLo = Math.max(0, center - SUMMARY_ANSWER_WINDOW);
    const winHi = Math.min(msgs.length - 1, center + SUMMARY_ANSWER_WINDOW);
    const keep = new Set<number>();
    let budget = SUMMARY_INPUT_MAX_CHARS;
    for (let i = winLo; i <= winHi; i++) {
      keep.add(i);
      budget -= clipMsg(msgs[i]!).length;
    }
    // …then fill the remaining budget with opening messages (keep at least the first).
    for (let i = 0; i < Math.min(SUMMARY_START_MESSAGES, msgs.length) && i < winLo; i++) {
      const len = clipMsg(msgs[i]!).length;
      if (keep.size > winHi - winLo + 1 && budget - len < 0) break;
      budget -= len;
      keep.add(i);
    }
    indices = [...keep].sort((a, b) => a - b);
  }

  const lines: string[] = [];
  let prev = -1;
  for (const i of indices) {
    if (prev >= 0 && i > prev + 1) lines.push('[…]'); // omitted messages
    lines.push(`${i === answerIdx ? '[ACCEPTED ANSWER] ' : ''}${clipMsg(msgs[i]!)}`);
    prev = i;
  }

  const parts = [header, lines.join('\n\n')];
  // A paraphrased accepted answer won't match a transcript line — surface it too.
  if (answer && answerIdx < 0) parts.push(`Marked resolution:\n${clipMsg(answer)}`);
  return parts.filter(Boolean).join('\n\n');
}

/** Summarize a thread into a short "how it was solved" recap shown above the logs. */
export async function summarizeThread(input: {
  context: string;
  model?: string;
}): Promise<ChatResult> {
  return chat({
    system: SUMMARY_SYSTEM,
    user: input.context,
    model: input.model,
    maxTokens: 180,
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
