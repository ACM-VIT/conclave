FROM node:22-bookworm-slim

WORKDIR /app

# Build deps for mediasoup native module + Chromium for view recorder + ffmpeg for transcode.
# Using debian-slim instead of alpine because Chromium ships pre-built for glibc only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip make g++ ca-certificates \
      ffmpeg \
      chromium chromium-sandbox \
      xvfb x11-utils xauth \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libasound2 libnss3 libxss1 libdrm2 libgbm1 libxshmfence1 \
      libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
      libatk1.0-0 libatk-bridge2.0-0 libcups2 libpango-1.0-0 \
      dumb-init wget \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV RECORDER_CHROMIUM_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

# Default recordings dir; volume-mount this in prod for durability.
RUN mkdir -p /var/lib/conclave/recordings && chown -R node:node /var/lib/conclave

ENV RECORDING_STORAGE_PATH=/var/lib/conclave/recordings

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "run", "start"]
