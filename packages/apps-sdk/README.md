# @conclave/apps-sdk

In-meeting app runtime SDK for Conclave (`web` + `native`).

This package gives you a shared runtime for collaborative meeting apps:

- app registry and discovery
- room-level app state (`activeAppId`, `locked`)
- Yjs doc sync and awareness sync over SFU socket events
- React provider + hooks for app and host UI
- optional cross-platform asset uploads

## Documentation

- Docs home: [docs/README.md](./docs/README.md)
- Core concepts: [docs/reference/core-concepts.md](./docs/reference/core-concepts.md)
- Runtime APIs: [docs/reference/runtime-apis.md](./docs/reference/runtime-apis.md)
- Permissions and locking: [docs/reference/permissions-and-locking.md](./docs/reference/permissions-and-locking.md)
- Socket events and sync protocol: [docs/reference/socket-events-and-sync.md](./docs/reference/socket-events-and-sync.md)
- Add an app: [docs/guides/add-a-new-app-integration.md](./docs/guides/add-a-new-app-integration.md)
- App cookbook: [docs/guides/app-cookbook.md](./docs/guides/app-cookbook.md)
- Troubleshooting: [docs/guides/troubleshooting.md](./docs/guides/troubleshooting.md)
- Contributing guide: [docs/guides/contributing-to-apps-sdk.md](./docs/guides/contributing-to-apps-sdk.md)
- Dev playground walkthrough: [docs/guides/dev-playground-walkthrough.md](./docs/guides/dev-playground-walkthrough.md)

## Who Should Use This Package

- App authors: building a collaborative meeting surface (polls, notes, timers, etc.)
- Host integrators: wiring app menu and layout into Conclave web/mobile meeting shells
- Reviewers/maintainers: validating permissions, sync behavior, and cross-platform wiring

## Quick Task Map

| If you need to... | Read this first |
| --- | --- |
| Understand how the runtime fits together | [Core concepts](./docs/reference/core-concepts.md) |
| Know what each hook/API does | [Runtime APIs](./docs/reference/runtime-apis.md) |
| Add a brand-new app integration | [Add a new app integration](./docs/guides/add-a-new-app-integration.md) |
| Start from a proven app shape | [App cookbook](./docs/guides/app-cookbook.md) |
| Debug sync or permission behavior | [Socket events and sync](./docs/reference/socket-events-and-sync.md) + [Troubleshooting](./docs/guides/troubleshooting.md) |
| Contribute safely and pass review quickly | [Contributing guide](./docs/guides/contributing-to-apps-sdk.md) |

## Runtime Architecture (Mental Model)

1. Host process registers app definitions with `registerApps(...)`.
2. `AppsProvider` bridges host UI and SFU socket events.
3. Each app gets one Yjs doc (`useAppDoc(appId)`) and one awareness instance.
4. SFU handlers enforce permissions and relay updates to room participants.
5. App UIs consume SDK hooks and render read/write or read-only states based on lock/admin state.

## What "App" Means Here

A Conclave app is a collaborative meeting surface with:

- stable `id` (used in registration, controls, and sync routing)
- human-readable `name`
- at least one renderer (`web` and/or `native`)
- optional Yjs doc initializer (`createDoc`)

Room app state is shared by everyone:

- `activeAppId`: currently open app id or `null`
- `locked`: when `true`, non-admin content updates are dropped by server

## Minimal Integration Example

```tsx
import {
  AppsProvider,
  createAssetUploadHandler,
  defineApp,
  registerApps,
} from "@conclave/apps-sdk";

const pollApp = defineApp({
  id: "polls",
  name: "Polls",
  web: PollsWebApp,
  native: PollsNativeApp,
});

registerApps([pollApp]);

const uploadAsset = createAssetUploadHandler({
  // defaults to POST /api/apps
  // set baseUrl for native/non-web hosts
  baseUrl: process.env.EXPO_PUBLIC_API_URL,
});

<AppsProvider socket={socket} user={user} isAdmin={isAdmin} uploadAsset={uploadAsset}>
  <MeetingUI />
</AppsProvider>;
```

## App Lifecycle (High-Level)

1. Define app with `defineApp(...)`.
2. Register app with `registerApps(...)`.
3. Admin opens app via `useApps().openApp(appId)`.
4. All clients receive `apps:state` with new `activeAppId`.
5. Provider syncs Yjs doc + awareness for active app.
6. App UI reads/writes doc with `useAppDoc(appId)`.
7. App UI shares ephemeral presence with `useAppPresence(appId)`.
8. Lock state controls write behavior (`locked && !isAdmin` => read-only).

Details: [docs/reference/socket-events-and-sync.md](./docs/reference/socket-events-and-sync.md)

## Data Placement Rules

- Put durable collaborative content in Yjs doc.
- Put ephemeral cursor/selection/presence in awareness.
- Put purely local UI state (open panels, hover state) in component state.

If data must survive reconnect/history, it should not live in awareness alone.

## Permission Model (Important)

- Admins can open/close/lock apps.
- Non-admins still receive state updates and sync updates.
- Under lock, non-admin Yjs content updates are ignored server-side.

App UIs should always guard writes:

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

Details: [docs/reference/permissions-and-locking.md](./docs/reference/permissions-and-locking.md)

## Contributor Workflow

Scaffold:

```bash
pnpm -C packages/apps-sdk run new:app polls
```

Dry run:

```bash
pnpm -C packages/apps-sdk run new:app polls --dry-run
```

Validate exports and mobile path aliases:

```bash
pnpm -C packages/apps-sdk run check:apps
```

Auto-fix wiring drift:

```bash
pnpm -C packages/apps-sdk run check:apps:fix
```

Full workflow: [docs/guides/contributing-to-apps-sdk.md](./docs/guides/contributing-to-apps-sdk.md)

## Built-In App Exports

- Whiteboard (web): `@conclave/apps-sdk/whiteboard/web`
- Whiteboard (native): `@conclave/apps-sdk/whiteboard/native`
- Whiteboard (core): `@conclave/apps-sdk/whiteboard/core`
- Dev playground (web): `@conclave/apps-sdk/dev-playground/web`
- Dev playground (core): `@conclave/apps-sdk/dev-playground/core`

## Development Playground

This repo includes a dev-only sample app for learning SDK patterns.

- App id: `dev-playground`
- Source: `packages/apps-sdk/src/apps/dev-playground`
- Walkthrough: [docs/guides/dev-playground-walkthrough.md](./docs/guides/dev-playground-walkthrough.md)

It demonstrates:

- `defineApp` + `createAppDoc`
- shared Yjs primitives (`Map`, `Text`, `Array`)
- presence via `useAppPresence`
- lock-aware editing behavior

## Common Pitfalls

- App id mismatch between definition, open call, and `useAppDoc`.
- App registered on web only (or native only) when both are expected.
- `AppsProvider` missing around components using SDK hooks.
- Missing mobile `tsconfig` aliases for new subpath exports.
- Durable state stored in awareness instead of Yjs doc.

## Next Reading

- [docs/reference/core-concepts.md](./docs/reference/core-concepts.md)
- [docs/reference/runtime-apis.md](./docs/reference/runtime-apis.md)
- [docs/reference/socket-events-and-sync.md](./docs/reference/socket-events-and-sync.md)
- [docs/guides/app-cookbook.md](./docs/guides/app-cookbook.md)
- [docs/guides/troubleshooting.md](./docs/guides/troubleshooting.md)
