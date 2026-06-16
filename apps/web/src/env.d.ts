/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** The subdomain label from the Host header (null on apex / www). */
    slug: string | null;
    /** Resolved tenant guild, or null if the slug is unknown / not opted in. */
    tenant: { guildId: string; slug: string; embeddingModel: string } | null;
  }
}
