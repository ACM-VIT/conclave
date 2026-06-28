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

## Game Runtime APIs

Games use a server-authoritative runtime. The SDK exposes the client hook, but the SFU owns game rules, scoring, timers, and private projections.

### `GameProvider`

Wraps meeting UI that needs game controls or active game rendering.

Props:

- `socket`: connected room socket, or `null`
- `user`: current player identity
- `isAdmin`: role flag used for host-only game controls

Provider responsibilities:

- request the game catalog with `game:list`
- subscribe to `game:state`, `game:view`, `game:snapshot`, `game:vote`, and `game:ended`
- keep the active public game state in React context
- keep the current player's private view in React context
- expose methods that send acked game socket events

### `useGame()`

Returns the game runtime context:

- `catalog`: available games from the SFU
- `publicState`: room-wide public game state, or `null`
- `view`: private view for the current player, or `null`
- `vote`: active game vote, or `null`
- `isActive`: `true` when a game is running
- `isAdmin`: current role flag
- `userId`: current player id
- `startGame(gameId, options?)`
- `endGame()`
- `move(type, payload?)`
- `openVote(candidateIds?)`
- `castVote(gameId)`
- `cancelVote()`
- `refresh()`

Ack behavior:

- methods resolve to `{ success: boolean, error?: string }`
- `startGame` uses a 30 second timeout because it may load generated content
- other methods use an 8 second timeout in the provider implementation
- `move` returns an error when no game is active

### `startGame(gameId, options?)`

Starts a game by id. Only admins can start games.

`options` is a `GameConfig` object keyed by option id:

```ts
await startGame("trivia", {
  questions: 10,
  pace: "normal",
});
```

The SFU validates options against the selected game module. Unknown keys are ignored. Invalid values fall back to defaults or are clamped to the allowed range.

### `move(type, payload?)`

Sends a player action to the active game:

```ts
await move("answer", { choice: 2 });
```

Client code should keep payloads small and simple. The server validates every move and can reject it with a user-facing error.

### `publicState` and `view`

Use `publicState.view` for information everyone can see. Use `view` for the current player's private projection.

Do not assume both arrive in the same tick. Render loading or waiting states when `publicState` exists but `view` is still `null`.

### Game Catalog Types

Each `catalog` entry includes:

- `id`
- `name`
- `description`
- `minPlayers`
- `maxPlayers`
- `options`
- `hasLeaderboard`

`options` drives the host setup UI in the games launcher.

Option specs can be:

- `number`: bounded integer, usually rendered as preset chips
- `select`: one value from a fixed choice list
- `text`: short host input such as a topic for generated questions

Generated-content games use the same `startGame(gameId, options?)` path. The client sends ordinary config, then the SFU loads and validates generated content before creating the server-authoritative session.

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
- Use `useGame` for server-authoritative games where the server must own rules or hidden information.

## Related Docs

- [Core Concepts](./core-concepts.md)
- [Permissions and Locking](./permissions-and-locking.md)
- [Socket Events and Sync](./socket-events-and-sync.md)
- [Troubleshooting](../guides/troubleshooting.md)
- [Add a New App Integration](../guides/add-a-new-app-integration.md)
- [Add a Game to Conclave](../guides/add-a-game.md)
