FROM node:22-bookworm-slim

WORKDIR /app

# Build deps for mediasoup native module.
# Using debian-slim instead of alpine because mediasoup ships pre-built for glibc only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip make g++ ca-certificates \
      dumb-init wget \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sfu/package.json packages/sfu/package.json
RUN pnpm install --filter @conclave/sfu... --frozen-lockfile

COPY . .

# Default state dir; volume-mount this in prod for durability.
RUN mkdir -p /var/lib/conclave && chown -R node:node /var/lib/conclave

ENV CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["pnpm", "-C", "packages/sfu", "run", "start"]
