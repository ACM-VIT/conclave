FROM node:22-trixie-slim

WORKDIR /app

# Build deps for mediasoup native module. Trixie supplies the glibc/libstdc++
# versions required by current mediasoup worker prebuilds.
# Using debian-slim instead of alpine because mediasoup ships pre-built for glibc only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip make g++ ca-certificates \
      dumb-init wget \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

RUN npm install --global pnpm@12.4.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sfu/package.json packages/sfu/package.json
COPY packages/shared-browser/package.json packages/shared-browser/package.json
COPY packages/ui-tokens/package.json packages/ui-tokens/package.json
RUN pnpm install --filter @conclave/sfu... --frozen-lockfile --node-linker=isolated

COPY . .

# Default state dir; volume-mount this in prod for durability.
RUN mkdir -p /var/lib/conclave && chown -R node:node /var/lib/conclave

ENV CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
WORKDIR /app/packages/sfu
CMD ["node", "--import", "tsx", "server.ts"]
