# Repository Guidelines

## Project Structure & Module Organization
Conclave is a pnpm monorepo split by runtime surface:
- `apps/web`: Next.js web client (`src/app`, `src/lib`, static assets in `public/`).
- `apps/mobile`: Expo/React Native client (`src/app`, `src/features`, assets in `assets/`).
- `packages/sfu`: mediasoup SFU server and socket handlers.
- `packages/apps-sdk`: in-meeting apps runtime SDK.
- `packages/shared-browser`: optional VNC-based shared browser service.
- `scripts/`: deployment helpers (`deploy-sfu.sh`, `deploy-browser-service.sh`).

## Build, Test, and Development Commands
Use workspace-local commands (root has no global scripts):
- `pnpm -C apps/web run dev`: start web app on local dev server.
- `pnpm -C apps/web run build && pnpm -C apps/web run start`: production build + serve.
- `pnpm -C apps/web run lint`: run Next.js lint checks.
- `pnpm -C packages/sfu run dev`: run SFU with `tsx`.
- `pnpm -C packages/sfu run typecheck`: strict TS check for SFU.
- `pnpm -C packages/shared-browser run dev|build|typecheck`: shared-browser lifecycle.
- `pnpm -C apps/mobile install && pnpm -C apps/mobile run start`: mobile setup (managed separately from workspace lockstep).
- `pnpm -C packages/apps-sdk run check:apps` (or `check:apps:fix`): validate app integrations.

## Coding Style & Naming Conventions
- Language: TypeScript-first, ESM modules, `strict` compiler settings across packages.
- Match existing style: 2-space indentation, double quotes, trailing semicolons.
- React components/types: `PascalCase`; variables/functions: `camelCase`.
- Mobile feature files commonly use `kebab-case` (for example `use-meet-media.ts`, `meet-screen.tsx`).
- Keep imports path-aliased where configured (for example `@/` in web/mobile).

## Testing Guidelines
There is currently no committed unit/integration test runner (no Jest/Vitest specs in repo). For changes, treat these as required quality gates:
- run lint/typecheck for touched packages
- boot affected surfaces locally (web, SFU, mobile as applicable)
- include manual verification steps in PR description

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style (`feat:`, `fix:`, `chore:`; optional scopes like `feat/webinar:`). Keep commits focused and imperative.

PRs should include:
- concise summary of what changed and why
- impacted surfaces (`apps/web`, `apps/mobile`, `packages/sfu`, etc.)
- linked issue (`Fixes #123`) when applicable
- screenshots/video for UI changes
- notes on config/env updates and any follow-up work
