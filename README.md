<div align="center">

![Forktober GIF](https://raw.githubusercontent.com/ACM-VIT/.github/master/profile/acm_gif_banner.gif)

<h2>Conclave</h2>

<p>Real-time meetings platform with web and native clients, an SFU, and an apps SDK</p>

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
- `apps/conclave-skip`: active SwiftUI/Skip project for iOS and Android
- `packages/sfu`: mediasoup SFU and real-time socket handlers
- `packages/apps-sdk`: web in-meeting apps runtime (provider, Yjs sync, and awareness)
- `packages/shared-browser`: optional VNC-based shared browser service

---

## Monorepo Layout

```text
apps/
  web/
  conclave-skip/
packages/
  sfu/
  apps-sdk/
  shared-browser/
scripts/
```

Prerequisites:

- Node.js 20+
- `pnpm` 11.7.0
- Swift and Xcode for native development
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

- Web defaults to `https://sfu.acmvit.in` if `SFU_URL`/`NEXT_PUBLIC_SFU_URL` is unset.
- SFU has development defaults; production must set secrets and announced IPs.

---

## Mobile Development

The active native application is `apps/conclave-skip`. It shares SwiftUI source
between iOS and Android through Skip.

```bash
cd apps/conclave-skip
swift build
swift test -q
```

See [`apps/conclave-skip/README.md`](./apps/conclave-skip/README.md) for Android
and iOS build commands.

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

Before every SFU or shared browser deploy, build and boot both root-context images locally. This is a required pre-deploy step:

```bash
pnpm check:docker-images
```

It needs a local Docker daemon.

- It runs `pnpm check:docker-context` first, then builds `packages/sfu/Dockerfile` and `packages/shared-browser/Dockerfile` from the repository root and boots each one.
- Each container must return a complete 200 response on `/health` over HTTP from inside the container, and the SFU must also import `@conclave/apps-sdk` there, all within one 120 s deadline. Each probe stops itself inside the container before that deadline.
- The shared browser gets a random `BROWSER_SERVICE_TOKEN`, binds `127.0.0.1`, and gets the session browser image built from `packages/shared-browser/docker` (as `scripts/deploy-browser-service.sh` builds it) as `BROWSER_IMAGE_NAME`.
- It resolves Docker's effective endpoint the way the CLI does: `DOCKER_HOST` first, otherwise `DOCKER_CONTEXT` or the current context. It refuses that endpoint unless it is a local `unix://` socket.
- It runs every later Docker call pinned to that endpoint, with every `DOCKER_*` and `BUILDX_*` variable removed except `DOCKER_CONFIG` and `BUILDX_CONFIG`, which only locate configuration (credentials, proxies, buildx state). It builds only with the `default` buildx builder, and refuses unless that is the docker driver on the checked endpoint.
- It never pushes. It gives each run a random container name and tag. It makes each container with `docker create` and a random owner label chosen before the command runs, then runs it with `docker start`. It removes only the containers that carry those labels, by the ids `docker ps` lists for them, and the tags it created. Each cleanup command has a time limit and each cleanup pass a total budget. If it cannot confirm that something it created is gone after the final pass, it prints what is left and fails. A name conflict therefore never removes another container, and a container created just as the run is interrupted is still removed.
- Ctrl-C or SIGTERM is passed on to the running Docker command, including a build in progress, which is killed if it has not stopped 15 s later. No later step runs, the run's containers and tags are removed within the cleanup budget, and it exits 130 or 143.
- Supported setups: OrbStack, Docker Desktop and Colima, which run the daemon in a VM and get `/var/run/docker.sock` (the socket inside that VM) mounted into the shared browser container. Also a native Linux engine, rootless included, which gets the resolved socket path mounted. `BROWSER_DOCKER_SOCKET` overrides the mounted path, as with `docker-compose.browser.yml`.
- Pass `--no-cache` for a cold build.
- `pnpm check:docker-context` reads Dockerfiles with a deliberately small grammar: plain ASCII, no parser directives, no heredocs, a fixed list of instructions, and COPY words made only of plain path characters. Anything else fails with `unsupported Dockerfile syntax on line N`; extend `scripts/docker-context` or rewrite the Dockerfile. The real build in `pnpm check:docker-images` is the authority on build behaviour.

Do not deploy if it fails.

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
