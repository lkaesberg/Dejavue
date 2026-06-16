import { type BaseMessageOptions, type Interaction, MessageFlags } from 'discord.js';

/** Ephemeral text reply payload. */
export function eph(content: string): BaseMessageOptions & { flags: MessageFlags.Ephemeral } {
  return { content, flags: MessageFlags.Ephemeral };
}

/** Best-effort error reply that works whether or not the interaction was deferred. */
export async function safeReply(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(eph(content));
    } else {
      await interaction.reply(eph(content));
    }
  } catch {
    /* nothing more we can do */
  }
}
