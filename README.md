<div align="center">

![Forktober GIF](https://raw.githubusercontent.com/ACM-VIT/.github/master/profile/acm_gif_banner.gif)

<h2>Conclave</h2>

<p>Real-time meetings platform with web/mobile clients, SFU, and an apps SDK</p>

<p>
  <a href="https://acmvit.in/" target="_blank">
    <img alt="made-by-acm" src="https://img.shields.io/badge/MADE%20BY-ACM%20VIT-orange?style=flat-square&logo=acm&link=acmvit.in" />
  </a>
</p>

</div>

---

## Table of Contents

- [About](#about)
- [Monorepo Layout](#monorepo-layout)
- [Quick Start](#quick-start)
- [Mobile Development](#mobile-development)
- [Apps SDK Docs](#apps-sdk-docs)
- [Optional Services](#optional-services)
- [Contributing](#contributing)
- [Community & Conduct](#community--conduct)

---

## About

Conclave is a real-time meetings platform with:

- `apps/web`: Next.js web client and API routes
- `apps/mobile`: Expo/React Native mobile client
- `apps/conclave-skip`: Skip.dev project for native clients
- `packages/sfu`: mediasoup SFU and real-time socket handlers
- `packages/apps-sdk`: in-meeting apps runtime SDK (registry, provider, Yjs sync, awareness, uploads)
- `packages/shared-browser`: optional VNC-based shared browser service

---

## Monorepo Layout

```text
apps/
  web/
  mobile/
packages/
  sfu/
  apps-sdk/
  shared-browser/
scripts/
```

Prerequisites:

- Node.js 20+
- `pnpm` 9+
- Docker (optional, for deploy scripts and shared browser runtime image)

---

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Start SFU:

```bash
pnpm -C packages/sfu run dev
```

3. Start web in another terminal:

```bash
pnpm -C apps/web run dev
```

4. Open `http://localhost:3000`.

Notes:

- Web defaults to `http://localhost:3031` SFU if `SFU_URL`/`NEXT_PUBLIC_SFU_URL` is unset.
- SFU has development defaults; production must set secrets and announced IPs.

---

## Mobile Development

`apps/mobile` is intentionally excluded from workspace lockstep due to native tooling constraints.

```bash
pnpm -C apps/mobile install
pnpm -C apps/mobile run start
```

Useful targets:

```bash
pnpm -C apps/mobile run ios
pnpm -C apps/mobile run android
```

---

## Apps SDK Docs

- package README: [`packages/apps-sdk/README.md`](./packages/apps-sdk/README.md)
- docs home: [`packages/apps-sdk/docs/README.md`](./packages/apps-sdk/docs/README.md)
- add app integration: [`packages/apps-sdk/docs/guides/add-a-new-app-integration.md`](./packages/apps-sdk/docs/guides/add-a-new-app-integration.md)
- app cookbook: [`packages/apps-sdk/docs/guides/app-cookbook.md`](./packages/apps-sdk/docs/guides/app-cookbook.md)
- troubleshooting: [`packages/apps-sdk/docs/guides/troubleshooting.md`](./packages/apps-sdk/docs/guides/troubleshooting.md)

Contributor commands:

```bash
pnpm -C packages/apps-sdk run new:app polls
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run check:apps:fix
```

---

## Optional Services

Run shared browser service locally:

```bash
pnpm -C packages/shared-browser run dev
```

Deploy SFU pair (Docker Compose):

```bash
./scripts/deploy-sfu.sh
```

Deploy shared browser service (Docker Compose):

```bash
./scripts/deploy-browser-service.sh
```

---

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a PR.

---

## Community & Conduct

By participating in this project, you agree to follow [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

---

<div align="center">

🤍 Crafted with love by <a href="https://acmvit.in/" target="_blank">ACM-VIT</a>

![Footer GIF](https://raw.githubusercontent.com/ACM-VIT/.github/master/profile/domains.gif)

</div>
