# Apps SDK Troubleshooting

## App is missing or does not render

1. Run `pnpm -C packages/apps-sdk run check:apps`.
2. Confirm the app definition has the same `id` used by `openApp` and
   `useAppDoc`.
3. Confirm its package export exists and the definition is in the stable
   `MEETING_APPS` array in `apps/web/src/app/meets-client.tsx`.
4. Confirm `AppsProvider` wraps the meeting UI and receives that array.

## Hook says the provider is missing

`useApps`, `useAppDoc`, and `useAppPresence` must run below `AppsProvider`.
Game hooks must also run below `GameProvider`.

## App opens but state does not sync

Check the browser and SFU logs for:

- `apps:state`
- `apps:yjs:sync`
- `apps:yjs:update`
- `apps:awareness`

Then verify that the socket is connected, the active app id matches, and the
document is created through the definition's `createDoc` function. Do not
create a second unrelated `Y.Doc` inside the renderer.

## Changes disappear after reconnect

Durable content must live in the Yjs document. Awareness is intentionally
ephemeral. Keep `createDoc` factories empty, return UI defaults from read
helpers without mutating Yjs, and create shared maps, arrays, and text only from
real write paths. Then verify that the client requests a fresh sync after
reconnect.

## Locked users can still edit locally

The SFU rejects unauthorized updates, but the UI should prevent misleading
local edits too:

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

Test with separate admin and non-admin participants.

## Controls time out

`openApp`, `closeApp`, and `setLocked` return `false` when the socket is absent,
the user is read-only, or the acknowledgement does not arrive within eight
seconds. Inspect the matching SFU handler and permission check rather than
retrying indefinitely.

## Game state or identity looks wrong

Use the server-provided `selfId` from game snapshots. Do not rebuild identity
from email or session data on the client. Inspect public state, private view,
and spectator/read-only mode separately.

## Final checks

```bash
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run typecheck
pnpm -C apps/web run typecheck
pnpm -C apps/web run lint
pnpm -C packages/sfu run typecheck
pnpm -C packages/sfu test
```
