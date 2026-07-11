# Runtime APIs and Hooks

This page is the practical API reference for host and app contributors.

## App Definition

### `defineApp(app)`

Declares app metadata and validates shape early.

Required:

- `id`
- `name`
- `web` renderer

Optional:

- `description`
- `icon`
- `createDoc`

## Provider

### `AppsProvider`

Wraps meeting UI and provides app runtime context.

Props:

- `socket`: connected room socket (or `null`)
- `apps`: stable array of app definitions available in the host
- `user`: stable user identity object
- `isAdmin`: role flag used by app UI guard logic

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
- `apps`: app definitions supplied by the host
- `openApp(appId, options?) => Promise<boolean>`
- `closeApp() => Promise<boolean>`
- `setLocked(locked) => Promise<boolean>`
- `refreshState() => void`
- `getDoc(appId) => Y.Doc`
- `getAwareness(appId) => Awareness`
- `user`, `isAdmin`, `isReadOnly`

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

## Game Runtime APIs

Games use a server-authoritative runtime. The SDK exposes the client hook, but the SFU owns game rules, scoring, timers, and private projections.

### `GameProvider`

Wraps meeting UI that needs game controls or active game rendering.

Props:

- `socket`: connected room socket, or `null`
- `user`: current player identity, used as a fallback id until the server snapshot arrives
- `isAdmin`: role flag used for host-only game controls
- `isReadOnly`: observer mode; all game methods refuse locally and the UI should render read-only

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
- `isReadOnly`: observer mode flag
- `userId`: the current player id. This is the server-canonical `selfId` carried on game snapshots whenever available, falling back to the host-provided `user.id` before the first snapshot. Always match against this value when looking yourself up in `players`, scoreboards, or tile state; never rebuild the id client-side, because the server may normalize identity (lowercased email, token session id)
- `startGame(gameId, options?)`
- `endGame()`
- `move(type, payload?)`
- `openVote(candidateIds?)`
- `castVote(gameId)`
- `cancelVote()`
- `refresh()`

Ack behavior:

- methods resolve to `{ success: boolean, error?: string }`
- `startGame` uses a 45 second timeout because it may load generated content
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

Rematch: `game:start` replaces a session that has already finished, so calling `startGame(publicState.gameId, publicState.config)` from the results phase restarts the same game with the same settings. `publicState.config` carries the host-chosen settings for exactly this purpose.

### `move(type, payload?)`

Sends a player action to the active game:

```ts
await move("answer", { choice: 2 });
```

Client code should keep payloads small and simple. The server validates every move and can reject it with a user-facing error.

### Typed Moves: `createTypedMove<M>()`

Each game module exports a discriminated union of its legal moves, mirrored on the client. `createTypedMove` wraps the game-agnostic `move` so a renderer cannot send a misnamed move or a malformed payload without a compile error:

```ts
import { createTypedMove } from "@conclave/apps-sdk";
import type { TriviaMove } from "./moves";

const send = createTypedMove<TriviaMove>(move);
await send({ type: "answer", choice: 2 });
```

The wire payload is unchanged: the discriminant becomes the move type and the remaining fields become the payload. The server still decodes and validates every move independently.

### Tile Adornments

Games can light up the participant video tiles (state such as locked in, correct, eliminated, winner) and make tiles tappable during votes. The APIs are `registerTileResolver`, `registerTileAction`, `resolveTileAdornment`, and `resolveTileToneColor`. See [Tile Adornments](./tile-adornments.md) for the full contract.

### `publicState` and `view`

Use `publicState.view` for information everyone can see. Use `view` for the current player's private projection.

`publicState` also carries `gameId`, `name`, `phase`, `players` (the seats snapshotted at start), `hostId`, `finished`, `hasLeaderboard`, and `config` (the host-chosen settings, used by the rematch flow).

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

Use these helpers for sync-safe shared state:

- `createAppDoc(rootKey)`
- `getAppRoot(doc, rootKey)`
- `ensureAppMap(root, key)`
- `ensureAppArray(root, key)`
- `ensureAppText(root, key)`

Pattern:

```ts
const createChecklistDoc = () => createAppDoc("checklist");

const getItems = (doc: Y.Doc) => {
  const value = getAppRoot(doc, "checklist").get("items");
  return value instanceof Y.Array ? value.toArray() : [];
};

const addItem = (doc: Y.Doc, item: string) => {
  ensureAppArray(getAppRoot(doc, "checklist"), "items").push([item]);
};
```

`createAppDoc` intentionally has no initializer callback. A joining document
must remain empty until server sync; readers return non-mutating UI defaults,
and mutation helpers lazily create the shared types they write.

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
