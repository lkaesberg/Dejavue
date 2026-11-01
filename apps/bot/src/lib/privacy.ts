import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { childLogger, getEnv } from '@dejavue/core';
import {
  getDb,
  getGuildConfig,
  isOptedOut,
  type PurgedUserContent,
  purgeUserContent,
  setOptedOut,
} from '@dejavue/db';
import { enqueueEmbedThread, enqueueRevalidateKb } from '@dejavue/queue';
import { COLOR } from './embeds';

const log = childLogger({ mod: 'privacy' });

const PRIVACY_PREFIX = 'privacy:';
const OPT_OUT_ID = `${PRIVACY_PREFIX}opt-out`;
const OPT_IN_ID = `${PRIVACY_PREFIX}opt-in`;

export function isPrivacyInteraction(customId: string): boolean {
  return customId.startsWith(PRIVACY_PREFIX);
}

/**
 * `/dejavue privacy` — a member's own opt-out. Unlike every other screen it is about the
 * person running it, not the server, so it works the same for everyone and applies in
 * every server the bot is in.
 */
function renderPrivacy(optedOut: boolean, note?: string): BaseMessageOptions {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle('🔒 Your messages and Dejavue');
  embed.setDescription(
    optedOut
      ? [
          "**You're opted out.** Dejavue doesn't store anything you post, in any server: your posts get no duplicate check and aren't archived, and your replies are left out of other people's threads.",
          '',
          'Opting back in only affects new messages. What was deleted when you opted out stays deleted.',
        ].join('\n')
      : [
          "Dejavue archives the help channels a server's admins pick, so answers can be searched later and, if the server turns it on, read on its public website — under an alias, never your name.",
          '',
          '**Opting out** applies in every server with Dejavue:',
          '• your new posts and replies are never stored or checked for duplicates',
          '• posts you started are removed from every archive and website',
          '• your replies, attachments and accepted answers are removed from other threads',
          '',
          "Your messages stay in Discord — only Dejavue's copies are deleted, and that can't be undone.",
        ].join('\n'),
  );
  if (note) embed.addFields({ name: '​', value: note });
  embed.setFooter({ text: `Privacy policy: ${getEnv().KB_PUBLIC_URL}/privacy` });

  const button = optedOut
    ? new ButtonBuilder().setCustomId(OPT_IN_ID).setLabel('Opt back in').setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder()
        .setCustomId(OPT_OUT_ID)
        .setLabel('Opt out and delete my messages')
        .setStyle(ButtonStyle.Danger);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

export async function handlePrivacy(interaction: ChatInputCommandInteraction): Promise<void> {
  const optedOut = await isOptedOut(getDb(), interaction.user.id);
  await interaction.reply({ ...renderPrivacy(optedOut), flags: MessageFlags.Ephemeral });
}

export async function handlePrivacyButton(interaction: ButtonInteraction): Promise<void> {
  const db = getDb();
  const userId = interaction.user.id;

  if (interaction.customId === OPT_IN_ID) {
    await setOptedOut(db, userId, false);
    await interaction.update(
      renderPrivacy(false, "✅ You're opted back in. New messages in archived channels are stored again."),
    );
    return;
  }
  if (interaction.customId !== OPT_OUT_ID) return;

  await interaction.deferUpdate();
  // Record the opt-out before purging, so a capture running meanwhile already skips them.
  await setOptedOut(db, userId, true);
  const purged = await purgeUserContent(db, userId);
  await refreshAfterPurge(purged);

  const started = purged.deleted.length;
  const replied = purged.edited.length;
  await interaction.editReply(
    renderPrivacy(
      true,
      started + replied === 0
        ? '✅ Done. Dejavue had nothing of yours stored.'
        : `✅ Done. Removed ${started} post${started === 1 ? '' : 's'} you started, and your messages from ${replied} other thread${replied === 1 ? '' : 's'}.`,
    ),
  );
}

/** Take deleted threads off the KB and re-embed the edited ones without the user's text. */
async function refreshAfterPurge(purged: PurgedUserContent): Promise<void> {
  const db = getDb();
  for (const t of purged.deleted) {
    await enqueueRevalidateKb({ guildId: t.guildId, threadId: t.threadId, action: 'unpublish' }).catch(
      () => undefined,
    );
  }
  const models = new Map<string, string | null>();
  for (const t of purged.edited) {
    if (!models.has(t.guildId))
      models.set(t.guildId, (await getGuildConfig(db, t.guildId))?.embeddingModel ?? null);
    const modelId = models.get(t.guildId);
    if (modelId) {
      await enqueueEmbedThread({
        threadRowId: t.id,
        guildId: t.guildId,
        modelId,
        title: t.title,
        question: t.questionBody,
        answer: t.acceptedAnswerText,
      }).catch((err) => log.warn({ err, threadId: t.threadId }, 'privacy: re-embed enqueue failed'));
    }
    if (t.publishedToKb) {
      await enqueueRevalidateKb({ guildId: t.guildId, threadId: t.threadId, action: 'publish' }).catch(
        () => undefined,
      );
    }
  }
}
