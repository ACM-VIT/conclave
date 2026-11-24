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
- `documents`: `{ version, doc(appId), awareness(appId), writeOnce(appId, key, write) }`
- `syncStatus`, `retrySync()`, `isRebuilding`, `rejectedChangeAt`, `rejectedChangeReason`
- `user`, `isAdmin`, `isReadOnly`

`documents.version` changes whenever the provider replaces a document (a refused
change is rebuilt from the server), and hosts remount the app on that change.

### Uploads and refusals

Every change an app makes reaches the server through one paced upload path:
`AppsProvider` on the web, and the native embed session on iOS and Android.

- Uploads leave at most `APP_DOCUMENT_UPLOADS_PER_SECOND` times a second (20),
  two thirds of the rate the server refills its per-socket budget at. Both read
  `APP_DOCUMENT_UPDATE_BUDGET` from `@conclave/apps-sdk/limits`, so a client
  that only uses this path is never refused for its rate.
- Nothing local becomes an upload before the app's first sync reply has been
  merged in. Until then `isRebuilding` is true and the meeting shows the app
  read-only, so a late joiner cannot draw over a saved board it has not loaded
  yet. Native embeds refuse edits until their first snapshot the same way.
- Changes made between uploads wait and leave together in the next one, at
  most `APP_DOCUMENT_UPLOAD_LIST_MAX` (64) changes and
  `APP_DOCUMENT_UPDATE_MAX_BYTES` in all. Nothing is dropped. To an SFU whose
  sync reply says `takesUpdateLists: true` they go as a list of the changes
  themselves (`updates: [...]`), never merged: the SFU applies them one at a
  time in order, so each change is kept or refused on its own and a change that
  fits is never refused together with one that does not, whatever the document
  size. No size estimate is involved. An older SFU gets them merged into one
  update, as before, and the native embed merges too, because the native bridge
  carries one update at a time.
- While the socket is down, changes wait and leave as one upload when it
  connects.
- Every change is all or nothing on the server. An update bigger than that
  cap, such as one large paste or a resend after many edits piled up during a
  catch-up, goes out as numbered parts of one change (`part: { id, index,
  count }`): plain byte ranges of the encoded update, never re-encoded Yjs
  structs. The SFU stages the parts, joins them back into the original update
  when the last arrives, and applies that update once, checking the document
  limit for the whole change, so it keeps all of it or none of it.
- A staging refusal (`interrupted`: a part the SFU cannot place) is never final.
  The provider resends the whole change from a fresh sync and keeps its copy.
  When the same socket reconnects, the provider holds every upload until the
  `apps:state` the SFU pushes once the socket has rejoined its meeting. If the
  same app is still open, it runs that fresh sync before it sends anything else,
  and the live copy with its unsent edits is kept. An `apps:getState` answer
  that says `notInRoom` is ignored, so an answer from before the rejoin never
  closes the app or drops local work.
- Receivers take changes up to the document limit. The provider and native
  clients say so with `wholeChanges: true` in their sync request, and any web
  client takes them anyway. A native client that never said so (build 63) gets
  the app state with no app and then the real state on its own socket instead
  of a change over 256 KiB, so it reloads the app from the server.
- The provider sends parts only to an SFU whose sync reply says
  `stagesParts: true`. An older SFU gets the change whole and refuses it as too
  large, never half of it. The native embed does not split yet, because the
  native bridge does not carry parts: a change over the cap there is not sent.
- Nothing else sends app updates. `apps/web/test/app-upload-path.test.ts` fails
  when code in the SDK, the web app or meeting core emits `apps:yjs:update`, or
  the native embed posts an update, outside the queue.
- An SFU that says `takesUpdateLists: true` acknowledges every upload once it
  is done with it, after any refusal for it. Until then the queue keeps what it
  sent: at most `APP_DOCUMENT_UPLOAD_LIST_MAX` changes and
  `APP_DOCUMENT_UPDATE_MAX_BYTES`, except a single change in parts, which may
  fill it alone. That log is also its send window, so nothing more goes out
  while it is full.
- A refusal for a passing reason (`rate-limited`, `timed-out`, `queue-full`,
  `missing-dependency` and the like) keeps the live copy. The provider syncs
  with the server under a fresh copy id and then resends, as a list, each change
  from the log, the queue and the sync itself that the server lacks, so near the
  document limit a change that fits still lands on its own. Only when those
  changes do not cover what the server lacks (state that never went through the
  queue) does it send one diff of everything the server lacks instead.
- A refusal because the document is full, locked or invalid, or a fourth passing
  refusal within 30 seconds, rebuilds the copy from the server. Anything built on
  the refused change goes with it, because the server can never accept it, and
  the host shows the reason.

Make each logical change in one transaction (`doc.transact`), so the server keeps
all of it or none of it: a replace that deletes and inserts, an action that
updates two maps, a pointer event. The same test file below fails when a
function in any app can make more than one separate change on one path.

### `documents.writeOnce(appId, key, write)`

The only way for an app to change its document without a user action: from a
timer, an effect, a promise, a media event, or code that runs on mount.

- `write(doc)` runs against the live copy, after its first sync, and only while
  the participant may write. While a rebuild is pending it waits and then runs on
  the replacement.
- Each `key` runs once per app activation. Use a key that names the change, such
  as `result:<spinId>`.
- Everything `write` changes goes out as one update, so the server keeps all of
  it or none of it.
- If the copy it ran on is refused, the provider checks the replacement. When
  the server already has the change, it is done. Otherwise it runs again on the
  replacement, at most three times in all, unless the refusal was because the
  document is full, locked or invalid, which is final.
- `write` must re-check, on the copy it is given, the state it was decided
  against (the same play, the same spin not yet recorded), because it can run
  after that state has moved on.

A test in `apps/web/test/app-automatic-writes.test.ts` fails when an app writes
its document anywhere else outside a user event handler.

`writeOnce` changes ride the same uploads. After a passing refusal they are sent
again as they were, not run again, since the live copy still holds them; the
rules above about running again apply after a rebuild.

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
- Write only from user event handlers or through `documents.writeOnce`.
- Make each logical change in one `doc.transact`.
- Avoid calling control methods before socket connect.
- Use `useGame` for server-authoritative games where the server must own rules or hidden information.

## Related Docs

- [Core Concepts](./core-concepts.md)
- [Permissions and Locking](./permissions-and-locking.md)
- [Socket Events and Sync](./socket-events-and-sync.md)
- [Troubleshooting](../guides/troubleshooting.md)
- [Add a New App Integration](../guides/add-a-new-app-integration.md)
- [Add a Game to Conclave](../guides/add-a-game.md)
