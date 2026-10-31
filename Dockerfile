# Shared image for bot / worker / web / migrate. The service command selects
# which app to run (see docker-compose.yml).
FROM node:24.22.1

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable

WORKDIR /app

# Install with dev deps (tsx + astro are needed to run/build) BEFORE NODE_ENV
# is set to production, so pnpm doesn't prune them. --frozen-lockfile (as in CI)
# installs exactly what pnpm-lock.yaml pins and fails if it drifts from package.json.
COPY . .
RUN pnpm install --frozen-lockfile

# Build the Astro web app (bot + worker run via tsx, no build step needed).
RUN pnpm --filter @dejavue/web build

ENV NODE_ENV=production
# Overridden per service in docker-compose.yml.
CMD ["pnpm", "--filter", "@dejavue/bot", "start"]
