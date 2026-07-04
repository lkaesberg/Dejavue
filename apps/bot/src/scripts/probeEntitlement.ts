import '@dejavue/core/env-preload';
import { REST } from 'discord.js';
import { logger, requireEnv } from '@dejavue/core';

const log = logger();

const USAGE = `Probe Discord entitlements — see what a purchase actually delivers.

Usage:
  pnpm --filter @dejavue/bot probe:entitlement skus
  pnpm --filter @dejavue/bot probe:entitlement list
  pnpm --filter @dejavue/bot probe:entitlement create <skuId> <guild|user> <ownerId>
  pnpm --filter @dejavue/bot probe:entitlement delete <entitlementId>

Notes:
  - "create" also fires ENTITLEMENT_CREATE on the gateway; watch the running bot's
    logs for lines tagged "entitlement-probe" to see the payload it receives.
  - owner_type: guild = 1, user = 2. Try BOTH for a ONE-TIME-PURCHASE SKU (top-up /
    custom domain) to learn whether Discord accepts guild ownership and whether a
    guild_id comes back — that's the whole question.
  - Test entitlements are free; "delete" them afterwards to clean up (a guild-owned
    top-up test entitlement will actually grant credits if the bot is running).`;

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_TOKEN');
  const appId = requireEnv('DISCORD_CLIENT_ID');
  const rest = new REST().setToken(token);
  const base = `/applications/${appId}/entitlements` as `/${string}`;

  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'skus') {
    const res = await rest.get(`/applications/${appId}/skus` as `/${string}`);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'list') {
    const res = await rest.get(base);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'create') {
    const [skuId, ownerKind, ownerId] = args;
    if (!skuId || (ownerKind !== 'guild' && ownerKind !== 'user') || !ownerId) {
      console.error(USAGE);
      process.exit(1);
    }
    const owner_type = ownerKind === 'user' ? 2 : 1;
    const res = await rest.post(base, { body: { sku_id: skuId, owner_id: ownerId, owner_type } });
    console.log('Created test entitlement:');
    console.log(JSON.stringify(res, null, 2));
    const e = res as { guild_id?: string; user_id?: string };
    console.log(
      `\n-> guild_id: ${e.guild_id ?? '(absent)'}   user_id: ${e.user_id ?? '(absent)'}`,
    );
    return;
  }

  if (cmd === 'delete') {
    const [id] = args;
    if (!id) {
      console.error(USAGE);
      process.exit(1);
    }
    await rest.delete(`/applications/${appId}/entitlements/${id}` as `/${string}`);
    console.log(`Deleted test entitlement ${id}`);
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  log.error({ err }, 'entitlement probe failed');
  // Surface Discord's raw API error body (e.g. an explanation of why guild
  // ownership was rejected for a one-time-purchase SKU).
  const raw = (err as { rawError?: unknown }).rawError;
  if (raw) console.error(JSON.stringify(raw, null, 2));
  process.exit(1);
});
