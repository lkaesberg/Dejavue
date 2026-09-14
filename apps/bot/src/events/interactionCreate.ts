import { capture } from '@dejavue/analytics';
import {
  type ButtonInteraction,
  ChannelType,
  type ForumChannel,
  type Interaction,
  MessageFlags,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from 'discord.js';
import { childLogger } from '@dejavue/core';
import { getDb, getThreadByDiscordId, setDuplicateOf, upsertThread } from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import {
  ACCEPT_BUTTON_PREFIX,
  buildSolveModal,
  DISMISS_BUTTON_ID,
  duplicateAcceptedNotice,
  duplicateResolvedNotice,
  MOVE_BUTTON_PREFIX,
  movedNotice,
  movingNotice,
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
import { isNavInteraction } from '../lib/hubNav';
import { handleNavButton } from '../lib/hubRouter';
import { missingBotPermissions } from '../lib/botPerms';
import { showBrandingFor } from '../lib/branding';
import {
  applyTag,
  ensureForumTags,
  ensureMovedTag,
  findTagByName,
  forumParent,
  getStarterText,
} from '../lib/forum';
import { canResolveThread, isThreadAsker, NO_PERMISSION_MESSAGE } from '../lib/permissions';
import { eph, safeReply } from '../lib/reply';
import { closeThread, solveThread } from '../lib/solve';
import { contextByName, slashByName } from '../commands/registry';

const log = childLogger({ mod: 'event:interaction' });

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

  // A borrowed answer has no helper in *this* thread — don't pass answerAuthorId, so
  // accepting a duplicate never inflates anyone's top-helpers count.
  await solveThread(channel, {
    answerText: answerText || `Duplicate of ${url}`,
    solverId,
    via: 'dedup',
  });
  capture('dedup_accepted', channel.guildId);
  await closeThread(channel);
}

/** Threads with a repost in flight, so a double press can't open two copies. */
const moving = new Set<string>();

/** Body of the reposted question, trimmed to leave room for the attribution lines. */
function movedPostBody(question: string, header: string, footer: string): string {
  const room = 2000 - header.length - footer.length - 6; // 6 = the blank lines between
  const body = question.trim() || '_(the original post had no text)_';
  const trimmed = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  return [header, '', trimmed, '', footer].join('\n');
}

/**
 * Move a question to the forum the fit check suggested. Discord can't re-parent a
 * forum post, so "moving" is a repost: Dejavue opens the same question in the target
 * forum, credits the original asker, links back, and closes the original. The new post
 * goes through threadCreate like any other question — control prompt, dedup, indexing.
 */
async function moveQuestion(
  interaction: ButtonInteraction,
  channel: ThreadChannel,
  targetChannelId: string,
): Promise<void> {
  const db = getDb();
  const guildId = channel.guildId;
  const showBranding = await showBrandingFor(guildId);

  // Kill the button before doing anything slow: the repost is several API calls, and a
  // second press in that window would open a second copy of the question.
  const acked = await interaction
    .update(movingNotice(targetChannelId, showBranding))
    .then(() => true)
    .catch(() => false);
  // The guard closes the thread before posting its notice, and an archived thread's
  // messages can't be edited — reopen it, then retry the swap.
  if (!acked) {
    await interaction.deferUpdate().catch(() => undefined);
    if (channel.archived) await channel.setArchived(false).catch(() => undefined);
    await interaction.editReply(movingNotice(targetChannelId, showBranding)).catch(() => undefined);
  }

  const target = await channel.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!target || target.type !== ChannelType.GuildForum) {
    await interaction.followUp(eph("That channel is gone — you'll have to repost by hand."));
    return;
  }
  const forum = target as ForumChannel;
  const missing = missingBotPermissions(forum, 'forum');
  if (missing.length > 0) {
    await interaction.followUp(
      eph(`I'm missing **${missing.join(', ')}** in <#${forum.id}>, so I can't repost there.`),
    );
    return;
  }

  const [starter, row] = await Promise.all([
    getStarterText(channel),
    getThreadByDiscordId(db, guildId, channel.id),
  ]);
  // Already moved (an earlier press whose message edit didn't land): re-render the
  // notice instead of reposting. The `moved` tag is what distinguishes a move from a
  // fold via the accept button, which also fills duplicateOfThreadId.
  const sourceForum = forumParent(channel);
  const movedTagId = sourceForum ? findTagByName(sourceForum, 'moved') : undefined;
  if (row?.duplicateOfThreadId && movedTagId && channel.appliedTags.includes(movedTagId)) {
    await interaction
      .editReply(movedNotice(guildId, row.duplicateOfThreadId, forum.id, showBranding))
      .catch(() => undefined);
    return;
  }
  const askerId = row?.opUserId ?? starter?.authorId ?? channel.ownerId ?? null;
  const question = starter?.content ?? row?.questionBody ?? '';
  const header = askerId
    ? `📦 Moved from <#${channel.parentId}> — originally asked by <@${askerId}>.`
    : `📦 Moved from <#${channel.parentId}>.`;
  const footer = `-# [Original post](${threadUrl(guildId, channel.id)}) · moved by ${interaction.user}`;

  let created: ThreadChannel;
  try {
    const post = await forum.threads.create({
      name: channel.name.slice(0, 100),
      message: {
        content: movedPostBody(question, header, footer),
        // Ping the asker so they follow the question to its new home; nobody else.
        allowedMentions: { users: askerId ? [askerId] : [] },
      },
    });
    created = post as ThreadChannel;
  } catch (err) {
    log.warn({ err, threadId: channel.id, targetChannelId }, 'move: repost failed');
    await interaction.followUp(
      eph(`I couldn't open the post in <#${forum.id}> — the forum may require a tag. Repost by hand.`),
    );
    return;
  }

  // Discord makes *the bot* the owner of a post it creates, so record the real asker:
  // it drives "only the OP can resolve this" and the KB's attribution. threadCreate's
  // ensureThreadRow either hasn't run yet (we insert) or already did (we correct it).
  await upsertThread(db, {
    guildId,
    channelId: forum.id,
    channelName: forum.name,
    threadId: created.id,
    title: created.name,
    questionBody: question,
    opUserId: askerId,
    status: 'open',
  }).catch((err) => log.warn({ err, threadId: created.id }, 'move: failed to record asker'));

  // The original is now a pointer at the moved post: fold it so it stays out of
  // search, the KB and the stale-question nudges.
  await setDuplicateOf(db, guildId, channel.id, created.id).catch((err) =>
    log.warn({ err, threadId: channel.id }, 'move: failed to fold the original'),
  );

  capture('thread_moved', guildId);
  // An archived thread can't be retagged either (the guard may have re-archived it).
  if (channel.archived) await channel.setArchived(false).catch(() => undefined);
  // Tag the emptied-out post so it reads as moved at a glance in the forum list.
  if (sourceForum) {
    try {
      await applyTag(channel, await ensureMovedTag(sourceForum));
    } catch (err) {
      log.warn({ err, threadId: channel.id }, 'move: failed to apply the moved tag');
    }
  }
  await interaction
    .editReply(movedNotice(guildId, created.id, forum.id, showBranding))
    .catch(() => undefined);
  // Lock + archive: the question lives elsewhere now, so nothing should be added here.
  await closeThread(channel);
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel || !channel.isThread() || !forumParent(channel)) {
    await interaction.reply(eph('Use this inside a forum post.'));
    return;
  }
  const isOp = await isThreadAsker(channel, interaction.user.id);
  if (!canResolveThread(interaction.memberPermissions, isOp)) {
    await interaction.reply(eph(NO_PERMISSION_MESSAGE));
    return;
  }

  if (interaction.customId === DISMISS_BUTTON_ID) {
    // Ack first (avoids Discord's "interaction failed" flash), then remove the suggestion.
    await interaction.deferUpdate();
    if (interaction.guildId) capture('dedup_dismissed', interaction.guildId);
    await interaction.message.delete().catch(() => undefined);
    return;
  }

  if (interaction.customId === SOLVE_BUTTON_ID) {
    // Force an answer rather than an empty solve.
    await interaction.showModal(buildSolveModal(interaction.message.id));
    return;
  }

  if (interaction.customId.startsWith(MOVE_BUTTON_PREFIX)) {
    if (moving.has(channel.id)) {
      await interaction.deferUpdate().catch(() => undefined);
      return;
    }
    moving.add(channel.id);
    try {
      await moveQuestion(interaction, channel, interaction.customId.slice(MOVE_BUTTON_PREFIX.length));
    } finally {
      moving.delete(channel.id);
    }
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
  const isOp = await isThreadAsker(channel, interaction.user.id);
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
    via: 'modal',
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
      // Nav first: handleHubButton admin-gates everything it doesn't recognise
      // early, and Insights/Help are open to every member.
      if (isNavInteraction(interaction.customId)) await handleNavButton(interaction);
      // Hubs (website / settings / dashboard / insights) run anywhere, so route them next.
      else if (isCustomizeInteraction(interaction.customId)) await handleCustomizeButton(interaction);
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
    await safeReply(
      interaction,
      '⚠️ Something went wrong handling that — please try again in a moment. If it keeps happening, check that I have the permissions listed in `/dejavue dashboard`.',
    );
  }
}
