# Contributing to the Apps SDK

## Before editing

- Collaborative app state belongs in Yjs.
- Ephemeral presence belongs in awareness.
- Game rules, hidden information, timers, and scoring belong on the SFU.
- The package is the web runtime. The Skip native app implements the wire
  protocol independently.

## Add an app

Use the scaffold and follow the [app integration guide](./add-a-new-app-integration.md):

```bash
pnpm -C packages/apps-sdk run new:app <id>
```

Every app needs `core/doc/index.ts`, `core/index.ts`, `web/index.ts`, and matching
package exports. The validator enforces that shape.

## Add a game

Follow [Add a Game](./add-a-game.md). Game modules are pure server reducers
except where a documented runtime dependency is unavoidable. Export the typed
move union and add behavior tests for validation, permissions, timers, and
private projections.

## Required checks

```bash
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run typecheck
pnpm -C apps/web run typecheck
pnpm -C apps/web run lint
pnpm -C packages/sfu run typecheck
pnpm -C packages/sfu test
```

For app UI changes, smoke test two participants, reconnect, locking, and
read-only behavior. For games, test player, host, and spectator projections.
