FROM node:22-bookworm-slim

WORKDIR /app

# Build deps for mediasoup native module.
# Using debian-slim instead of alpine because mediasoup ships pre-built for glibc only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip make g++ ca-certificates \
      dumb-init wget \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Default state dir; volume-mount this in prod for durability.
RUN mkdir -p /var/lib/conclave && chown -R node:node /var/lib/conclave

ENV CONCLAVE_SQLITE_PATH=/var/lib/conclave/conclave.sqlite

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "run", "start"]
