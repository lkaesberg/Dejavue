import type { Client } from 'discord.js';
import { embeddingModelId } from '@dejavue/ai';
import { childLogger } from '@dejavue/core';
import {
  channelMode,
  getDb,
  getSolvedThreadsMissingEmbedding,
  getThreadsMissingEmbeddingInChannel,
  listGuildsWithKb,
  publishExistingInChannel,
  publishExistingSolved,
  publishExistingTracked,
} from '@dejavue/db';
import { enqueueEmbedThread } from '@dejavue/queue';

const log = childLogger({ mod: 'kb-reconcile' });

/**
 * On startup, bring every KB-enabled guild back in sync with reality:
 *   1. Retroactively publish any solved threads that aren't on the KB yet
 *      (up to the tier's page cap).
 *   2. Re-enqueue embeddings for solved threads that never got one (e.g. the
 *      bot was offline when they were solved, or an embed job was dropped).
 * This is what makes the KB "fill itself in" when the bot comes back online.
 */
export async function kbStartupReconcile(_client: Client): Promise<void> {
  const db = getDb();
  let guilds: Awaited<ReturnType<typeof listGuildsWithKb>>;
  try {
    guilds = await listGuildsWithKb(db);
  } catch (err) {
    log.warn({ err }, 'kb startup reconcile: failed to list guilds');
    return;
  }

  for (const cfg of guilds) {
    try {
      // Scope "needs embedding" to the active model, so flipping the embedding
      // provider/model re-embeds everything with the new model on next startup.
      const activeModelId = embeddingModelId(cfg.embeddingModel);
      let published = 0;
      const toEmbed: Awaited<ReturnType<typeof getSolvedThreadsMissingEmbedding>> = [];

      // Knowledge channels: publish + embed every thread, regardless of status.
      for (const channelId of cfg.forumChannelIds) {
        if (channelMode(cfg, channelId) !== 'knowledge') continue;
        published += await publishExistingInChannel(db, cfg.guildId, channelId);
        toEmbed.push(
          ...(await getThreadsMissingEmbeddingInChannel(db, cfg.guildId, channelId, activeModelId)),
        );
      }

      // Question channels: publish + embed solved threads only.
      published += await publishExistingSolved(db, cfg.guildId);
      toEmbed.push(...(await getSolvedThreadsMissingEmbedding(db, cfg.guildId, activeModelId)));

      // Tracked normal channels: publish any captured-but-unpublished segments
      // (e.g. captured while the KB was off, then turned on) + embed any missing.
      for (const channelId of cfg.trackedChannelIds) {
        published += await publishExistingTracked(db, cfg.guildId, channelId);
        toEmbed.push(
          ...(await getThreadsMissingEmbeddingInChannel(db, cfg.guildId, channelId, activeModelId)),
        );
      }

      const seen = new Set<string>();
      for (const t of toEmbed) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        await enqueueEmbedThread({
          threadRowId: t.id,
          guildId: cfg.guildId,
          modelId: cfg.embeddingModel,
          title: t.title,
          question: t.questionBody,
          answer: t.acceptedAnswerText,
        }).catch(() => undefined);
      }

      if (published > 0 || seen.size > 0) {
        log.info(
          { guildId: cfg.guildId, published, embeddingsQueued: seen.size },
          'kb startup reconcile',
        );
      }
    } catch (err) {
      log.warn({ err, guildId: cfg.guildId }, 'kb startup reconcile failed for guild');
    }
  }
}
