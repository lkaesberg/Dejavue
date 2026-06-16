import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/client';
import { thread } from '../src/schema';
import { upsertEmbedding } from '../src/repositories/embeddings';
import { semanticSearch } from '../src/repositories/search';
import { upsertThread } from '../src/repositories/threads';
import { EMBEDDING_DIM } from '../src/schema';

const GUILD = 'verify-guild';
const MODEL = 'verify-model';

/** Build a normalized 384-d vector with 1s in one half — two orthogonal "topics". */
function vec(half: 'first' | 'second'): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const start = half === 'first' ? 0 : EMBEDDING_DIM / 2;
  for (let i = start; i < start + EMBEDDING_DIM / 2; i++) v[i] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const db = getDb();
try {
  // Clean slate (embeddings cascade-delete with their thread).
  await db.delete(thread).where(eq(thread.guildId, GUILD));

  const apple = await upsertThread(db, {
    guildId: GUILD,
    channelId: 'c1',
    threadId: 't-apple',
    title: 'How to bake an apple pie',
    questionBody: 'apples sugar crust oven temperature',
    status: 'solved',
    acceptedAnswerText: 'Use tart apples and bake at 200C for 45 minutes.',
  });
  const rocket = await upsertThread(db, {
    guildId: GUILD,
    channelId: 'c1',
    threadId: 't-rocket',
    title: 'How to build a model rocket',
    questionBody: 'engine fins recovery parachute launch',
    status: 'solved',
    acceptedAnswerText: 'Start with a B6-4 motor and a plastic nose cone.',
  });

  await upsertEmbedding(db, { threadRowId: apple.id, guildId: GUILD, modelId: MODEL, vector: vec('first') });
  await upsertEmbedding(db, { threadRowId: rocket.id, guildId: GUILD, modelId: MODEL, vector: vec('second') });

  const results = await semanticSearch(db, {
    guildId: GUILD,
    queryVector: vec('first'),
    limit: 5,
    minSimilarity: 0,
  });

  console.log(
    'results:',
    results.map((r) => `${r.title} (sim=${r.score.toFixed(3)})`),
  );

  const top = results[0];
  if (!top || top.threadId !== 't-apple') {
    console.error('✗ expected the apple-pie thread to rank first');
    process.exitCode = 1;
  } else if (top.score < 0.99) {
    console.error(`✗ expected ~1.0 similarity for the matching topic, got ${top.score}`);
    process.exitCode = 1;
  } else {
    console.log('✓ pgvector verified end-to-end: extension + vector(384) + HNSW index + repo query');
  }
} catch (err) {
  console.error('✗ verify failed:', err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
