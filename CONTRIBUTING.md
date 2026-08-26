# Contributing to Dejavue

Thanks for taking the time to help out. Bug reports, feature ideas and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/lkaesberg/Dejavue.git
cd Dejavue
make setup          # install + .env + Postgres + migrations
```

Then fill in `.env` (at minimum `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`) and set
`DEV_FORCE_TIER=max` so every feature is unlocked locally without real Discord SKUs.

```bash
make dev            # Postgres + migrations + bot + worker + web, live reload
```

`make help` lists every task. If you use VS Code or Cursor, "Reopen in Container" sets all of this up
for you.

You'll want your own test server on Discord and your own bot application — see
[Discord Application Setup](./README.md#discord-application-setup) in the README.

## Before you open a pull request

```bash
make check          # typecheck + tests — CI runs exactly this
```

Both must pass. If you changed behaviour, add or update a test next to the code
(`*.test.ts` beside the module it covers).

## Working on the code

- **Match the surrounding code.** Naming, comment density and structure vary a little by package —
  follow whatever the file you're in already does.
- **Keep tier gating in one place.** Feature limits live in `packages/core/src/types.ts`
  (`tierLimits`). Don't scatter tier checks through the bot or web app.
- **Database changes** need a migration: edit the Drizzle schema in `packages/db`, then run
  `pnpm db:generate` and commit the generated SQL.
- **Anything user-facing on the public website** must respect the privacy rules: no Discord
  usernames, display names or avatars in published output, ever. Authors are aliased.
- **Privacy and legal claims** on the website (no tracking, self-hosted assets, payments inside
  Discord) are load-bearing. If a change makes one of them untrue, update the copy in the same PR.

## Where things live

```
packages/core   shared types, env, tier/entitlement logic, clustering
packages/db     Drizzle schema + migrations (pgvector) + repositories
packages/ai     embeddings (Transformers.js) + OpenRouter LLM client
packages/queue  pg-boss queues + job definitions
apps/bot        discord.js gateway client (commands, events, interactions)
apps/worker     pg-boss jobs (embed, summarize, cluster, FAQ, nudge, backfill, reconcile)
apps/web        Astro SSR — public website + /mcp endpoint
```

## Reporting bugs

Open an [issue](https://github.com/lkaesberg/Dejavue/issues) and include what you expected, what
happened, and how to reproduce it. If it's a bot problem, the command you ran and any error message
Dejavue replied with are the most useful things you can give us.

**Do not** open a public issue for a security vulnerability — see [SECURITY.md](./SECURITY.md).

## License

Dejavue is licensed under the **AGPL-3.0**. By contributing, you agree that your contribution is
licensed under the same terms.
