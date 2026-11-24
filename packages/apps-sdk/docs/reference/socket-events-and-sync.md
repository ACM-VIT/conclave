# Socket Events and Sync

This reference explains the runtime event contract between `AppsProvider` and SFU apps handlers.

Use this page when debugging:

- app open/close/lock behavior
- missing sync updates
- stale app state after reconnect
- awareness or presence inconsistencies

## Event Direction Overview

| Event | Direction | Ack | Purpose |
| --- | --- | --- | --- |
| `apps:getState` | client -> server | yes | fetch current `AppsState` |
| `apps:state` | server -> room | no | broadcast room app state changes |
| `apps:open` | client -> server | yes | present an app on the stage (admin-only) |
| `apps:close` | client -> server | yes | take the presented app off the stage and unlock (admin-only) |
| `apps:discard` | client -> server | yes | destroy an app's document (admin-only) |
| `apps:lock` | client -> server | yes | set lock flag (admin-only) |
| `apps:yjs:sync` | client -> server | yes | request state diff for active app |
| `apps:yjs:update` | bi-directional | no | relay Yjs content updates |
| `apps:yjs:refused` | server -> client | no | tell a writer the room refused its update |
| `apps:awareness` | bi-directional | no | relay awareness/presence updates |

## State and Control Flow

### `apps:getState`

- Emitted by provider via `refreshState()`.
- Server callback returns `AppsState`:
  `{ activeAppId, locked, revision, savedAppIds, docGeneration, roomId }`.
- Used on initial mount and reconnect paths.

`revision` moves forward with every change to this state. `docGeneration`
names the presented app's document: a new number means the room started that
app over, so a client drops its local copy and resyncs even when `activeAppId`
did not change. It is `null` when nothing is presented. An older SFU sends no
`revision`, `savedAppIds` or `docGeneration`; it destroys an app's document
when the app leaves the stage, and has no `apps:discard`.

### Document lifetime

The room keeps each app's document when the app leaves the stage, so
presenting it again shows the same content. Only `apps:discard` and room
teardown destroy a document; an app nobody wrote to is not kept. A room keeps
at most eight documents and 4 MiB of them, on top of the 256 KiB update and
1 MiB document limits.

Only the presented app is live: `apps:yjs:sync`, `apps:yjs:update` and
`apps:awareness` for any other app are refused or dropped. Clients drop their
local copy of an app that leaves the stage and resync from the server when it
returns.

Yjs client ids are chosen by clients, so the SFU binds each one to the
participant who first writes under it, and to the app it writes in. An id is
bound only in the same step that applies the write; a refused write, for any
reason, binds nothing. It
refuses that id from anyone else and in any other app, so bytes copied from
one app never land in another. A participant who rejoins keeps their ids. A
viewer that only syncs binds nothing. One update may bring at most 8 new ids
and a participant may hold 1024; there is no shared room-wide pool, so no
participant's ids can stop another from writing.

Presence only holds an id while the room shows a cursor under it. An id first
shown in presence is held for that participant until its cursor is removed,
times out after 30 s, the participant leaves or the app leaves the stage, and
a participant may hold at most 4 this way; a presence packet that would leave
them holding more is refused. An entry the room ignores, such as one whose
clock is not newer than the room's, holds nothing, and the room forwards only
the entries it applies. Writing under a held id makes it the participant's for
good.

For each connection the room remembers the clocks of its 16 most recently
removed cursors, so a late entry for one of them is still ignored, and forgets
them when that connection leaves. An entry for an id it no longer remembers is
taken as a new cursor.

A socket's `apps:yjs:update` is taken only once the room has answered its
`apps:yjs:sync` for the presented document. That holds across Close and
Present of the same document, so an update still in flight when the host
closes and presents it again is kept. An update from a socket that has not
synced the presented document, as an older client that draws before its sync
reply arrives sends, is dropped. If it changes nothing, as the empty update an
older client opens a copy with, the room sends that socket its copy of the
document as an `apps:yjs:update`. After that the room drops an update
that:

- sets a map key that already held a value when the socket synced, or when
  the document's current stay on the stage began, without having seen that
  value: a client drawing on a fresh copy writes its own page under the
  saved page's key, which would replace it for everyone
- refers to content the room does not hold, such as content it dropped, so
  nothing that builds on a dropped update is kept half applied. An item may
  refer to its own client's content only when that content comes earlier, and
  to another client's content only when the room already holds it, so Yjs
  always takes an update whole and never leaves part of it applied

A refused update always makes its writer start its copy over, so no client is
left drawing on a copy the room no longer matches. A client that sends a
`replicaId` is told with `apps:yjs:refused`. Any other client, such as an
older web or native build, gets an `apps:state` without an `activeAppId` and,
half a second later, the room's current state: every client drops its copy of
an app that leaves the stage and syncs a fresh one when it returns. This
happens once until that socket syncs again, and never for an update that
changes nothing.

A socket's updates are taken at up to 30 a second. Updates that arrive faster
are held, in order, and applied together as one write as soon as the budget
allows, and always before that socket's next sync or stage command, so a
stroke drawn at pointer speed is never cut in two. Only an update that would
take a socket's held updates past 256 KiB is refused, as `rate-limited`.

A cleared document stays cleared. The SFU remembers, per app, the Yjs clients
that wrote to it and drops any later `apps:yjs:update` for that app from those
clients or that holds, builds on or deletes their content, as a client that
missed the clear would send on resync. It keeps these records until the
room closes; every writer is a bound id of that one app, so they never
outnumber the room's ids. With ids bound to their writers, a participant is
only ever blocked by their own writes, or by a host clearing a document they
wrote.

A refused stage command acks `{ success: false, error, code }`. `code` is
`"stale_revision"` when the stage changed first, and `"room_full"` when the
room keeps as many documents as it can, so a host clears one before presenting
another.

### `apps:open`

Client payload:

```ts
{
  appId: string;
  expectedRevision?: number;
}
```

Server behavior:

1. reject non-admins
2. succeed without change when `appId` is already presented
3. reject with code `stale_revision` when `expectedRevision` is sent and is
   not the current revision
4. reject with code `room_full` when the room has no space for a new document
5. remove the outgoing app's awareness and keep its document
6. set `activeAppId`, set `locked = false`, create the app's document if
   needed, on a new `docGeneration`
7. broadcast `apps:state`
8. ack `{ success: true, activeAppId, revision }`

### `apps:close`

Client payload: either only the ack (older clients), or
`{ expectedRevision: number }` followed by the ack.

Server behavior:

1. reject non-admins
2. succeed without change when nothing is presented
3. reject a stale `expectedRevision`
4. remove the presented app's awareness and keep its document
5. set `activeAppId = null`
6. set `locked = false`
7. broadcast `apps:state`
8. ack `{ success: true, revision }`

### `apps:discard`

Client payload:

```ts
{
  appId: string;
  expectedRevision?: number;
}
```

Server behavior:

1. reject non-admins
2. succeed without change when the room keeps no document for `appId`
3. reject a stale `expectedRevision`
4. close the stage first when `appId` is presented
5. destroy the document and remember its writers, so their content cannot
   come back
6. broadcast `apps:state`
7. ack `{ success: true, revision }`

### `apps:lock`

Client payload:

```ts
{ locked: boolean; expectedRevision?: number }
```

Server behavior:

1. reject non-admins
2. succeed without change when `locked` already matches
3. reject a stale `expectedRevision`
4. update `locked`
5. broadcast `apps:state`
6. ack `{ success: true, locked }`

Present, close, discard and lock share one rate limit per socket.

`apps:yjs:sync` has its own per-socket limit, but a socket's first sync of the
presented app after each stage change is free. Every stage change makes each
client sync once, so other hosts switching apps cannot use up a viewer's
budget; repeated syncs of the same stage still spend it. A sync refused by the
limit acks `{ error, retryable: true, retryAfterMs }`, and the client tries
again after at least `retryAfterMs`. An older SFU sends that refusal as only
`{ error: "Too many app sync requests" }`; the client retries it with its own
backoff. Any other refusal acks `{ error }` and is final.

## Sync Flow

`AppsProvider` syncs when an app becomes active:

1. encode local state vector (`Y.encodeStateVector(doc)`)
2. emit `apps:yjs:sync`
3. apply returned `syncMessage` as remote update
4. apply returned awareness snapshot (if present)
5. compare server `stateVector` and push missing local changes using `apps:yjs:update`

Server rejects sync requests if:

- client is not in a room
- `appId` is missing
- requested `appId` is not currently active
- `syncMessage` is invalid

## Yjs Update Flow

Client -> server (`apps:yjs:update`):

- emitted for local doc changes
- ignored if app is not active
- ignored for non-admins when room is locked
- ignored until the socket has synced the presented document, and when it
  replaces a value it never saw or builds on content the room does not hold
  (see Document lifetime)
- held and applied together when a socket sends faster than its budget

Server -> peers (`apps:yjs:update`):

- relayed to everyone else in room
- receiver applies update with origin `"remote"`

Server -> writer (`apps:yjs:refused`):

- sent when the room refuses an update that carried a `replicaId`, once per
  `replicaId`: `{ appId, replicaId, reason }`
- `reason` is one of `rate-limited`, `not-live`, `locked`, `invalid`,
  `too-large`, `not-synced`, `malformed`, `unresolved`, `unseen-value`,
  `cleared`, `foreign-id` or `id-limit`
- `AppsProvider` sends a `replicaId` for each local copy; on a refusal for its
  current copy it drops that copy, syncs a fresh one and sets `rejectedChange`

## Awareness Flow

Client -> server (`apps:awareness`):

- emitted on local awareness changes
- includes optional `clientId`
- not blocked by lock mode

Clients send only their own awareness entry. A client that sees a peer's
entry time out does not forward that removal; the peer's own client, or the
server when the peer leaves, removes it.

Server -> peers (`apps:awareness`):

- relayed to everyone else in room for active app
- the server decodes every entry and relays only the sender's own: entries
  under ids bound to the sender, or under new ids it can bind to them
- removals of other participants' entries are dropped silently; an update
  that carries state under another participant's id, or that does not decode,
  is dropped whole
- receiver applies awareness update with origin `"remote"`

## Game Events

Games use a separate, server-authoritative contract handled by `GameProvider`. The SFU owns canonical state; clients only ever receive projections.

| Event | Direction | Ack | Purpose |
| --- | --- | --- | --- |
| `game:list` | client -> server | yes | fetch the game catalog (options, player bounds, leaderboard flag) |
| `game:start` | client -> server | yes | host starts a game with validated config; also replaces a finished session (rematch) |
| `game:move` | client -> server | yes | send a player move; the server decodes and validates it |
| `game:end` | client -> server | yes | host ends the game early |
| `game:getState` | client -> server | yes | full snapshot: public state, your private view, active vote, and `selfId` |
| `game:state` | server -> room | no | public projection broadcast on every change |
| `game:view` | server -> player | no | private per-player projection (the hidden-information boundary) |
| `game:snapshot` | server -> client | no | targeted join/reconnect snapshot, same shape as `game:getState` |
| `game:ended` | server -> room | no | the game was cleared |
| `game:vote:open` | client -> server | yes | host opens a vote on which game to play |
| `game:vote:cast` | client -> server | yes | player votes for a candidate game |
| `game:vote:cancel` | client -> server | yes | host cancels the vote |
| `game:vote` | server -> room | no | live vote state broadcast |

Notes:

- Snapshots and `game:getState` include `selfId`, the caller's canonical player id. `GameProvider` prefers it over any locally built identity, and `useGame().userId` returns it. Match yourself against this value everywhere.
- The public projection (`game:state`) carries `config`, the host-chosen settings, so a results screen can restart the same game with the same options.
- Private views are only ever emitted to the owning socket. Nothing secret rides `game:state`.

## Payload Encoding Rules

Runtime accepts multiple binary-like payload forms:

- `Uint8Array`
- `ArrayBuffer`
- typed array views
- `number[]`
- Node-style `{ type: "Buffer", data: number[] }`
- base64 string (validated before decode)

This keeps sync stable across browser, native, and server runtimes.

## Client Ack Timeout Behavior

`AppsProvider` uses an 8 second timeout for ack-based calls:

- `presentApp(...)`
- `closeApp()`
- `clearApp(...)`
- `setLocked(...)`

If no ack is received in time, those methods resolve `{ ok: false, reason: "failed" }`.

## Debug Checklist

1. Confirm app is registered on the host process before calling `presentApp`.
2. Confirm `AppsProvider` wraps the UI where hooks are used.
3. Confirm `state.activeAppId` matches the app id used in `useAppDoc(appId)`.
4. Confirm app is active before expecting `apps:yjs:sync` or update flow.
5. Confirm lock state if non-admin updates appear to be ignored.
6. Confirm room socket is connected during the mutation.
7. Confirm server handlers are wired via `registerAppsHandlers(context)`.

## Related Docs

- [Core Concepts](./core-concepts.md)
- [Runtime APIs and Hooks](./runtime-apis.md)
- [Permissions and Locking](./permissions-and-locking.md)
- [Troubleshooting](../guides/troubleshooting.md)
