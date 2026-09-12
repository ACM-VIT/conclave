FROM node:22-bookworm-slim

WORKDIR /app

RUN npm install --global pnpm@12.4.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared-browser/package.json packages/shared-browser/package.json
RUN pnpm install --filter @conclave/shared-browser... --frozen-lockfile --node-linker=isolated

COPY packages/shared-browser/tsconfig.json packages/shared-browser/tsconfig.json
COPY packages/shared-browser/src packages/shared-browser/src
RUN pnpm -C packages/shared-browser run build

EXPOSE 3040

CMD ["node", "packages/shared-browser/dist/server.js"]
