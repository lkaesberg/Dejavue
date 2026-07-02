import {
  type ButtonInteraction,
  type Interaction,
  MessageFlags,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getThreadByDiscordId, setDuplicateOf } from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import {
  ACCEPT_BUTTON_PREFIX,
  buildSolveModal,
  DISMISS_BUTTON_ID,
  duplicateAcceptedNotice,
  duplicateResolvedNotice,
  SOLVE_BUTTON_ID,
  SOLVE_MODAL_PREFIX,
  solvedWithAnswerNotice,
  threadUrl,
} from '../lib/embeds';
import {
  handleCustomizeButton,
  handleCustomizeModal,
  handleCustomizeSelect,
  isCustomizeInteraction,
} from '../lib/customize';
import {
  handleHubButton,
  handleHubModal,
  handleHubRoleSelect,
  handleHubSelect,
  isHubInteraction,
} from '../lib/hubs';
import { applyTag, ensureForumTags, findTagByName, forumParent } from '../lib/forum';
import { canResolveThread, isThreadOp, NO_PERMISSION_MESSAGE } from '../lib/permissions';
import { eph, safeReply } from '../lib/reply';
import { closeThread, solveThread } from '../lib/solve';
import { getGuildTier, limitsFor } from '../lib/tier';
import { contextByName, slashByName } from '../commands/registry';

const log = childLogger({ mod: 'event:interaction' });

async function showBrandingFor(guildId: string): Promise<boolean> {
  return !limitsFor(await getGuildTier(guildId)).removeBranding;
}

/** Borrow a previous solved post's answer into this thread and mark it solved + duplicate. */
async function acceptDuplicate(
  channel: ThreadChannel,
  originalThreadId: string,
  solverId: string,
): Promise<void> {
  const db = getDb();
  // Mark as a duplicate first so solveThread won't publish it as its own KB page.
  // setDuplicateOf also unpublishes it; revalidate (410) in case a page already existed.
  await setDuplicateOf(db, channel.guildId, channel.id, originalThreadId);
  await enqueueRevalidateKb({
    guildId: channel.guildId,
    threadId: channel.id,
    action: 'unpublish',
  }).catch(() => undefined);
  const original = await getThreadByDiscordId(db, channel.guildId, originalThreadId);
  const url = threadUrl(channel.guildId, originalThreadId);
  const answerText = original?.canonicalSummary || original?.acceptedAnswerText || '';
  const showBranding = await showBrandingFor(channel.guildId);

  await channel.send(duplicateAcceptedNotice(answerText, url, showBranding)).catch(() => undefined);

  const forum = forumParent(channel);
  if (forum) {
    // Create the "duplicate" tag on demand if the forum predates this feature.
    let dupTag = findTagByName(forum, 'duplicate');
    if (!dupTag) {
      dupTag = await ensureForumTags(forum)
        .then((t) => t.duplicateTagId)
        .catch(() => undefined);
    }
    if (dupTag) await applyTag(channel, dupTag).catch(() => undefined);
  }

  await solveThread(channel, {
    answerText: answerText || `Duplicate of ${url}`,
    answerAuthorId: solverId,
    solverId,
  });
  await closeThread(channel);
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === DISMISS_BUTTON_ID) {
    await interaction.message.delete().catch(() => undefined);
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isThread() || !forumParent(channel)) {
    await interaction.reply(eph('Use this inside a forum post.'));
    return;
  }
  const isOp = await isThreadOp(channel, interaction.user.id);
  if (!canResolveThread(interaction.memberPermissions, isOp)) {
    await interaction.reply(eph(NO_PERMISSION_MESSAGE));
    return;
  }

  if (interaction.customId === SOLVE_BUTTON_ID) {
    // Force an answer rather than an empty solve.
    await interaction.showModal(buildSolveModal(interaction.message.id));
    return;
  }

  if (interaction.customId.startsWith(ACCEPT_BUTTON_PREFIX)) {
    const originalThreadId = interaction.customId.slice(ACCEPT_BUTTON_PREFIX.length);
    await interaction.deferUpdate();
    await acceptDuplicate(channel, originalThreadId, interaction.user.id);
    await interaction
      .editReply(duplicateResolvedNotice(channel.guildId, originalThreadId, await showBrandingFor(channel.guildId)))
      .catch(() => undefined);
  }
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith(SOLVE_MODAL_PREFIX)) return;
  const channel = interaction.channel;
  if (!channel || !channel.isThread() || !forumParent(channel)) {
    await interaction.reply(eph('Use this inside a forum post.'));
    return;
  }
  const isOp = await isThreadOp(channel, interaction.user.id);
  if (!canResolveThread(interaction.memberPermissions, isOp)) {
    await interaction.reply(eph(NO_PERMISSION_MESSAGE));
    return;
  }

  const answer = interaction.fields.getTextInputValue('answer').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // The control message id is encoded in the modal customId; solveThread removes
  // (or, if disabled, marks) that prompt once solved.
  const controlMessageId = interaction.customId.slice(SOLVE_MODAL_PREFIX.length).replace(/^:/, '');
  await solveThread(channel, {
    answerText: answer,
    answerAuthorId: interaction.user.id,
    solverId: interaction.user.id,
    controlMessageId: controlMessageId || undefined,
  });

  const showBranding = await showBrandingFor(channel.guildId);
  await channel.send(solvedWithAnswerNotice(answer, interaction.user.id, showBranding)).catch(() => undefined);

  await closeThread(channel);
  await interaction.editReply('✅ Marked solved and archived.');
}

export async function onInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await slashByName.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isMessageContextMenuCommand()) {
      await contextByName.get(interaction.commandName)?.execute(interaction);
    } else if (interaction.isButton()) {
      // Hubs (customize / settings / setup / insights) run anywhere, so route them first.
      if (isCustomizeInteraction(interaction.customId)) await handleCustomizeButton(interaction);
      else if (isHubInteraction(interaction.customId)) await handleHubButton(interaction);
      else await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (isCustomizeInteraction(interaction.customId)) await handleCustomizeSelect(interaction);
      else if (isHubInteraction(interaction.customId)) await handleHubSelect(interaction);
    } else if (interaction.isRoleSelectMenu()) {
      if (isHubInteraction(interaction.customId)) await handleHubRoleSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      if (isCustomizeInteraction(interaction.customId)) await handleCustomizeModal(interaction);
      else if (isHubInteraction(interaction.customId)) await handleHubModal(interaction);
      else await handleModal(interaction);
    }
  } catch (err) {
    log.error({ err }, 'interaction handler failed');
    await safeReply(interaction, 'Something went wrong handling that.');
  }
}
