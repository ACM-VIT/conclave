# Repository Guidelines

## Project Structure & Module Organization
Conclave is a pnpm monorepo split by runtime surface:
- `apps/web`: Next.js web client (`src/app`, `src/lib`, static assets in `public/`).
- `apps/conclave-skip`: active native Swift/Skip application. Make native changes here.
- `apps/mobile`: deprecated Expo client. Do not modify it.
- `packages/sfu`: mediasoup SFU server and socket handlers.
- `packages/apps-sdk`: in-meeting apps runtime SDK.
- `packages/shared-browser`: optional VNC-based shared browser service.
- `scripts/`: deployment helpers (`deploy-sfu.sh`, `deploy-browser-service.sh`).

## Build, Test, and Development Commands
Use the root quality gates for repository-wide checks and workspace-local commands while developing:
- `pnpm check`: run lint, consistency checks, typechecks, tests, integration checks, and generated-file validation.
- `pnpm build`: build the production web and server surfaces.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`: run the corresponding repository-wide checks.
- `pnpm -C apps/web run dev`: start web app on local dev server.
- `pnpm -C apps/web run build && pnpm -C apps/web run start`: production build + serve.
- `pnpm -C apps/web run lint`: run Next.js lint checks.
- `pnpm -C packages/sfu run dev`: run SFU with `tsx`.
- `pnpm -C packages/sfu run typecheck`: strict TS check for SFU.
- `pnpm -C packages/shared-browser run dev|build|typecheck`: shared-browser lifecycle.
- `swift build --package-path apps/conclave-skip` and `swift test --package-path apps/conclave-skip`: build and test the active native app.
- `pnpm -C packages/apps-sdk run check:apps` (or `check:apps:fix`): validate app integrations.

## Coding Style & Naming Conventions
- Language: TypeScript-first, ESM modules, `strict` compiler settings across packages.
- Match existing style: 2-space indentation, double quotes, trailing semicolons.
- React components/types: `PascalCase`; variables/functions: `camelCase`.
- Match the existing Swift and Kotlin conventions in `apps/conclave-skip`.
- Keep imports path-aliased where configured (for example `@/` in web).

## Testing Guidelines
Vitest suites cover the web, meeting core, and SFU packages. For changes, treat these as required quality gates:
- run `pnpm check` or the lint, typecheck, and test commands for every touched package
- boot affected surfaces locally (web, SFU, native app as applicable)
- include manual verification steps in PR description

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style (`feat:`, `fix:`, `chore:`; optional scopes like `feat/webinar:`). Keep commits focused and imperative.

PRs should include:
- concise summary of what changed and why
- impacted surfaces (`apps/web`, `apps/conclave-skip`, `packages/sfu`, etc.)
- linked issue (`Fixes #123`) when applicable
- screenshots/video for UI changes
- notes on config/env updates and any follow-up work
