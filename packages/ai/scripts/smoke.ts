import { embed, resolveModel } from '../src/embeddings';

/** Proves the local CPU embedding model works + that semantics are captured. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // vectors are normalized, so dot == cosine similarity
}

const query = 'How do I reset my password?';
const similar = 'I forgot my login credentials and need to recover access.';
const unrelated = 'What is the best recipe for sourdough bread?';

const [q] = await embed([query], { mode: 'query' });
const [s, u] = await embed([similar, unrelated], { mode: 'passage' });

if (!q || !s || !u) {
  console.error('✗ embedding returned empty');
  process.exit(1);
}

const simScore = cosine(q, s);
const unrelScore = cosine(q, u);
console.log(`dim=${q.length}`);
console.log(`similar:   ${simScore.toFixed(3)}  "${similar}"`);
console.log(`unrelated: ${unrelScore.toFixed(3)}  "${unrelated}"`);

// The configured model's dimension (resolveModel already enforces it equals EMBEDDING_DIM,
// i.e. the vector() column) — not a hard-coded 384 from the pre-768 schema.
const expectedDim = resolveModel().dim;
if (q.length !== expectedDim) {
  console.error(`✗ expected ${expectedDim}-d vectors, got ${q.length}`);
  process.exit(1);
}
if (simScore <= unrelScore) {
  console.error('✗ expected the paraphrase to score higher than the unrelated text');
  process.exit(1);
}
console.log('✓ embeddings verified: paraphrase ranks above unrelated text on CPU');
