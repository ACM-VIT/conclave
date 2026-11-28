# Contributing to Conclave

## Setup

1. Fork and clone the repository, then create a feature branch.
2. Install Node.js `>=22.22.0` and `pnpm` `12.16.1`.
3. Install dependencies:

```bash
pnpm install
```

Older Corepack and pnpm shims cannot launch pnpm 12's native executable. If your `pnpm` binary fails, install it with `npx get-pnpm 12.16.1` or invoke it via `npm exec --yes --package=pnpm@12.16.1 -- pnpm`.

### Toolchain Notes

- Type checking uses TypeScript 7 through the `@typescript/native` alias. The `typescript` alias keeps TypeScript 6 available for ESLint until ESLint supports the native compiler API. Keep both aliases when upgrading dependencies.
- Conclave enforces a no-comments policy behind a ratchet (`pnpm run lint:comments`). When a choice needs explanation, write an ADR in [`docs/adr/`](./docs/adr/README.md) instead of a code comment.
- Android native builds require JDK 21 and Android SDK Platform 37 (for OkHttp 5.5). Google Sign-In uses Android Credential Manager with the existing web OAuth client ID.

## Running Services Locally

Web client:

```bash
pnpm -C apps/web run dev
```

SFU media server:

```bash
pnpm -C packages/sfu run dev
```

Native iOS/Android package:

```bash
swift build --package-path apps/conclave-skip
swift test --package-path apps/conclave-skip
```

Optional shared browser service:

```bash
pnpm -C packages/shared-browser run dev
```

## Verification Gates

Run the root gate before requesting review:

```bash
pnpm check
```

While iterating on a single surface, run its local checks:

- Web: `pnpm -C apps/web run lint`, `pnpm -C apps/web run typecheck`, `pnpm -C apps/web run test`
- SFU: `pnpm -C packages/sfu run typecheck`, `pnpm -C packages/sfu run test`
- Apps SDK: `pnpm -C packages/apps-sdk run typecheck`, `pnpm -C packages/apps-sdk run check:apps`
- Shared browser: `pnpm -C packages/shared-browser run typecheck`, `pnpm -C packages/shared-browser run test`
- Native: `swift build --package-path apps/conclave-skip && swift test --package-path apps/conclave-skip` (plus Android/iOS builds from [`apps/conclave-skip/README.md`](./apps/conclave-skip/README.md) when touching platform code)

## Apps SDK Changes

If your change adds an in-meeting app, game, or runtime capability, read these first:

- Docs home: [`packages/apps-sdk/docs/README.md`](./packages/apps-sdk/docs/README.md)
- New collaborative app: [`packages/apps-sdk/docs/guides/add-a-new-app-integration.md`](./packages/apps-sdk/docs/guides/add-a-new-app-integration.md)
- New authority app: [`packages/apps-sdk/docs/guides/build-an-authority-app.md`](./packages/apps-sdk/docs/guides/build-an-authority-app.md)
- New server-authoritative game: [`packages/apps-sdk/docs/guides/add-a-game.md`](./packages/apps-sdk/docs/guides/add-a-game.md)
- Contributor checklist: [`packages/apps-sdk/docs/guides/contributing-to-apps-sdk.md`](./packages/apps-sdk/docs/guides/contributing-to-apps-sdk.md)
- Troubleshooting: [`packages/apps-sdk/docs/guides/troubleshooting.md`](./packages/apps-sdk/docs/guides/troubleshooting.md)

Scaffold and validation commands:

```bash
pnpm -C packages/apps-sdk run new:app <id>
pnpm -C packages/apps-sdk run new:app <id> --runtime authority
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run check:apps:fix
```

## Pull Requests

- Keep changes scoped to one problem. Avoid unrelated refactors in the same PR.
- Follow Conventional Commit titles (`feat:`, `fix:`, `chore:`, with optional scopes).
- State what changed, why, which surfaces are affected, and how you verified it locally.
- Link issues with `Fixes #<id>` when applicable.
- Attach screenshots or short recordings for UI changes.
- Update docs when commands, environment variables, workflows, or public APIs change.
- Call out known limitations or follow-up work explicitly.

## Issues and Security

- **Bugs:** include reproduction steps, expected vs actual behavior, OS/browser/device versions, and relevant logs or screenshots.
- **Feature requests:** describe the user problem, proposed behavior, alternatives considered, and expected UX impact.
- **Security:** do not disclose vulnerabilities publicly. Report them privately through the contact in [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

Participation is governed by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
