# Dev-container image: plain Node 22 with pnpm available via corepack.
# corepack enable writes to /usr/local/bin, so it must run at build time as
# root — the container itself runs as the unprivileged `node` user.
FROM node:22

RUN corepack enable

# Handy CLIs for poking at the stack from inside the container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client jq \
    && rm -rf /var/lib/apt/lists/*
