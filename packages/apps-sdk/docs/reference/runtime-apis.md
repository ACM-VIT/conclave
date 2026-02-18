# Runtime APIs and Hooks

This page is the practical API reference for host and app contributors.

## Registry APIs

### `defineApp(app)`

Declares app metadata and validates shape early.

Required:

- `id`
- `name`
- at least one renderer (`web` or `native`)

Optional:

- `description`
- `icon`
- `createDoc`

### `registerApp(app): boolean`

Registers one app in the process-local registry.

- returns `true` when registry changed
- returns `false` when same app reference was already registered

### `registerApps(apps): number`

Registers multiple apps and returns count of changed entries.

Common host pattern:

```ts
useEffect(() => {
  registerApps([whiteboardApp, pollsApp]);
}, []);
```

### `getRegisteredApps()`, `getAppById(appId)`

Read-only helpers for registry consumers.

### `clearRegisteredApps()`

Clears registry map and notifies subscribers. Useful for test isolation.

## Provider

### `AppsProvider`

Wraps meeting UI and provides app runtime context.

Props:

- `socket`: connected room socket (or `null`)
- `user`: stable user identity object
- `isAdmin`: role flag used by app UI guard logic
- `uploadAsset` (optional): created via `createAssetUploadHandler`

Provider responsibilities:

- create doc/awareness lazily per app id
- relay Yjs and awareness events over socket
- hold room app state (`activeAppId`, `locked`)
- expose control methods and runtime metadata through context

If provider is missing, SDK hooks throw immediately.

## Core Hooks

### `useApps()`

Returns the full runtime context:

- `state`: `{ activeAppId: string | null, locked: boolean }`
- `apps`: current registered app definitions
- `openApp(appId, options?) => Promise<boolean>`
- `closeApp() => Promise<boolean>`
- `setLocked(locked) => Promise<boolean>`
- `refreshState() => void`
- `getDoc(appId) => Y.Doc`
- `getAwareness(appId) => Awareness`
- `user`, `isAdmin`, `uploadAsset`

Ack behavior:

- control methods resolve `false` if socket is unavailable or ack times out
- current timeout is 8 seconds in provider implementation

### `useAppDoc(appId)`

Returns:

- `doc`: Yjs document for app id
- `awareness`: awareness instance for app id
- `isActive`: `state.activeAppId === appId`
- `locked`: global lock state

Use this as the default app entry hook.

### `useAppPresence(appId)`

Returns:

- `awareness`
- `states`: parsed snapshot of awareness states
- `setLocalState(state)`

Designed for ephemeral presence:

- cursor
- selection
- participant metadata

### `useRegisteredApps(platform?)`

Returns registered apps, optionally filtered by `platform`, plus derived fields:

- `isActive`
- `supportsWeb`
- `supportsNative`

### `useAppAssets()`

Returns:

- `uploadAsset(input)`

If provider has no upload handler, calling `uploadAsset` throws with a clear runtime error.

## Doc Helpers

Use these helpers for predictable schema setup:

- `createAppDoc(rootKey, initializer?)`
- `getAppRoot(doc, rootKey)`
- `ensureAppMap(root, key)`
- `ensureAppArray(root, key)`
- `ensureAppText(root, key)`

Pattern:

```ts
const createChecklistDoc = () =>
  createAppDoc("checklist", (root) => {
    ensureAppArray(root, "items");
    ensureAppMap(root, "meta");
  });
```

## Asset Upload Helper

### `createAssetUploadHandler(options?)`

Creates a cross-platform upload function that accepts:

- browser `File`
- browser `Blob`
- native asset object `{ uri, name, type? }`

Options:

- `endpoint` (default `/api/apps`)
- `baseUrl`
- `fetchImpl`
- `formFieldName` (default `"file"`)
- `headers`
- `mapError`

For native/non-web hosts, set `baseUrl` so relative endpoint resolves correctly.

## Usage Guidelines

- Use `useAppDoc` for content, `useAppPresence` for ephemeral state.
- Keep app id consistent across app definition, controls, and hooks.
- Always gate write mutations using lock/admin state.
- Avoid calling control methods before socket connect.

## Related Docs

- [Core Concepts](./core-concepts.md)
- [Permissions and Locking](./permissions-and-locking.md)
- [Socket Events and Sync](./socket-events-and-sync.md)
- [Troubleshooting](../guides/troubleshooting.md)
- [Add a New App Integration](../guides/add-a-new-app-integration.md)
