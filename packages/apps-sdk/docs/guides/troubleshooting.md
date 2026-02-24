# Troubleshooting

Use this guide when an app integration does not behave as expected.

The fastest workflow is:

1. identify the symptom below
2. validate the likely root cause
3. apply the listed fix
4. run `pnpm -C packages/apps-sdk run check:apps`

## Symptom: App does not show in app menu

Likely causes:

- app not registered in host
- app was registered only on one platform
- dev-only app gated behind environment checks

Fix:

1. verify `registerApps([...])` includes your app in host entrypoint
2. verify the correct subpath import (`/<id>/web` or `/<id>/native`)
3. on web, check `NODE_ENV` conditions if app is intentionally dev-only

## Symptom: `openApp("my-app")` returns `false`

Likely causes:

- app id is not registered
- user is not admin
- socket not connected
- server ack timeout (8 seconds)

Fix:

1. confirm app id matches definition exactly
2. confirm caller has admin privileges
3. check socket lifecycle and reconnect status
4. inspect server logs for `apps:open` rejection reasons

## Symptom: Hooks throw `must be used within AppsProvider`

Likely causes:

- component moved outside provider boundary
- provider not mounted in a specific route/layout path

Fix:

1. ensure `AppsProvider` wraps all components using:
   - `useApps`
   - `useAppDoc`
   - `useAppPresence`
   - `useAppAssets`
2. verify platform-specific trees (web + native) both include provider wiring

## Symptom: Yjs updates not syncing across participants

Likely causes:

- wrong `appId` in `useAppDoc(appId)`
- app is not active in room state
- update payload is malformed
- non-admin writes blocked by lock

Fix:

1. verify all ids match (`defineApp`, `openApp`, `useAppDoc`)
2. confirm `state.activeAppId` is your app
3. verify lock state and role
4. check socket events:
   - `apps:yjs:sync`
   - `apps:yjs:update`

Reference: [Socket Events and Sync](../reference/socket-events-and-sync.md)

## Symptom: Awareness/presence missing or stale

Likely causes:

- app is not active
- local awareness never set
- presence data stored under unexpected shape

Fix:

1. ensure app is active before expecting awareness relay
2. call `setLocalState(...)` in app code
3. validate shape expected by `useAppPresence` parser:
   - `user`
   - `cursor`
   - `selection`

## Symptom: Non-admin edits "do nothing"

Likely causes:

- room app state is locked
- UI permits edits but server drops non-admin updates

Fix:

1. inspect `state.locked` in host/app
2. guard mutations in UI:

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

3. keep read-only affordances visible so behavior is explicit

Reference: [Permissions and Locking](../reference/permissions-and-locking.md)

## Symptom: New app import fails on mobile

Likely causes:

- missing Expo TypeScript path aliases
- stale package exports

Fix:

1. run:

```bash
pnpm -C packages/apps-sdk run check:apps
```

2. if failing, auto-fix:

```bash
pnpm -C packages/apps-sdk run check:apps:fix
```

3. verify `apps/mobile/tsconfig.json` contains `@conclave/apps-sdk/<id>/*` entries

## Symptom: Asset uploads fail

Likely causes:

- `uploadAsset` not provided to `AppsProvider`
- missing/incorrect API endpoint
- missing `baseUrl` for native/non-web host

Fix:

1. pass `uploadAsset={createAssetUploadHandler(...)}`
2. verify default web endpoint exists (`POST /api/apps`)
3. for native, provide `baseUrl` and confirm endpoint reachability

## Symptom: State is stale after reconnect

Likely causes:

- missing `refreshState()` call path
- sync not triggered for active app after reconnect

Fix:

1. ensure provider is mounted and socket listeners are active
2. ensure reconnect path triggers state refresh
3. confirm active app sync occurs after state recovery

## Fast Verification Commands

```bash
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run check:apps:fix
```

## Related Docs

- [Core Concepts](../reference/core-concepts.md)
- [Runtime APIs and Hooks](../reference/runtime-apis.md)
- [Permissions and Locking](../reference/permissions-and-locking.md)
- [Socket Events and Sync](../reference/socket-events-and-sync.md)
- [Add a New App Integration](./add-a-new-app-integration.md)
