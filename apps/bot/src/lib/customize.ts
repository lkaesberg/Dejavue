import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { childLogger, getEnv, hashPassphrase, type Tier, tierAtLeast } from '@dejavue/core';
import {
  ensureGuildConfig,
  getActiveOtp,
  getDb,
  recordPurchaseIntent,
  getGuildConfig,
  type GuildConfig,
  type KbAccent,
  type KbCorners,
  type KbHeadingFont,
  type KbImprint,
  type KbTheme,
  publishExistingSolved,
  publishExistingTracked,
  updateGuildConfig,
} from '@dejavue/db';
import { enqueueRevalidateKb } from '@dejavue/queue';
import { checkDomainDns, dnsInstructions } from './domainDns';
import { COLOR } from './embeds';
import { imprintComplete, isPubliclyLive } from './kbGate';
import { eph } from './reply';
import { getGuildTier } from './tier';
import { upsellPayload } from './upsell';

const log = childLogger({ mod: 'cmd:customize' });

// ---------------------------------------------------------------------------
// One command — `/dejavue customize` — replaces the old `kb` + `domain` commands
// and covers the design's full set of KB-customization options. It posts an
// ephemeral *hub* (appearance selects + buttons); text fields are entered in a
// modal that pops up from the "Edit details" / "Imprint" buttons.
// ---------------------------------------------------------------------------

export const CUST_PREFIX = 'dejavue:cust:';
const ID = {
  theme: `${CUST_PREFIX}theme`,
  accent: `${CUST_PREFIX}accent`,
  corners: `${CUST_PREFIX}corners`,
  font: `${CUST_PREFIX}font`,
  details: `${CUST_PREFIX}details`,
  imprint: `${CUST_PREFIX}imprint`,
  publish: `${CUST_PREFIX}publish`,
  detailsModal: `${CUST_PREFIX}details-modal`,
  imprintModal: `${CUST_PREFIX}imprint-modal`,
} as const;

/** True for any interaction belonging to the customize hub (routed in interactionCreate). */
export function isCustomizeInteraction(customId: string): boolean {
  return customId.startsWith(CUST_PREFIX);
}

// ---- option lists (mirror the design's appearance dock) -------------------
const THEME_OPTS: { value: KbTheme; label: string; desc: string }[] = [
  { value: 'light', label: 'Light', desc: 'White background, dark text' },
  { value: 'dark', label: 'Dark', desc: 'Dark background, light text' },
];
const ACCENT_OPTS: { value: KbAccent; label: string; desc: string }[] = [
  { value: 'indigo', label: 'Indigo', desc: 'Default — indigo → violet' },
  { value: 'blue', label: 'Blue', desc: 'Blue → indigo' },
  { value: 'teal', label: 'Teal', desc: 'Teal → mint' },
  { value: 'violet', label: 'Violet', desc: 'Violet → purple' },
  { value: 'amber', label: 'Amber', desc: 'Amber → orange' },
];
const CORNER_OPTS: { value: KbCorners; label: string; desc: string }[] = [
  { value: 'rounded', label: 'Rounded', desc: 'Soft 14px corners' },
  { value: 'sharp', label: 'Sharp', desc: 'Tight 6px corners' },
];
const FONT_OPTS: { value: KbHeadingFont; label: string; desc: string }[] = [
  { value: 'grotesk', label: 'Space Grotesk', desc: 'Default display font' },
  { value: 'sans', label: 'Inter (sans)', desc: 'Clean neutral sans' },
  { value: 'serif', label: 'Serif', desc: 'Classic Georgia serif' },
];

// ---- validation (shared with the old kb/domain commands) ------------------
const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'docs', 'status', 'admin', 'dejavue', 'mail', 'cdn']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function labelFor<T extends string>(opts: { value: T; label: string }[], value: T): string {
  return opts.find((o) => o.value === value)?.label ?? value;
}

function appearanceRow(
  customId: string,
  placeholder: string,
  opts: { value: string; label: string; desc: string }[],
  current: string,
  disabled: boolean,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setDisabled(disabled)
    .addOptions(
      opts.map((o) =>
        new StringSelectMenuOptionBuilder()
          .setValue(o.value)
          .setLabel(o.label)
          .setDescription(o.desc)
          .setDefault(o.value === current),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** Build the whole hub message (embed + components) for a guild's current config. */
function hubPayload(cfg: GuildConfig, tier: Tier, kbBaseDomain: string): BaseMessageOptions {
  const paid = tierAtLeast(tier, 'plus');
  const url = cfg.kbSlug ? `https://${cfg.kbSlug}.${kbBaseDomain}` : '—';
  const brand = cfg.brandName?.trim() || cfg.kbSlug || '(uses slug)';
  const imprintOk = imprintComplete(cfg.kbImprint);
  const needsImprint = isPubliclyLive(cfg) && !imprintOk;

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🎨 Customize your knowledge base')
    .setDescription(
      (paid
        ? 'Pick a theme, accent, corners and heading font below — they apply to your live site instantly. ' +
          'Use **Edit details** for the name, slug, domain and passphrase.'
        : 'Set your **name, slug, passphrase** and **publishing** below. Theme, accent, corners & fonts are a ' +
          '**Plus** feature — upgrade to fully brand your site.') +
        (needsImprint
          ? '\n\n⚠️ **Your site is public but its imprint is incomplete.** Public sites must name an operator ' +
            'and a contact (Terms of Service § 4) — add them via **Imprint…** below.'
          : ''),
    )
    .addFields(
      { name: 'Brand name', value: brand, inline: true },
      { name: 'Public URL', value: cfg.customDomain ? `https://${cfg.customDomain}` : url, inline: true },
      { name: 'Public site', value: cfg.kbPublishOptIn ? '✅ on' : '⛔ off', inline: true },
      { name: 'Privacy', value: cfg.kbPassphraseHash ? '🔒 passphrase' : '🌐 public', inline: true },
      { name: 'Theme', value: labelFor(THEME_OPTS, cfg.kbTheme), inline: true },
      { name: 'Accent', value: labelFor(ACCENT_OPTS, cfg.kbAccent), inline: true },
      { name: 'Corners', value: labelFor(CORNER_OPTS, cfg.kbCorners), inline: true },
      { name: 'Heading font', value: labelFor(FONT_OPTS, cfg.kbHeadingFont), inline: true },
      { name: 'Imprint', value: imprintOk ? '✅ set' : needsImprint ? '⚠️ required — site is public' : '— not set', inline: true },
    );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ID.details).setLabel('Edit details…').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(ID.imprint).setLabel('Imprint…').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ID.publish)
      .setLabel(cfg.kbPublishOptIn ? 'Turn site off' : 'Turn site on')
      .setEmoji(cfg.kbPublishOptIn ? '⛔' : '🌍')
      .setStyle(cfg.kbPublishOptIn ? ButtonStyle.Secondary : ButtonStyle.Success),
  );

  return {
    embeds: [embed],
    components: [
      appearanceRow(ID.theme, 'Theme', THEME_OPTS, cfg.kbTheme, !paid),
      appearanceRow(ID.accent, 'Accent color', ACCENT_OPTS, cfg.kbAccent, !paid),
      appearanceRow(ID.corners, 'Corner style', CORNER_OPTS, cfg.kbCorners, !paid),
      appearanceRow(ID.font, 'Heading font', FONT_OPTS, cfg.kbHeadingFont, !paid),
      buttons,
    ],
  };
}

function detailsModal(cfg: GuildConfig): ModalBuilder {
  const row = (input: TextInputBuilder) => new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  return new ModalBuilder()
    .setCustomId(ID.detailsModal)
    .setTitle('Knowledge base details')
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('brand')
          .setLabel('Display name (e.g. Helio)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(60)
          .setValue(cfg.brandName ?? ''),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('slug')
          .setLabel('Subdomain slug')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(40)
          .setPlaceholder('e.g. helio → helio.dejavue.app')
          .setValue(cfg.kbSlug ?? ''),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('domain')
          .setLabel('Custom domain (blank/none to remove)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(253)
          .setValue(cfg.customDomain ?? ''),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('passphrase')
          .setLabel('Passphrase')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(128)
          .setPlaceholder(
            cfg.kbPassphraseHash
              ? '•••••• set — blank keeps it · type "none" to make public'
              : 'Set a passphrase to make the KB private (blank = public)',
          ),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('logo')
          .setLabel('Logo image URL (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500)
          .setValue(cfg.kbLogoUrl ?? ''),
      ),
    );
}

function imprintModal(cfg: GuildConfig): ModalBuilder {
  const im = cfg.kbImprint ?? {};
  const row = (input: TextInputBuilder) => new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  return new ModalBuilder()
    .setCustomId(ID.imprintModal)
    .setTitle('Imprint (legal page)')
    .addComponents(
      row(new TextInputBuilder().setCustomId('operator').setLabel('Operator').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('Who runs this knowledge base — required while the site is public').setValue(im.operator ?? '')),
      row(new TextInputBuilder().setCustomId('contact').setLabel('Contact (email)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setPlaceholder('An email readers can reach — required while the site is public').setValue(im.contact ?? '')),
      row(new TextInputBuilder().setCustomId('representedBy').setLabel('Represented by').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setValue(im.representedBy ?? '')),
      row(new TextInputBuilder().setCustomId('responsible').setLabel('Responsible for content').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(120).setValue(im.responsible ?? '')),
    );
}

/**
 * Ephemeral refusal shown when an action would make the KB publicly reachable
 * without the imprint minimum (operator + contact). The button reuses ID.imprint,
 * so the existing interaction routing opens the imprint modal directly.
 */
function imprintRequiredPayload(): BaseMessageOptions {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('⚖️ Add an imprint before going public')
    .setDescription(
      'A publicly reachable knowledge base must say who operates it. Fill in at least **Operator** and ' +
        "**Contact** — they appear on your site's `/imprint` page.\n\n" +
        `This identification is required by the [Terms of Service](${getEnv().KB_PUBLIC_URL}/terms) ` +
        '(§ 4 — your own legal notices), and in many countries by law. Passphrase-protected (private) ' +
        'sites are exempt.',
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ID.imprint).setLabel('Fill in imprint…').setEmoji('✏️').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `/dejavue customize` entry — posts the hub (admin only). */
export async function handleCustomize(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(eph('You need the **Manage Server** permission to customize the knowledge base.'));
    return;
  }
  const guildId = interaction.guildId!;
  const db = getDb();
  const cfg = await ensureGuildConfig(db, guildId);
  const tier = await getGuildTier(guildId);
  await interaction.reply({
    ...hubPayload(cfg, tier, getEnv().KB_BASE_DOMAIN),
    flags: MessageFlags.Ephemeral,
  });
}

async function rerender(
  interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
  guildId: string,
): Promise<void> {
  const cfg = await getGuildConfig(getDb(), guildId);
  if (!cfg) return;
  const tier = await getGuildTier(guildId);
  const payload = hubPayload(cfg, tier, getEnv().KB_BASE_DOMAIN);
  if (interaction.isModalSubmit()) {
    if (interaction.isFromMessage()) await interaction.update(payload);
    return;
  }
  await interaction.update(payload);
}

/** Appearance selects (theme/accent/corners/font) — apply live, Plus+ only. */
export async function handleCustomizeSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const tier = await getGuildTier(guildId);
  if (!tierAtLeast(tier, 'plus')) {
    await interaction.reply({
      ...upsellPayload({
        title: 'Appearance is a Plus feature',
        description: 'Theme, accent, corners and fonts are available on **Plus** and up.',
        skuId: getEnv().SKU_PLUS,
      }),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const value = interaction.values[0];
  const db = getDb();
  const patch: Parameters<typeof updateGuildConfig>[2] = {};
  if (interaction.customId === ID.theme) patch.kbTheme = value as KbTheme;
  else if (interaction.customId === ID.accent) patch.kbAccent = value as KbAccent;
  else if (interaction.customId === ID.corners) patch.kbCorners = value as KbCorners;
  else if (interaction.customId === ID.font) patch.kbHeadingFont = value as KbHeadingFont;
  await updateGuildConfig(db, guildId, patch);
  await enqueueRevalidateKb({ guildId, threadId: 'all', action: 'publish' }).catch(() => undefined);
  await rerender(interaction, guildId);
}

/** Hub buttons: open the detail/imprint modals, or toggle publishing. */
export async function handleCustomizeButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();
  const cfg = await ensureGuildConfig(db, guildId);
  if (interaction.customId === ID.details) {
    await interaction.showModal(detailsModal(cfg));
    return;
  }
  if (interaction.customId === ID.imprint) {
    await interaction.showModal(imprintModal(cfg));
    return;
  }
  if (interaction.customId === ID.publish) {
    const next = !cfg.kbPublishOptIn;
    // Turning the site on may make it publicly reachable — that requires the imprint
    // minimum first (ToS § 4). Passphrase-gated and slug-less sites stay ungated.
    if (next && isPubliclyLive({ ...cfg, kbPublishOptIn: true }) && !imprintComplete(cfg.kbImprint)) {
      await interaction.reply({ ...imprintRequiredPayload(), flags: MessageFlags.Ephemeral });
      return;
    }
    await updateGuildConfig(db, guildId, { kbPublishOptIn: next });
    if (next) {
      // Turning the public site on. Everything indexed is auto-published already, but
      // flip any legacy unpublished rows so older content shows up too.
      await publishExistingSolved(db, guildId).catch((err) =>
        log.warn({ err, guildId }, 'publish-existing on enable failed'),
      );
      for (const channelId of cfg.trackedChannelIds) {
        await publishExistingTracked(db, guildId, channelId).catch(() => undefined);
      }
    }
    await enqueueRevalidateKb({ guildId, threadId: 'all', action: next ? 'publish' : 'unpublish' }).catch(
      () => undefined,
    );
    await rerender(interaction, guildId);
  }
}

/**
 * Purchase-confirmed + live DNS status + the exact record to create, shown
 * right after an admin saves a custom domain.
 */
async function domainStatusEmbed(domain: string, kbHost: string): Promise<EmbedBuilder> {
  const dns = await checkDomainDns(domain, kbHost);
  const statusLine =
    dns.status === 'ok'
      ? `✅ DNS is set up correctly (${dns.via === 'cname' ? 'CNAME' : 'ALIAS/A record'} → \`${dns.found}\`). ` +
        `Your knowledge base is live at https://${domain} — the TLS certificate is provisioned automatically on first request.`
      : dns.status === 'wrong-target'
        ? `⚠️ \`${domain}\` currently points at \`${dns.found}\` — update the record below and it will switch over as DNS propagates.`
        : `⏳ \`${domain}\` doesn't resolve to us yet. Create the record below — propagation usually takes minutes, sometimes up to a day.`;
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`Custom domain: ${domain}`)
    .setDescription(
      `✅ Your custom-domain purchase is active — **${domain}** is saved.\n\n${statusLine}\n\n${dnsInstructions(domain, kbHost)}\n` +
        '_HTTPS is enforced; the certificate is issued automatically once DNS points here. ' +
        'Re-save the domain in **Edit details** anytime to re-run this check._',
    );
}

/** Modal submissions: save details / imprint, then re-render the hub. */
export async function handleCustomizeModal(interaction: ModalSubmitInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const db = getDb();

  if (interaction.customId === ID.detailsModal) {
    const env = getEnv();
    const cfg = await ensureGuildConfig(db, guildId);
    const patch: Parameters<typeof updateGuildConfig>[2] = {};
    const errors: string[] = [];

    const brand = interaction.fields.getTextInputValue('brand').trim();
    patch.brandName = brand || null;

    const logo = interaction.fields.getTextInputValue('logo').trim();
    if (logo && !/^https:\/\/\S+$/i.test(logo)) errors.push('Logo must be an `https://` URL.');
    else patch.kbLogoUrl = logo || null;

    const rawSlug = interaction.fields.getTextInputValue('slug').trim().toLowerCase();
    if (rawSlug) {
      if (!SLUG_RE.test(rawSlug) || RESERVED_SLUGS.has(rawSlug)) {
        errors.push('Slug must be 2–40 lowercase letters/numbers/hyphens (not a reserved word).');
      } else {
        patch.kbSlug = rawSlug;
      }
    }

    const rawDomain = interaction.fields.getTextInputValue('domain').trim().toLowerCase();
    let domainSaved: string | null = null;
    if (rawDomain === '' || rawDomain === 'none' || rawDomain === 'remove') {
      patch.customDomain = null;
    } else {
      const otp = env.SKU_CUSTOM_DOMAIN ? await getActiveOtp(db, guildId, env.SKU_CUSTOM_DOMAIN) : undefined;
      if (!otp && !env.DEV_FORCE_TIER) {
        // One-time purchases are user-owned (no guildId on the entitlement), so
        // record which guild this admin is buying for before we surface the button.
        if (env.SKU_CUSTOM_DOMAIN) {
          await recordPurchaseIntent(db, {
            userId: interaction.user.id,
            skuId: env.SKU_CUSTOM_DOMAIN,
            guildId,
          });
        }
        // Not allowed (yet): answer with the native purchase button, not just text.
        await interaction.reply({
          ...upsellPayload({
            title: 'Custom domain is a one-time purchase',
            description:
              `Serving your knowledge base on **${rawDomain}** needs the custom-domain purchase for this server. ` +
              'Buy it below, then set the domain here again — I’ll walk you through the DNS setup.',
            skuId: env.SKU_CUSTOM_DOMAIN,
          }),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!DOMAIN_RE.test(rawDomain) || rawDomain.endsWith(env.KB_BASE_DOMAIN)) {
        errors.push('Custom domain looks invalid. Use a hostname you own, e.g. `help.yoursite.com`.');
      } else {
        patch.customDomain = rawDomain;
        domainSaved = rawDomain;
      }
    }

    // Blank = KEEP the current passphrase (so editing other fields can't accidentally
    // make a private KB public). An explicit "none"/"remove"/"public" clears the gate.
    const passphrase = interaction.fields.getTextInputValue('passphrase').trim();
    if (['none', 'remove', 'public', 'off'].includes(passphrase.toLowerCase())) {
      patch.kbPassphraseHash = null;
    } else if (passphrase) {
      patch.kbPassphraseHash = hashPassphrase(passphrase);
    }

    if (errors.length) {
      await interaction.reply(eph(`⚠️ ${errors.join('\n')}`));
      return;
    }
    // Block the transition into public-live (first slug/domain, passphrase removed)
    // until the imprint identifies the operator (ToS § 4). Already-live sites only get
    // the hub warning, so unrelated edits never lock up.
    if (!isPubliclyLive(cfg) && isPubliclyLive({ ...cfg, ...patch }) && !imprintComplete(cfg.kbImprint)) {
      await interaction.reply({ ...imprintRequiredPayload(), flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await updateGuildConfig(db, guildId, patch);
    } catch (err) {
      log.warn({ err, guildId }, 'customize details save failed');
      await interaction.reply(eph('That slug is already taken — pick another.'));
      return;
    }
    await enqueueRevalidateKb({ guildId, threadId: 'all', action: 'publish' }).catch(() => undefined);
    await rerender(interaction, guildId);
    // A domain was set → confirm the purchase is active, check DNS live, and
    // show exactly which record to create. Re-saving the domain re-runs this,
    // so it doubles as a "check my DNS again" button.
    if (domainSaved) {
      await interaction
        .followUp({ embeds: [await domainStatusEmbed(domainSaved, env.KB_BASE_DOMAIN)], flags: MessageFlags.Ephemeral })
        .catch((err) => log.warn({ err, guildId }, 'domain status follow-up failed'));
    }
    return;
  }

  if (interaction.customId === ID.imprintModal) {
    const imprint: KbImprint = {
      operator: interaction.fields.getTextInputValue('operator').trim() || undefined,
      contact: interaction.fields.getTextInputValue('contact').trim() || undefined,
      representedBy: interaction.fields.getTextInputValue('representedBy').trim() || undefined,
      responsible: interaction.fields.getTextInputValue('responsible').trim() || undefined,
    };
    const empty = !Object.values(imprint).some(Boolean);
    const cfg = await ensureGuildConfig(db, guildId);
    // A live public site can't drop below the imprint minimum — turn the site off or
    // set a passphrase first, then trim the imprint.
    if (isPubliclyLive(cfg) && !imprintComplete(imprint)) {
      await interaction.reply(
        eph(
          '⚠️ Your site is publicly live, so the imprint must keep at least **Operator** and **Contact**. ' +
            'Turn the site off or set a passphrase first if you want to remove them.',
        ),
      );
      return;
    }
    await updateGuildConfig(db, guildId, { kbImprint: empty ? null : imprint });
    await enqueueRevalidateKb({ guildId, threadId: 'all', action: 'publish' }).catch(() => undefined);
    await rerender(interaction, guildId);
  }
}
