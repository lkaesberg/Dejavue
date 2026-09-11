import { capture } from '@dejavue/analytics';
import { ChannelType, type ForumChannel, type Guild } from 'discord.js';
import { childLogger } from '@dejavue/core';
import {
  ensureGuildConfig,
  getDb,
  setTranscript,
  updateGuildConfig,
  upsertEmbedding,
  upsertThread,
} from '@dejavue/db';

const log = childLogger({ mod: 'demo' });

interface Sample {
  question: string;
  body: string;
  answer?: string;
}

// Pre-solved "knowledge base" — seeded + embedded so search/dedup work immediately.
const KB: Sample[] = [
  {
    question: 'How do I reset my password?',
    body: "I forgot my password and can't log into my account.",
    answer:
      'Click the "Forgot password" link on the login page — a reset email arrives within a minute. If it doesn\'t, check spam or ping an admin.',
  },
  {
    question: 'Bot shows offline after deploying',
    body: 'I deployed to production and now my bot is offline.',
    answer:
      "Make sure DISCORD_TOKEN is set in your production environment and the process isn't crashing on startup — check the boot logs for an error.",
  },
  {
    question: 'How do I enable two-factor authentication?',
    body: 'Where do I turn on 2FA / MFA for my account?',
    answer:
      'Open Settings → Security and enable an authenticator app (TOTP). Save your backup codes somewhere safe.',
  },
  {
    question: 'Getting 429 rate limit errors',
    body: 'I keep hitting 429 Too Many Requests when calling the API.',
    answer:
      "You're being rate limited — honor the Retry-After header, add backoff, and batch requests instead of looping tightly.",
  },
];

// Fresh, unanswered posts that exercise the live detection flow.
const FRESH: Sample[] = [
  {
    question: 'How do I reset my account password?',
    body: "I can't remember my password and need to get back into my account.", // ≈ KB[0]
  },
  {
    question: 'My bot went offline right after I deployed',
    body: "Right after pushing to prod my bot disconnected and won't come back.", // ≈ KB[1]
  },
  {
    question: 'Best way to structure a TypeScript monorepo?',
    body: 'Any recommendations for organizing a pnpm + TypeScript monorepo?', // novel — no duplicate
  },
];

export interface DemoResult {
  forumId: string;
  solved: number;
  fresh: number;
}

/**
 * Spin up a self-contained demo: a forum channel, a seeded solved archive, and
 * fresh questions (two near-duplicates + one novel) that trigger live dedup.
 */
export async function runDemo(guild: Guild): Promise<DemoResult> {
  const db = getDb();
  const cfg = await ensureGuildConfig(db, guild.id);
  const model = cfg.embeddingModel;

  const forum = (await guild.channels.create({
    name: 'dejavue-demo',
    type: ChannelType.GuildForum,
    topic: 'Dejavue demo — ask questions here and watch duplicate detection + the solved archive in action.',
    availableTags: [{ name: 'solved' }, { name: 'unsolved' }],
    reason: 'Dejavue demo',
  })) as ForumChannel;

  const solvedTagId = forum.availableTags.find((t) => t.name === 'solved')?.id;
  const unsolvedTagId = forum.availableTags.find((t) => t.name === 'unsolved')?.id;

  // Seed the solved archive. The forum isn't monitored yet, so threadCreate
  // ignores these; they're persisted solved + embedded inline (no worker needed).
  for (const s of KB) {
    const thread = await forum.threads.create({
      name: s.question,
      message: { content: s.body },
      appliedTags: solvedTagId ? [solvedTagId] : [],
      reason: 'Dejavue demo seed',
    });
    if (s.answer) await thread.send(s.answer);

    const row = await upsertThread(db, {
      guildId: guild.id,
      channelId: forum.id,
      channelName: forum.name,
      threadId: thread.id,
      title: s.question,
      questionBody: s.body,
      opUserId: guild.client.user?.id ?? null,
      status: 'solved',
      acceptedAnswerText: s.answer ?? null,
      acceptedAnswerAuthorId: guild.client.user?.id ?? null,
      solvedAt: new Date(),
    });

    await setTranscript(db, row.id, [
      { authorId: guild.client.user?.id ?? 'demo-op', content: s.body, createdAt: new Date().toISOString() },
      ...(s.answer
        ? [{ authorId: 'demo-helper', content: s.answer, createdAt: new Date().toISOString() }]
        : []),
    ]);

    try {
      const { embedOne } = await import('@dejavue/ai');
      const vector = await embedOne([s.question, s.body, s.answer ?? ''].join('\n'), {
        mode: 'passage',
        model,
      });
      await upsertEmbedding(db, { threadRowId: row.id, guildId: guild.id, modelId: model, vector });
    } catch (err) {
      log.warn({ err }, 'demo: embedding skipped (continuing)');
    }
  }

  // Now monitor the forum so the fresh posts go through the real flow.
  const channels = new Set(cfg.forumChannelIds);
  channels.add(forum.id);
  await updateGuildConfig(db, guild.id, {
    forumChannelIds: [...channels],
    solvedTagId: solvedTagId ?? null,
    unsolvedTagId: unsolvedTagId ?? null,
  });

  // Fresh questions → threadCreate → debounced dedup posts suggestions on the two duplicates.
  for (const s of FRESH) {
    await forum.threads.create({
      name: s.question,
      message: { content: s.body },
      appliedTags: unsolvedTagId ? [unsolvedTagId] : [],
      reason: 'Dejavue demo fresh question',
    });
  }

  log.info({ guildId: guild.id, forumId: forum.id }, 'demo created');
  capture('demo_created', guild.id);
  return { forumId: forum.id, solved: KB.length, fresh: FRESH.length };
}
