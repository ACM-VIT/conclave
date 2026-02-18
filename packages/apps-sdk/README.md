# @conclave/apps-sdk

Conclave in-meeting app SDK (shared web + native).

## Guides

- [Add a New App Integration](./docs/add-a-new-app-integration.md)
- [Contributing To Apps SDK](./docs/contributing-to-apps-sdk.md)

## Quick Start

```tsx
import {
  AppsProvider,
  createAssetUploadHandler,
  defineApp,
  registerApps,
} from "@conclave/apps-sdk";

const pollApp = defineApp({
  id: "poll",
  name: "Poll",
  web: PollWeb,
  native: PollNative,
});

registerApps([pollApp]);

const uploadAsset = createAssetUploadHandler({
  // endpoint defaults to "/api/apps"
  // baseUrl is optional for non-web hosts
  baseUrl: process.env.EXPO_PUBLIC_API_URL,
});

<AppsProvider socket={socket} user={user} isAdmin={isAdmin} uploadAsset={uploadAsset}>
  <MeetingUI />
</AppsProvider>;
```

## Contributor DX

Scaffold a new app shell (core + web + native + exports + mobile aliases):

```bash
pnpm -C packages/apps-sdk run new:app polls
```

Preview changes only:

```bash
pnpm -C packages/apps-sdk run new:app polls --dry-run
```

Validate app wiring (exports + mobile aliases):

```bash
pnpm -C packages/apps-sdk run check:apps
```

Auto-fix JSON wiring drift:

```bash
pnpm -C packages/apps-sdk run check:apps:fix
```

## Core Concepts

- `defineApp(app)`
  - Validates app shape at registration time.
  - Requires `id`, `name`, and at least one renderer (`web` or `native`).

- `registerApps(apps)` / `registerApp(app)`
  - Adds apps to the runtime registry.
  - Safe to call repeatedly from mount effects.

- `useApps()`
  - Runtime state + controls (`openApp`, `closeApp`, `setLocked`, `refreshState`).

- `useAppDoc(appId)`
  - Returns `{ doc, awareness, isActive, locked }` for Yjs + presence.

- `useRegisteredApps(platform?)`
  - Returns registered apps with runtime metadata:
  - `isActive`, `supportsWeb`, `supportsNative`.

- `createAssetUploadHandler(options)`
  - Cross-platform file upload helper for app assets.
  - Supports `File`, `Blob`, and native `{ uri, name, type }` inputs.
  - Defaults to `POST /api/apps` with no config.

- `createAppDoc(rootKey, initializer?)`
  - Small helper to initialize app Yjs docs consistently.
  - Combine with `getAppRoot`, `ensureAppMap`, `ensureAppArray`, `ensureAppText`.

## Whiteboard Export Paths

- Web app entry: `@conclave/apps-sdk/whiteboard/web`
- Native app entry: `@conclave/apps-sdk/whiteboard/native`
- Core model/tools: `@conclave/apps-sdk/whiteboard/core`

## Patterns For New Apps

- Keep app-specific Yjs schema initialization in `createDoc`.
- Keep local-only ephemeral UX state in React state, not Yjs.
- Use awareness for cursor/selection/presence only.
- Treat lock as a read-only mode for non-admin users.
- Use `uploadAsset` from context instead of wiring ad hoc uploads per app.
