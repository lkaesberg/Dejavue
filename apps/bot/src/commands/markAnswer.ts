import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags } from 'discord.js';
import { forumParent } from '../lib/forum';
import { canResolveThread, NO_PERMISSION_MESSAGE } from '../lib/permissions';
import { eph } from '../lib/reply';
import { closeThread, solveThread } from '../lib/solve';
import type { MessageContextCommand } from './types';

const data = new ContextMenuCommandBuilder()
  .setName('Mark as Answer')
  .setType(ApplicationCommandType.Message);

export const markAnswerCommand: MessageContextCommand = {
  data,
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply(eph('Use this in a server.'));
      return;
    }
    const channel = interaction.channel;
    if (!channel || !channel.isThread() || !forumParent(channel)) {
      await interaction.reply(eph('Use this on a reply inside a forum post.'));
      return;
    }
    const isOp = channel.ownerId === interaction.user.id;
    if (!canResolveThread(interaction.memberPermissions, isOp)) {
      await interaction.reply(eph(NO_PERMISSION_MESSAGE));
      return;
    }
    const answer = interaction.targetMessage;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await solveThread(channel, { answer, solverId: interaction.user.id });
    await closeThread(channel);
    await interaction.editReply(
      `✅ Recorded ${answer.author}'s reply as the answer, marked this solved, and closed the thread.`,
    );
  },
};
