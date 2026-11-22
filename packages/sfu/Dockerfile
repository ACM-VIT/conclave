# Build stage: the compiler toolchain and pnpm exist only here.
# Using debian-slim instead of alpine because mediasoup ships pre-built for glibc only.
# Trixie supplies the glibc/libstdc++ versions required by current mediasoup worker prebuilds.
FROM node:22-trixie-slim AS build

WORKDIR /app

# Build deps for the mediasoup worker, used when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

RUN npm install --global pnpm@12.16.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/ai/package.json packages/ai/package.json
COPY packages/sfu/package.json packages/sfu/package.json
COPY packages/shared-browser/package.json packages/shared-browser/package.json
COPY packages/ui-tokens/package.json packages/ui-tokens/package.json
RUN pnpm install --filter @conclave/sfu... --frozen-lockfile --node-linker=isolated --prod

COPY packages ./packages
RUN node packages/sfu/scripts/ensure-mediasoup-worker.mjs

# Runtime stage: Node, the installed production dependencies (including the
# mediasoup worker binary) and the SFU sources, all owned by root and read-only
# to the unprivileged `node` user. Only /var/lib/conclave is writable.
FROM node:22-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

COPY --from=build --chown=root:root /app /app

# Default state dir; volume-mount this in prod for durability.
RUN mkdir -p /var/lib/conclave/recordings && chown -R node:node /var/lib/conclave

# The JSON persistence backends (selected by a *_PERSISTENCE variable, or the
# fallback when SQLite cannot open) write to the recordings volume, the only
# writable path under compose's read-only root.
ENV CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite \
    SCHEDULING_PATH=/var/lib/conclave/recordings/scheduling.json \
    SCHEDULED_MEETINGS_PATH=/var/lib/conclave/recordings/scheduled-meetings.json \
    SCHEDULED_WEBINARS_PATH=/var/lib/conclave/recordings/scheduled-webinars.json

USER node
WORKDIR /app/packages/sfu
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--import", "tsx", "server.ts"]
