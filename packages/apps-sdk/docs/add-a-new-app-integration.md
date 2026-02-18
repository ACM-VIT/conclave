# Add a New App Integration

This guide shows how to add a new in-meeting app to the Conclave Apps SDK integration (web + native), using the current whiteboard wiring as the reference pattern.

## What "integration" means in this repo

You need to wire the app in five places:

1. `@conclave/apps-sdk`: define the app and its CRDT doc model.
2. Web host (`apps/web`): register app + render UI + expose uploads (optional).
3. Native host (`apps/mobile`): register app + render UI.
4. Meeting controls/layouts: open, close, and lock the app via `useApps()`.
5. SFU socket handlers (`packages/sfu`): already generic, usually no per-app code needed.

## 1. Add app files in `packages/apps-sdk`

Follow the same structure whiteboard uses:

```text
packages/apps-sdk/src/apps/polls/
  core/
    doc/
      index.ts
  web/
    components/PollsWebApp.tsx
    index.ts
  native/
    components/PollsNativeApp.tsx
    index.ts
```

Create a Yjs doc factory in `core/doc/index.ts`:

```ts
import * as Y from "yjs";

export const createPollsDoc = () => {
  const doc = new Y.Doc();
  const root = doc.getMap("polls");
  if (!root.has("items")) {
    root.set("items", new Y.Array());
  }
  return doc;
};
```

Define app entries (web and native) with the same `id`:

```ts
// packages/apps-sdk/src/apps/polls/web/index.ts
import { defineApp } from "../../../sdk/registry/index";
import { createPollsDoc } from "../core/doc/index";
import { PollsWebApp } from "./components/PollsWebApp";

export const pollsApp = defineApp({
  id: "polls",
  name: "Polls",
  description: "Live polls",
  createDoc: createPollsDoc,
  web: PollsWebApp,
});

export { PollsWebApp };
```

```ts
// packages/apps-sdk/src/apps/polls/native/index.ts
import { defineApp } from "../../../sdk/registry/index";
import { createPollsDoc } from "../core/doc/index";
import { PollsNativeApp } from "./components/PollsNativeApp";

export const pollsApp = defineApp({
  id: "polls",
  name: "Polls",
  description: "Live polls",
  createDoc: createPollsDoc,
  native: PollsNativeApp,
});

export { PollsNativeApp };
```

Inside app UIs, use SDK hooks:

- `useAppDoc(appId)` for `doc`, `awareness`, and `locked`.
- `useAppPresence(appId)` for participant presence/cursors.
- `useAppAssets()` for uploads when needed.

## 2. Export new subpaths from the package

Update `packages/apps-sdk/package.json`:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./polls/web": "./src/apps/polls/web/index.ts",
    "./polls/native": "./src/apps/polls/native/index.ts",
    "./polls/core": "./src/apps/polls/core/index.ts"
  }
}
```

If you add a `core/index.ts`, export your doc/model APIs there.

## 3. Register app in web and mobile hosts

Web: `apps/web/src/app/meets-client.tsx`

```ts
import { registerApps } from "@conclave/apps-sdk";
import { pollsApp } from "@conclave/apps-sdk/polls/web";

useEffect(() => {
  registerApps([pollsApp]);
}, []);
```

Mobile: `apps/mobile/src/features/meets/components/meet-screen.tsx`

```ts
import { registerApps } from "@conclave/apps-sdk";
import { pollsApp } from "@conclave/apps-sdk/polls/native";

useEffect(() => {
  registerApps([pollsApp]);
}, []);
```

For Expo TypeScript path resolution, add explicit aliases in `apps/mobile/tsconfig.json` (same pattern as whiteboard):

```json
{
  "compilerOptions": {
    "paths": {
      "@conclave/apps-sdk/polls/native": [
        "../../packages/apps-sdk/src/apps/polls/native/index.ts"
      ],
      "@conclave/apps-sdk/polls/web": [
        "../../packages/apps-sdk/src/apps/polls/web/index.ts"
      ],
      "@conclave/apps-sdk/polls/core": [
        "../../packages/apps-sdk/src/apps/polls/core/index.ts"
      ]
    }
  }
}
```

## 4. Keep `AppsProvider` wrapping meeting UI

Both web and mobile already do this. Keep it in place and ensure these props are set:

- `socket`: connected room socket.
- `user`: stable user identity.
- `isAdmin`: used for lock/open permissions.
- `uploadAsset`: from `createAssetUploadHandler(...)` if your app uploads files.

Without `AppsProvider`, `useApps()` and app hooks will throw.

## 5. Add controls to open/close/lock the app

In meeting UI components (web/mobile), wire through `useApps()`:

```ts
const { state, openApp, closeApp, setLocked } = useApps();
const isPollsActive = state.activeAppId === "polls";

const togglePolls = () => (isPollsActive ? closeApp() : openApp("polls"));
const toggleAppLock = () => setLocked(!state.locked);
```

Use the same app id (`"polls"`) everywhere.

## 6. Render app when active

Add your app layout/component where active app rendering is decided:

- Web meeting content/layout components.
- Native call screen/settings flow.

Pattern:

```ts
if (appsState.activeAppId === "polls") {
  return <PollsWebApp />; // or <PollsNativeApp />
}
```

## 7. Optional: asset uploads

If your app uploads files:

1. Pass `uploadAsset={createAssetUploadHandler(...)}` into `AppsProvider`.
2. Use `const { uploadAsset } = useAppAssets()` in app UI.
3. Ensure upload endpoints exist.

Web host already has the default endpoints:

- `POST /api/apps` (`apps/web/src/app/api/apps/route.ts`)
- `GET /api/apps/[id]` (`apps/web/src/app/api/apps/[id]/route.ts`)

For native/non-web hosts, pass `baseUrl` to `createAssetUploadHandler`.

## 8. Server-side requirements

No app-specific SFU handler is typically required. The handlers in `packages/sfu/server/socket/handlers/appsHandlers.ts` already route by dynamic `appId`.

Keep `registerAppsHandlers(context)` wired in `packages/sfu/server/socket/registerConnectionHandlers.ts`.

## 9. Verification checklist

1. Admin can open and close the new app on web and mobile.
2. Non-admin cannot open/close/lock but receives state updates.
3. Yjs document changes replicate across clients.
4. Awareness/presence updates show correctly.
5. Lock mode prevents edits for non-admins.
6. Reconnect preserves current app state (`refreshState` + sync path).
7. Asset upload path works (if used).

## Common pitfalls

- App id mismatch between registration, open call, and `useAppDoc`.
- Forgetting mobile TS path aliases for new package subpaths.
- Using `useApps`/`useAppDoc` outside `AppsProvider`.
- Registering app only on one platform and expecting it on both.
