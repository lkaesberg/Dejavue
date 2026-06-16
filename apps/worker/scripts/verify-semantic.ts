import 'dotenv/config';
import { embed } from '@dejavue/ai';
import {
  closeDb,
  getDb,
  semanticSearch,
  upsertEmbedding,
  upsertThread,
} from '@dejavue/db';

/**
 * End-to-end semantic pipeline check: real CPU embeddings → pgvector HNSW → retrieval.
 * Idempotent (upserts), so it can be re-run. Requires Postgres up + migrations applied.
 */
const GUILD = 'verify-semantic-guild';
const MODEL = 'bge-small-en-v1.5';

const docs = [
  {
    id: 'vs-pw',
    title: 'Reset your password',
    q: 'How do I reset my password if I forgot it?',
    a: 'Click "Forgot password" on the login page and check your email for a reset link.',
  },
  {
    id: 'vs-2fa',
    title: 'Enable two-factor authentication',
    q: 'How do I turn on 2FA / MFA for my account?',
    a: 'Open Settings → Security and enable an authenticator app.',
  },
  {
    id: 'vs-bread',
    title: 'Sourdough starter not rising',
    q: 'Why is my sourdough starter not bubbling?',
    a: 'Feed it equal parts flour and water and keep it warm.',
  },
];

const db = getDb();
try {
  for (const d of docs) {
    const row = await upsertThread(db, {
      guildId: GUILD,
      channelId: 'c',
      threadId: d.id,
      title: d.title,
      questionBody: d.q,
      status: 'solved',
      acceptedAnswerText: d.a,
    });
    const [vector] = await embed([[d.title, d.q, d.a].join('\n')], { mode: 'passage', model: MODEL });
    await upsertEmbedding(db, { threadRowId: row.id, guildId: GUILD, modelId: MODEL, vector: vector! });
  }

  const queryText = 'I lost access to my account and cannot log in';
  const [qv] = await embed([queryText], { mode: 'query', model: MODEL });
  const results = await semanticSearch(db, {
    guildId: GUILD,
    queryVector: qv!,
    limit: 3,
    minSimilarity: 0,
  });

  console.log(`query: "${queryText}"`);
  for (const r of results) console.log(`  ${r.score.toFixed(3)}  ${r.title}`);

  const top = results[0];
  if (top?.threadId !== 'vs-pw') {
    console.error('✗ expected the password-reset thread to rank first');
    process.exitCode = 1;
  } else {
    console.log('✓ end-to-end semantic search verified (real CPU embeddings + pgvector HNSW)');
  }
} catch (err) {
  console.error('✗ verify-semantic failed:', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
