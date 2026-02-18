# Contributing To Apps SDK

This doc is the fastest path for adding and shipping new in-meeting apps in Conclave.

## Who this is for

- Contributors adding a brand-new app integration.
- Contributors improving existing app implementations.
- Reviewers validating app wiring and permissions.

## Contribution standards

Changes should preserve three guarantees:

1. cross-client convergence for Yjs content
2. clear admin/non-admin permission boundaries
3. consistent behavior on web and native hosts (when both renderers exist)

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

If you are modifying an existing app, still run `check:apps` before and after to detect registry/export drift.

## 2. Register app in meeting hosts

Register in both hosts (if supported):

- `apps/web/src/app/meets-client.tsx`
- `apps/mobile/src/features/meets/components/meet-screen.tsx`

Pattern:

```ts
registerApps([whiteboardApp, pollsApp]);
```

Host examples in this repo:

- web: `apps/web/src/app/meets-client.tsx`
- native: `apps/mobile/src/features/meets/components/meet-screen.tsx`

## 3. Wire app controls and rendering

Use `useApps()` in meeting UI components:

- open/close: `openApp("polls")` and `closeApp()`
- lock: `setLocked(...)` for admin-only edit lock

Render app when active:

```ts
const isPollsActive = appsState.activeAppId === "polls";
```

Admin-only controls should stay explicit in the UI. Non-admin users should still see active app and lock status.

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

Lock behavior reminder: non-admin Yjs content updates are dropped while awareness can still flow.

## 6. Review checklist for app changes

1. App id is stable and consistent across definition, controls, and hooks.
2. App opens/closes on web.
3. App opens/closes on mobile (if native renderer exists).
4. Non-admin cannot open/close/lock.
5. `locked` blocks non-admin edits while still showing updates.
6. Yjs updates replicate across clients and converge.
7. Reconnect and `refreshState()` behave correctly.
8. `pnpm -C packages/apps-sdk run check:apps` passes.
9. Docs are updated for new behavior and edge cases.

## 7. PR checklist

1. Include test notes in PR description (who tested what, on which host).
2. Include screenshots/video for material UI changes.
3. Include migration notes if exports, ids, or schema shape changed.
4. Link updated docs pages if behavior changed.

Tip: if exports/path aliases drift, run:

```bash
pnpm -C packages/apps-sdk run check:apps:fix
```

## Related docs

- [Docs Home](../README.md)
- [Add a New App Integration](./add-a-new-app-integration.md)
- [App Cookbook](./app-cookbook.md)
- [Permissions and Locking](../reference/permissions-and-locking.md)
- [Socket Events and Sync](../reference/socket-events-and-sync.md)
- [Troubleshooting](./troubleshooting.md)
