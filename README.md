<div align="center">

![Forktober GIF](https://raw.githubusercontent.com/ACM-VIT/.github/master/profile/acm_gif_banner.gif)

<h2>Conclave</h2>

<p>Real-time meetings platform with web and native clients, a mediasoup SFU, and an in-meeting apps SDK.</p>

<p>
  <a href="https://acmvit.in/" target="_blank">
    <img alt="made-by-acm" src="https://img.shields.io/badge/MADE%20BY-ACM%20VIT-orange?style=flat-square&logo=acm&link=acmvit.in" />
  </a>
</p>

</div>

## Contents

- [Workspace](#workspace)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Checks](#checks)
- [Native App](#native-app)
- [In-Meeting Apps and Games](#in-meeting-apps-and-games)
- [Optional Services and Deploys](#optional-services-and-deploys)
- [Documentation](#documentation)
- [Contributing](#contributing)

## Workspace

| Path | Role | Docs |
| --- | --- | --- |
| `apps/web` | Next.js web client, API routes, transcript and scheduling email Workers | [`apps/web/README.md`](./apps/web/README.md) |
| `apps/conclave-skip` | Native iOS and Android client (SwiftUI transpiled via Skip) | [`apps/conclave-skip/README.md`](./apps/conclave-skip/README.md) |
| `packages/sfu` | mediasoup SFU, socket.io signaling, admin API, game runtime | [`packages/sfu/README.md`](./packages/sfu/README.md) |
| `packages/apps-sdk` | In-meeting collaborative apps (Yjs) and server-authoritative apps/games SDK | [`packages/apps-sdk/README.md`](./packages/apps-sdk/README.md) |
| `packages/ai` | Shared AI model registry, provider adapters, and decision models | [`packages/ai/README.md`](./packages/ai/README.md) |
| `packages/meeting-core` | Pure meeting state, types, join claims, and grid layout shared across surfaces | [`packages/meeting-core/README.md`](./packages/meeting-core/README.md) |
| `packages/shared-browser` | Optional per-room shared browser (Cloudflare Kitesurf or Chromium/noVNC) | [`packages/shared-browser/README.md`](./packages/shared-browser/README.md) |
| `packages/ui-tokens` | Design tokens, web primitives, and native icon/token generators | [`packages/ui-tokens/README.md`](./packages/ui-tokens/README.md) |

## Prerequisites

- Node.js `>=22.22.0`
- `pnpm` `12.16.1` (if an older Corepack shim fails on pnpm 12, run `npx get-pnpm 12.16.1` or `npm exec --yes --package=pnpm@12.16.1 -- pnpm`)
- Swift and Xcode (macOS) for `apps/conclave-skip`; JDK 21 and Android SDK Platform 37 for Android builds
- Docker (optional, required for `pnpm check:docker-images` and local container deploys)

## Quick Start

Install workspace dependencies:

```bash
pnpm install
```

Start the SFU (listens on `http://localhost:3031` by default):

```bash
pnpm -C packages/sfu run dev
```

Start the web client in a second terminal:

```bash
pnpm -C apps/web run dev
```

Open `http://localhost:3000`.

Local defaults:

- Under `next dev`, the web app connects to `http://localhost:3031` unless `SFU_URL` or `NEXT_PUBLIC_SFU_URL` is set. Production builds fall back to `https://sfu.acmvit.in`.
- The SFU runs with development defaults locally. Production requires real secrets, CORS origins, and announced IPs (see [`packages/sfu/README.md`](./packages/sfu/README.md)).
- PostHog telemetry stays off until a project key is configured. Variables and ingestion rules live in [`apps/web/src/app/lib/telemetry.md`](./apps/web/src/app/lib/telemetry.md).

## Checks

Run the full repository gate before opening a PR:

```bash
pnpm check
```

Individual gates:

```bash
pnpm lint       # workspace ESLint, web ESLint, konsistent, comment ratchet
pnpm typecheck  # TypeScript checks across web and packages
pnpm test       # unit tests, quality/deploy tests, and native asset tests
pnpm build      # production builds for web and shared-browser
```

## Native App

`apps/conclave-skip` holds the active native client. Shared SwiftUI code compiles directly for iOS and transpiles to Kotlin/Compose for Android via Skip.

```bash
swift build --package-path apps/conclave-skip
swift test --package-path apps/conclave-skip
```

See [`apps/conclave-skip/README.md`](./apps/conclave-skip/README.md) for Android Gradle and Xcode build commands.

## In-Meeting Apps and Games

Collaborative apps (Yjs) and server-authoritative apps/games live in `packages/apps-sdk`.

```bash
pnpm -C packages/apps-sdk run new:app timer
pnpm -C packages/apps-sdk run new:app sign-up --runtime authority
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run check:apps:fix
```

Start with [`packages/apps-sdk/README.md`](./packages/apps-sdk/README.md) or the full docs tree in [`packages/apps-sdk/docs/README.md`](./packages/apps-sdk/docs/README.md).

## Optional Services and Deploys

Run the shared browser service locally:

```bash
pnpm -C packages/shared-browser run dev
```

Before deploying the SFU or shared browser service, build and boot both Docker images against a local Docker daemon (OrbStack, Docker Desktop, Colima, or native Linux):

```bash
pnpm check:docker-images
```

This runs `pnpm check:docker-context`, builds `packages/sfu/Dockerfile` and `packages/shared-browser/Dockerfile` from the repo root, boots each container, verifies `/health` returns `200`, confirms the SFU can import `@conclave/apps-sdk`, and cleans up its containers and tags. Pass `--no-cache` for a cold build, and stop with Ctrl-C or SIGTERM so cleanup runs. Do not deploy if it fails.

Deploy scripts:

```bash
./scripts/deploy-sfu.sh              # zero-downtime SFU pair deploy with canary
./scripts/deploy-browser-service.sh  # standalone Chromium/noVNC shared browser
```

## Documentation

- Architecture decision records: [`docs/adr/README.md`](./docs/adr/README.md)
- Operations runbooks: [`docs/ops/sfu-deploys.md`](./docs/ops/sfu-deploys.md), [`docs/ops/backups.md`](./docs/ops/backups.md), [`docs/ops/staging.md`](./docs/ops/staging.md)
- SFU HTTP and socket reference: [`packages/sfu/API.md`](./packages/sfu/API.md)
- Telemetry: [`apps/web/src/app/lib/telemetry.md`](./apps/web/src/app/lib/telemetry.md)

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a PR. Participation is covered by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

<div align="center">

🤍 Crafted with love by <a href="https://acmvit.in/" target="_blank">ACM-VIT</a>

![Footer GIF](https://raw.githubusercontent.com/ACM-VIT/.github/master/profile/domains.gif)

</div>
