import {
  closeDb,
  ensureGuildConfig,
  getDb,
  setPublished,
  setTranscript,
  updateGuildConfig,
  upsertThread,
} from '@dejavue/db';

// Seed a demo tenant so the KB can be exercised locally at demo.localhost.
const GUILD = 'demo-guild';
const db = getDb();

await ensureGuildConfig(db, GUILD);
await updateGuildConfig(db, GUILD, { kbSlug: 'demo', kbPublishOptIn: true });

const row = await upsertThread(db, {
  guildId: GUILD,
  channelId: 'c',
  channelName: 'help-forum',
  threadId: 'demo-thread-1',
  title: 'How do I reset my password?',
  questionBody: 'I forgot my password and cannot log in to my account.',
  opUserId: 'demo-asker',
  status: 'solved',
  acceptedAnswerText:
    'Use the "Forgot password" link on the login page; a reset email arrives within a minute.',
});
await setPublished(db, GUILD, 'demo-thread-1', true);
await setTranscript(db, row.id, [
  { authorId: 'demo-asker', content: 'I forgot my password and cannot log in to my account.', createdAt: '2026-06-16T10:00:00.000Z' },
  { authorId: 'demo-helper', content: 'Have you tried the "Forgot password" link on the login page?', createdAt: '2026-06-16T10:02:00.000Z' },
  { authorId: 'demo-asker', content: "Oh, I didn't see it. Where exactly?", createdAt: '2026-06-16T10:03:00.000Z' },
  { authorId: 'demo-helper', content: "It's right under the login button — a reset email arrives within a minute.", createdAt: '2026-06-16T10:04:00.000Z' },
  { authorId: 'demo-asker', content: 'Got it, that worked. Thank you!', createdAt: '2026-06-16T10:06:00.000Z' },
]);

console.log('✓ seeded demo tenant: slug=demo, thread=demo-thread-1 (with transcript)');
await closeDb();
