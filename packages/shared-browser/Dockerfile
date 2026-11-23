FROM node:22-bookworm-slim

WORKDIR /app

RUN npm install --global pnpm@12.16.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/shared-browser/package.json packages/shared-browser/package.json
RUN pnpm install --filter @conclave/shared-browser... --frozen-lockfile --node-linker=isolated

COPY packages/shared-browser/tsconfig.json packages/shared-browser/tsconfig.json
COPY packages/shared-browser/src packages/shared-browser/src
# Run the package's compiler directly, as the SFU image does after its filtered
# install. `pnpm run` first re-installs the whole workspace, which this context
# holds only part of, and stops on the MediaPipe patch that only apps/web uses.
WORKDIR /app/packages/shared-browser
RUN ./node_modules/.bin/tsc
WORKDIR /app

EXPOSE 3040

CMD ["node", "packages/shared-browser/dist/server.js"]
