# Permissions and Locking

This page explains who can do what in app runtime state.

## Role Model

At runtime, app controls are role-based:

- admins can open/close apps
- admins can enable/disable lock mode
- non-admins receive state and sync updates

## Capability Matrix

| Capability | Admin | Non-admin unlocked | Non-admin locked |
| --- | --- | --- | --- |
| Open app | yes | no | no |
| Close app | yes | no | no |
| Toggle lock | yes | no | no |
| Read app state | yes | yes | yes |
| Receive Yjs updates | yes | yes | yes |
| Send Yjs content updates | yes | yes | no (dropped server-side) |
| Send awareness updates | yes | yes | yes |

## Operations

### `openApp(appId)`

- Intended admin action.
- Server-side handlers reject non-admin attempts.
- Sets room app state `activeAppId`.

### `closeApp()`

- Intended admin action.
- Server-side handlers reject non-admin attempts.
- Clears active app and resets lock.

### `setLocked(true | false)`

- Intended admin action.
- Server-side handlers reject non-admin attempts.
- Broadcasts lock state to all participants.

Note: lock state is room-global for apps runtime, not per-user.

## Sync Behavior Under Lock

When locked:

- awareness traffic (presence/cursor) can still flow
- non-admin Yjs content updates are dropped by server
- admin updates continue

Because of that, app UIs should:

- disable editing controls for non-admin users while locked
- still show live state/presence updates
- avoid optimistic local writes that imply success

## Close Behavior and Lock Reset

When `closeApp()` succeeds, server resets:

- `activeAppId` to `null`
- `locked` to `false`

This prevents stale lock state from carrying into the next opened app.

## Host UI Responsibilities

Host meeting controls should:

- expose open/close/lock controls only for admins
- show lock state to all users
- use `refreshState()` after join/reconnect

## App UI Responsibilities

App components should:

- treat `locked && !isAdmin` as read-only mode
- avoid local optimistic mutations when in read-only mode
- keep ephemeral UI state local (panels, drafts, temporary selections)

Reference guard:

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

## Common Failure Modes

- UI shows edit controls while lock blocks writes server-side.
- App lets non-admin users trigger open/close controls.
- App ignores reconnect state and assumes lock is unchanged.

For symptom-first fixes, see [Troubleshooting](../guides/troubleshooting.md).

## Related Docs

- [Core Concepts](./core-concepts.md)
- [Runtime APIs and Hooks](./runtime-apis.md)
- [Socket Events and Sync](./socket-events-and-sync.md)
- [Troubleshooting](../guides/troubleshooting.md)
- [Contributing To Apps SDK](../guides/contributing-to-apps-sdk.md)
