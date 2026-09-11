/// <reference types="astro/client" />

import type { Tier } from '@dejavue/core';
import type { GuildConfig } from '@dejavue/db';

declare global {
  namespace App {
    interface Locals {
      /** The subdomain label from the Host header (null on apex / www). */
      slug: string | null;
      /** Resolved tenant guild, or null if the slug is unknown / not opted in. */
      tenant: { guildId: string; slug: string; embeddingModel: string } | null;
      /** The full guild config for the tenant (theme, branding, imprint…), or null. */
      cfg: GuildConfig | null;
      /** The tenant's resolved tier (drives semantic search, branding, AI summaries). */
      tier: Tier;
      /** Whether to show the "powered by dejavue" branding (false once removed on Plus+). */
      branded: boolean;
      /**
       * Whether this knowledge base carries ads (Free only, and only when an ad network
       * is configured). Removing them is a paid perk — see TierLimits.ads.
       */
      showAds: boolean;
    }
  }
}

export {};
