# Contributing to Conclave

This guide defines how to contribute safely and efficiently to the Conclave monorepo.

## Scope

This repository includes:

- web client (`apps/web`)
- mobile client (`apps/mobile`)
- SFU service (`packages/sfu`)
- in-meeting apps runtime SDK (`packages/apps-sdk`)
- optional shared browser service (`packages/shared-browser`)

## Getting Started

1. Fork the repository.
2. Clone your fork.
3. Create a feature branch.
4. Install dependencies:

```bash
pnpm install
```

Mobile has separate install flow:

```bash
pnpm -C apps/mobile install
```

## Development Commands

Web:

```bash
pnpm -C apps/web run dev
```

SFU:

```bash
pnpm -C packages/sfu run dev
```

Mobile:

```bash
pnpm -C apps/mobile run start
```

Shared browser service (optional):

```bash
pnpm -C packages/shared-browser run dev
```

## Apps SDK Contributions

If your PR touches in-meeting apps or app runtime behavior, use the Apps SDK docs first:

- docs home: [`packages/apps-sdk/docs/README.md`](./packages/apps-sdk/docs/README.md)
- integration guide: [`packages/apps-sdk/docs/guides/add-a-new-app-integration.md`](./packages/apps-sdk/docs/guides/add-a-new-app-integration.md)
- contributor workflow: [`packages/apps-sdk/docs/guides/contributing-to-apps-sdk.md`](./packages/apps-sdk/docs/guides/contributing-to-apps-sdk.md)
- troubleshooting: [`packages/apps-sdk/docs/guides/troubleshooting.md`](./packages/apps-sdk/docs/guides/troubleshooting.md)

Useful commands:

```bash
pnpm -C packages/apps-sdk run new:app <id>
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run check:apps:fix
```

## Pull Request Guidelines

- Keep PRs focused and scoped.
- Explain what changed, why, and impacted surfaces (web/mobile/sfu/apps-sdk).
- Link related issues (`Fixes #<id>` when applicable).
- Include screenshots/video for meaningful UI changes.
- Update docs when behavior, workflows, or public APIs change.

## Quality Expectations

Before requesting review:

- verify changed apps/services start and run in your local environment
- run relevant checks for touched packages
- avoid unrelated refactors in the same PR
- call out known limitations or follow-up work explicitly

## Opening Issues

For bugs, include:

- reproduction steps
- expected behavior vs actual behavior
- environment details (OS, browser/device, versions)
- logs or screenshots when relevant

For feature requests, include:

- user problem
- proposed solution
- alternatives considered
- expected UX impact

Security issues should not be disclosed publicly. Report privately via the project contact in [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Community Standards

Participation implies agreement with [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
