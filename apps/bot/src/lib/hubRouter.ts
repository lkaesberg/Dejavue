import type { ButtonInteraction } from 'discord.js';
import { renderWebsiteHub } from './customize';
import { renderHelp } from './help';
import { hubCtx, navNeedsAdmin, navTarget } from './hubNav';
import { renderDashboard, renderInsights, renderSettingsHub } from './hubs';
import { DEFAULT_PAGE } from './settingsPages';
import { eph } from './reply';

/**
 * The nav row's buttons, for every hub.
 *
 * This is the one module that knows about both `hubs.ts` and `customize.ts`, and
 * nothing imports it back — which is what keeps those two from importing each
 * other. `interactionCreate` is its only caller.
 *
 * It must run BEFORE `handleHubButton` in the router: that function applies a
 * Manage Server gate to everything it doesn't recognise early, so a non-admin
 * clicking **Help** from the insights hub would otherwise be told they lack a
 * permission they don't need.
 */
export async function handleNavButton(interaction: ButtonInteraction): Promise<void> {
  const target = navTarget(interaction.customId);
  if (!target) return;
  const ctx = hubCtx(interaction);

  if (navNeedsAdmin(target) && !ctx.admin) {
    await interaction.reply(eph('You need the **Manage Server** permission to open that.'));
    return;
  }
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply(eph('Dejavue only works inside a server.'));
    return;
  }

  // Every hub but help does several DB round-trips, which is more than Discord's
  // three-second acknowledgement window allows for under load. Defer, then edit
  // the message the button lives on.
  await interaction.deferUpdate();
  const guildId = interaction.guildId;
  switch (target) {
    case 'dashboard':
      return void (await interaction.editReply(await renderDashboard(interaction.guild, ctx)));
    case 'settings':
      return void (await interaction.editReply(await renderSettingsHub(guildId, DEFAULT_PAGE, ctx)));
    case 'website':
      return void (await interaction.editReply(await renderWebsiteHub(guildId, 'site', ctx)));
    case 'insights':
      return void (await interaction.editReply(
        await renderInsights(guildId, interaction.user.id, ctx),
      ));
    case 'help':
      return void (await interaction.editReply(renderHelp(ctx)));
  }
}
