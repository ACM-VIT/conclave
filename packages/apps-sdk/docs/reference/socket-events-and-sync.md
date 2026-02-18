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
| `apps:getState` | client -> server | yes | fetch current `{ activeAppId, locked }` |
| `apps:state` | server -> room | no | broadcast room app state changes |
| `apps:open` | client -> server | yes | set active app id (admin-only) |
| `apps:close` | client -> server | yes | clear active app and unlock (admin-only) |
| `apps:lock` | client -> server | yes | set lock flag (admin-only) |
| `apps:yjs:sync` | client -> server | yes | request state diff for active app |
| `apps:yjs:update` | bi-directional | no | relay Yjs content updates |
| `apps:awareness` | bi-directional | no | relay awareness/presence updates |

## State and Control Flow

### `apps:getState`

- Emitted by provider via `refreshState()`.
- Server callback returns `AppsState`.
- Used on initial mount and reconnect paths.

### `apps:open`

Client payload:

```ts
{
  appId: string;
  options?: Record<string, unknown>;
}
```

Server behavior:

1. reject non-admins
2. set `activeAppId`
3. create app doc/awareness if needed
4. broadcast `apps:state`
5. ack `{ success: true, activeAppId }`

### `apps:close`

Server behavior:

1. reject non-admins
2. clear active app awareness
3. set `activeAppId = null`
4. set `locked = false`
5. broadcast `apps:state`
6. ack `{ success: true }`

### `apps:lock`

Client payload:

```ts
{ locked: boolean }
```

Server behavior:

1. reject non-admins
2. update `locked`
3. broadcast `apps:state`
4. ack `{ success: true, locked }`

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

Server -> peers (`apps:yjs:update`):

- relayed to everyone else in room
- receiver applies update with origin `"remote"`

## Awareness Flow

Client -> server (`apps:awareness`):

- emitted on local awareness changes
- includes optional `clientId`
- not blocked by lock mode

Server -> peers (`apps:awareness`):

- relayed to everyone else in room for active app
- receiver applies awareness update with origin `"remote"`

## Payload Encoding Rules

Runtime accepts multiple binary-like payload forms:

- `Uint8Array`
- `ArrayBuffer`
- typed array views
- `number[]`
- Node-style `{ type: "Buffer", data: number[] }`
- base64 string (validated before decode)

This helps keep sync stable across browser, React Native, and server runtimes.

## Client Ack Timeout Behavior

`AppsProvider` uses an 8 second timeout for ack-based calls:

- `openApp(...)`
- `closeApp()`
- `setLocked(...)`

If no ack is received in time, those methods resolve `false`.

## Debug Checklist

1. Confirm app is registered on the host process before calling `openApp`.
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
