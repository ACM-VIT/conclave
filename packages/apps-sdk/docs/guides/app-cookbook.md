# App Cookbook

This cookbook is a practical "start from a proven shape" guide for building apps on top of `@conclave/apps-sdk`.

Use it when you know the kind of app you want, but do not want to design schema, lock behavior, and host wiring from scratch.

## Choosing A Recipe

| App type | Best when | Shared data complexity | Suggested first milestone |
| --- | --- | --- | --- |
| Polls | One prompt, many participants, quick consensus | Medium | single-question poll with live tally |
| Checklist | Team action tracking during call | Low-Medium | add/toggle/remove items with owner |
| Timer | Timeboxing facilitation | Low | start/pause/reset synchronized timer |
| Shared Notes | Collaborative meeting notes | Low | single shared `Y.Text` doc |
| Media Controller | Shared playback queue + control state | Medium-High | queue + controller role + play/pause |

## Before You Build

1. Pick app id (`kebab-case`) and do not change it after launch.
2. Decide control model.
3. Decide what is durable (Yjs doc) vs ephemeral (local UI or awareness).
4. Start with one vertical slice before adding advanced interactions.

Control model options:

- admin-only control
- everyone can edit when unlocked
- single controller role + fallback to admin

Durability split checklist:

- If it must survive reconnect/history: store in Yjs doc.
- If it is participant-local and ephemeral: use awareness or local component state.
- If it is render-only convenience state (filter/query/panel): keep local.

## Standard Build Flow

1. Scaffold files:

```bash
pnpm -C packages/apps-sdk run new:app <id>
```

2. Define shared schema in `core/doc/index.ts`.
3. Implement `web` renderer first.
4. Register app in host and wire open/close controls.
5. Add lock guards (`locked && !isAdmin`) to mutation paths.
6. Validate wiring:

```bash
pnpm -C packages/apps-sdk run check:apps
```

## Shared Patterns You Should Reuse

### Pattern: Read-only guard

```ts
const canEdit = !locked || Boolean(isAdmin);
if (!canEdit) return;
```

### Pattern: Stable schema initialization

```ts
import * as Y from "yjs";
import { createAppDoc, ensureAppArray, ensureAppMap, ensureAppText } from "@conclave/apps-sdk";

export const createExampleDoc = () =>
  createAppDoc("example", (root) => {
    ensureAppText(root, "title");
    ensureAppArray(root, "items");
    ensureAppMap(root, "meta");
  });
```

### Pattern: Keep awareness ephemeral

- Good awareness state:
  - cursor coordinates
  - temporary selection ids
  - local user badge color
- Avoid in awareness:
  - canonical app content
  - anything needed after reconnect

## Recipe: Polls

### Use this when

- You need structured voting and clear outcome counts.
- You want one live question at a time.

### Recommended schema

- `prompt: Y.Text`
- `options: Y.Array<{ id: string; label: string }>`
- `votesByUser: Y.Map<string, string>` (`userId -> optionId`)
- `status: "draft" | "open" | "closed"`
- `meta: Y.Map` (`createdAt`, `updatedAt`, `createdBy`)

### Behavior rules

- Voters can submit one vote per poll (`votesByUser.set(userId, optionId)`).
- Admin can reset poll by clearing `votesByUser`.
- Tally is derived in UI from `votesByUser` + `options`.

### Minimal mutations

- `setPrompt(text)`
- `addOption(label)`
- `removeOption(optionId)` and cleanup votes
- `vote(optionId, userId)`
- `setStatus(status)`

### Testing focus

1. Vote replacement works (same user changes vote).
2. Deleting an option invalidates stale votes.
3. Closed poll blocks vote updates for non-admin.

## Recipe: Checklist / Action Items

### Use this when

- You need lightweight task tracking with ownership and done state.

### Recommended schema

- `items: Y.Array<{ id: string; text: string; done: boolean; ownerId?: string; createdAt: number }>`
- `meta: Y.Map` (`updatedAt`)

### Behavior rules

- Keep item ids immutable.
- Toggle done by replacing only one item object.
- Keep sort/filter local (not in Yjs unless shared sort is required).

### Common local-only UI state

- search query
- current filter (`all`, `open`, `done`)
- expanded/collapsed item details

### Testing focus

1. Concurrent toggles converge.
2. Item delete does not corrupt order.
3. Lock mode blocks edits but still updates UI from peers.

## Recipe: Timer / Timebox

### Use this when

- A host/facilitator runs strict timed segments.

### Recommended schema

- `durationSec: number`
- `status: "idle" | "running" | "paused" | "done"`
- `startedAt: number | null`
- `pausedAt: number | null`
- `accumulatedPauseSec: number`
- `meta: Y.Map` (`updatedAt`, `updatedBy`)

### Behavior rules

- Store canonical timeline state in Yjs.
- Derive `remainingSec` in the UI from local clock + shared timestamps.
- Avoid writing every tick to Yjs.

### Testing focus

1. Reconnect computes same remaining time.
2. Pause/resume race conditions converge.
3. Only authorized role can control timer state.

## Recipe: Shared Notes

### Use this when

- The app is essentially a collaborative text pad.

### Recommended schema

- `title: Y.Text` (optional)
- `notes: Y.Text`
- `meta: Y.Map` (`updatedAt`, `updatedBy`)

### Behavior rules

- Keep text content in `Y.Text`.
- Use local draft state only for temporary UI wrappers.
- For very large notes, optimize expensive derived rendering, not Yjs updates.

### Testing focus

1. Multi-user editing convergence.
2. Newlines and paste behavior.
3. Lock mode disables editor input for non-admin.

## Recipe: Media Controller

### Use this when

- One shared queue and synchronized playback state are required.

### Recommended schema

- `queue: Y.Array<{ id: string; title: string; url: string; durationSec?: number }>`
- `activeIndex: number`
- `playback: Y.Map`:
  - `status: "playing" | "paused" | "stopped"`
  - `positionSec: number`
  - `updatedAt: number`
  - `controllerUserId: string`
- `meta: Y.Map` (`updatedAt`)

### Behavior rules

- Keep one source of truth for playback state.
- Track who is currently controller.
- Decide arbitration strategy for conflicting control events.

### Testing focus

1. Queue mutations are deterministic.
2. Controller handoff is explicit.
3. Non-controller actions are rejected or queued per policy.

## End-to-End Starter Example

`core/doc/index.ts`:

```ts
import * as Y from "yjs";
import { createAppDoc, ensureAppArray, ensureAppMap } from "@conclave/apps-sdk";

export const createChecklistDoc = () =>
  createAppDoc("checklist", (root) => {
    ensureAppArray(root, "items");
    ensureAppMap(root, "meta");
  });
```

`web/index.ts`:

```ts
import { defineApp } from "../../../sdk/registry/index";
import { createChecklistDoc } from "../core/doc/index";
import { ChecklistWebApp } from "./components/ChecklistWebApp";

export const checklistApp = defineApp({
  id: "checklist",
  name: "Checklist",
  description: "Shared action items",
  createDoc: createChecklistDoc,
  web: ChecklistWebApp,
});
```

`host registration`:

```ts
import { registerApps } from "@conclave/apps-sdk";
import { checklistApp } from "@conclave/apps-sdk/checklist/web";

useEffect(() => {
  registerApps([checklistApp]);
}, []);
```

`meeting controls wiring`:

```ts
const { state, openApp, closeApp, setLocked } = useApps();
const isChecklistActive = state.activeAppId === "checklist";

const toggleChecklist = () =>
  isChecklistActive ? closeApp() : openApp("checklist");

const toggleLock = () => setLocked(!state.locked);
```

## Verification Checklist (Ship Gate)

1. Open/close works from meeting controls.
2. Lock blocks non-admin data mutations.
3. Cross-client Yjs sync converges.
4. Awareness state appears and clears correctly.
5. Reconnect restores app state (`refreshState` + sync).
6. Exports + mobile aliases pass `check:apps`.

If any item fails, use [Troubleshooting](./troubleshooting.md) before expanding feature scope.

## Related Docs

- [Docs Home](../README.md)
- [Core Concepts](../reference/core-concepts.md)
- [Runtime APIs and Hooks](../reference/runtime-apis.md)
- [Permissions and Locking](../reference/permissions-and-locking.md)
- [Socket Events and Sync](../reference/socket-events-and-sync.md)
- [Troubleshooting](./troubleshooting.md)
- [Add a New App Integration](./add-a-new-app-integration.md)
