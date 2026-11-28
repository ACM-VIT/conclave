# @conclave/apps-sdk

Runtime SDK for Conclave's in-meeting web apps and server-authoritative games: app registry, room app state (`activeAppId`, `locked`), Yjs document and awareness sync over SFU sockets, authority contracts, and React hooks.

## Choose Your Runtime

| | Collaborative (Yjs doc) | Authority | Games |
| --- | --- | --- | --- |
| State lives | Every client + SFU relay | SFU only | SFU only |
| Writes | Any unlocked editor | Actions validated by SFU rules | Moves validated by SFU rules |
| Reads | Everyone sees full doc | Per-connection projection | Per-player private view |
| Best for | Strokes, notes, shared playback, wheel | Polls, Q&A, draws, one-per-person rules | Turn-based or hidden-info games |
| Start with | `new:app <id>` | `new:app <id> --runtime authority` | `pnpm -C packages/sfu run new:game` |

Where state belongs:

- Rules participants must not bypass or hidden state: authority app or game.
- Collaborative content that must survive reconnect: Yjs doc (`useAppDoc`).
- Ephemeral cursors or selections: awareness (`useAppPresence`).
- Local UI toggles: React component state.

## Minimal Collaborative App

```tsx
import { AppsProvider, defineApp } from "@conclave/apps-sdk";

const timerApp = defineApp({
  id: "timer",
  name: "Timer",
  web: TimerWebApp,
});

<AppsProvider apps={[timerApp]} socket={socket} user={user} isAdmin={isAdmin}>
  <MeetingUI />
</AppsProvider>;
```

When an admin calls `useApps().presentApp(appId)`, the SFU broadcasts `apps:state` with the new `activeAppId`, `AppsProvider` syncs the Yjs doc and awareness, and the app UI reads and writes via `useAppDoc(appId)` and `useAppPresence(appId)`.

### Permissions and Locking

Admins open, close, and lock apps. Under lock (`locked && !isAdmin`), the SFU drops non-admin Yjs updates. Guard writes in the UI too:

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

## Authority Apps and Games

- **Authority apps** define a contract in `core`, rules in `server` (loaded only by the SFU), and a panel in `web` that reads state with `useAuthority(contract)`. See [Build an Authority App](./docs/guides/build-an-authority-app.md) and [Authority Runtime](./docs/reference/authority-runtime.md).
- **Games** use the Apps SDK game hooks with SFU-owned rules, timers, scoring, and private views. Prompt-based games can generate schema-checked setup content through `@conclave/ai` (default model `gpt-6-luna`). See [Add a Game](./docs/guides/add-a-game.md).

## Commands

```bash
pnpm -C packages/apps-sdk run new:app timer                     # scaffold a collaborative app
pnpm -C packages/apps-sdk run new:app sign-up --runtime authority # scaffold an authority app
pnpm -C packages/apps-sdk run new:app timer --dry-run           # preview without writing
pnpm -C packages/apps-sdk run check:apps                        # validate structure and exports
pnpm -C packages/apps-sdk run check:apps:fix                    # auto-fix wiring drift
pnpm -C packages/apps-sdk run typecheck                         # tsc --noEmit
```

## Built-In Exports

- Core SDK: `@conclave/apps-sdk`, `@conclave/apps-sdk/authority`, `@conclave/apps-sdk/authority/server`, `@conclave/apps-sdk/limits`, `@conclave/apps-sdk/native-embed`
- Collaborative apps: `whiteboard` (`/core`, `/document`, `/web`), `watch` (`/core`, `/web`), `wheel` (`/core`, `/web`), `dev-playground` (`/core`, `/web`)
- Authority apps: `polls` (`/core`, `/server`, `/web`), `qa` (`/core`, `/server`, `/web`)

`dev-playground` (`packages/apps-sdk/src/apps/dev-playground`) is a dev-only sample app showing `defineApp`, `createAppDoc`, Yjs primitives, `useAppPresence`, and lock handling.

## Documentation Map

Full index: [`docs/README.md`](./docs/README.md).

| Goal | Doc |
| --- | --- |
| Understand architecture and lifecycle | [Core concepts](./docs/reference/core-concepts.md) |
| Look up hooks and helpers | [Runtime APIs](./docs/reference/runtime-apis.md) |
| Add a collaborative app | [Add a new app integration](./docs/guides/add-a-new-app-integration.md) |
| Add an authority app | [Build an authority app](./docs/guides/build-an-authority-app.md) + [Authority runtime](./docs/reference/authority-runtime.md) |
| Add a server-authoritative game | [Add a game](./docs/guides/add-a-game.md) |
| Copy a proven schema/UI shape | [App cookbook](./docs/guides/app-cookbook.md) |
| Walk through `dev-playground` | [Dev playground walkthrough](./docs/guides/dev-playground-walkthrough.md) |
| Debug permissions, locks, or sync | [Permissions and locking](./docs/reference/permissions-and-locking.md), [Socket events and sync](./docs/reference/socket-events-and-sync.md), [Troubleshooting](./docs/guides/troubleshooting.md) |
| Contributing rules and checklist | [Contributing guide](./docs/guides/contributing-to-apps-sdk.md) |

## Common Pitfalls

- Mismatched `appId` across `defineApp`, `presentApp`, and `useAppDoc`.
- Calling SDK hooks outside `AppsProvider`.
- Forgetting subpath exports in `packages/apps-sdk/package.json` (caught by `check:apps`).
- Storing durable state in awareness instead of the Yjs doc or an authority store.
