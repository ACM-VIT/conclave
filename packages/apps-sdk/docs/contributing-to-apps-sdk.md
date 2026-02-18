# Contributing To Apps SDK

This doc is the fastest path for adding and shipping new in-meeting apps in Conclave.

## Who this is for

- Contributors adding a brand-new app integration.
- Contributors improving existing app implementations.
- Reviewers validating app wiring and permissions.

## 1. Scaffold a new app

Run from repo root:

```bash
pnpm -C packages/apps-sdk run new:app polls
```

Common options:

- `--name "Polls"` sets display name.
- `--description "Live polls"` sets app description.
- `--no-native` or `--no-web` generates one platform only.
- `--dry-run` previews file changes.

What this command updates:

1. Creates app files under `packages/apps-sdk/src/apps/<id>/...`
2. Adds exports in `packages/apps-sdk/package.json`
3. Adds explicit Expo path aliases in `apps/mobile/tsconfig.json`

## 2. Register app in meeting hosts

Register in both hosts (if supported):

- `apps/web/src/app/meets-client.tsx`
- `apps/mobile/src/features/meets/components/meet-screen.tsx`

Pattern:

```ts
registerApps([whiteboardApp, pollsApp]);
```

## 3. Wire app controls and rendering

Use `useApps()` in meeting UI components:

- open/close: `openApp("polls")` and `closeApp()`
- lock: `setLocked(...)` for admin-only edit lock

Render app when active:

```ts
const isPollsActive = appsState.activeAppId === "polls";
```

## 4. App data guidelines

1. Keep shared state in app Yjs doc (`createDoc` + helpers).
2. Keep transient local UI state in React state.
3. Use awareness for presence/cursor/selection, not durable data.
4. Respect `locked` mode for non-admin users.

## 5. Permission model reminders

The SFU Apps handlers already enforce admin-only operations for:

- `apps:open`
- `apps:close`
- `apps:lock`

Non-admin clients should still receive state and sync updates.

## 6. PR checklist

1. App opens/closes on web.
2. App opens/closes on mobile (if native renderer exists).
3. Non-admin cannot open/close/lock.
4. `locked` blocks edits for non-admin users.
5. Yjs updates replicate across clients.
6. Reconnect and `refreshState()` behave correctly.
7. `pnpm -C packages/apps-sdk run check:apps` passes.
8. Added docs/screenshots for major UX changes.

Tip: if exports/path aliases drift, run:

```bash
pnpm -C packages/apps-sdk run check:apps:fix
```

## Related docs

- `packages/apps-sdk/docs/add-a-new-app-integration.md`
