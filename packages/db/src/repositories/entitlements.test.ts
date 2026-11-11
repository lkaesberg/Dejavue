import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import type { Database } from '../client';
import * as schema from '../schema';
import { markEntitlementDeleted, upsertEntitlement } from './entitlements';
import { swapLastTier } from './guilds';
import { revokeTopUpGrant } from './quota';

/** A database that records each statement instead of running it. */
function recordingDb(): { db: Database; queries: { sql: string; params: unknown[] }[] } {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(
    async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    { schema },
  ) as unknown as Database;
  return { db, queries };
}

const last = (q: { sql: string }[]): string => q.at(-1)?.sql ?? '';

describe('entitlement mirror', () => {
  it('never erases a bridged guild or un-consumes a row on a guild-less update', async () => {
    const { db, queries } = recordingDb();
    const guild = await upsertEntitlement(db, { id: 'e1', skuId: 's', guildId: null, userId: 'u' });
    expect(guild).toBeNull();
    const sql = last(queries);
    expect(sql).toContain('"guild_id" = coalesce("entitlement"."guild_id", excluded.guild_id)');
    expect(sql).toContain('"consumed" = ("entitlement"."consumed" or excluded.consumed)');
    expect(sql).toMatch(/returning "guild_id"$/);
  });

  it('flips deleted only once so a refund is reversed once', async () => {
    const { db, queries } = recordingDb();
    expect(await markEntitlementDeleted(db, 'e1')).toBeUndefined();
    const flip = queries[0]!;
    expect(flip.sql).toMatch(/^update "entitlement" set "deleted" = \$1/);
    expect(flip.sql).toContain('"entitlement"."deleted" = $');
    expect(flip.params).toEqual(expect.arrayContaining([true, 'e1', false]));
  });

  it('zeroes the remaining credits of a refunded top-up', async () => {
    const { db, queries } = recordingDb();
    await revokeTopUpGrant(db, 'e1');
    expect(last(queries)).toMatch(
      /^update "top_up_grant" set "credits_remaining" = \$1 where "top_up_grant"\."id" = \$2/,
    );
    expect(queries.at(-1)?.params).toEqual([0, 'e1']);
  });
});

describe('guild_config.last_tier', () => {
  it('moves the marker by compare-and-set', async () => {
    const { db, queries } = recordingDb();
    expect(await swapLastTier(db, 'g', 'free', 'pro')).toBe(false);
    expect(last(queries)).toContain('"guild_config"."last_tier" = $');
    expect(queries.at(-1)?.params).toEqual(expect.arrayContaining(['pro', 'g', 'free']));
    await swapLastTier(db, 'g', null, 'plus');
    expect(last(queries)).toContain('"guild_config"."last_tier" is null');
  });
});
