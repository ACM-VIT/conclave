# Add a New Meeting App

Meeting apps have three pieces: a shared Yjs document, a web renderer, and a
definition passed to `AppsProvider` by the meeting host.

## 1. Scaffold the app

```bash
pnpm -C packages/apps-sdk run new:app polls
```

Useful options:

```bash
pnpm -C packages/apps-sdk run new:app polls --name "Quick Polls"
pnpm -C packages/apps-sdk run new:app polls --dry-run
```

The command creates:

```text
src/apps/polls/
  core/
    doc/index.ts
    index.ts
  web/
    components/PollsWebApp.tsx
    index.ts
```

It also adds the `polls/core` and `polls/web` package exports.

## 2. Define shared state

Keep durable collaborative data in the Yjs document. Keep cursors and other
ephemeral presence in awareness.

```ts
import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppArray,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";

const ROOT_KEY = "polls";

export const createPollsDoc = (): Y.Doc =>
  createAppDoc(ROOT_KEY);

export const getPollsRoot = (doc: Y.Doc) => getAppRoot(doc, ROOT_KEY);

export const getOptions = (doc: Y.Doc): string[] => {
  const value = getPollsRoot(doc).get("options");
  return value instanceof Y.Array
    ? value.toArray().filter((item): item is string => typeof item === "string")
    : [];
};

export const addOption = (doc: Y.Doc, option: string): void => {
  ensureAppArray(getPollsRoot(doc), "options").push([option]);
};
```

`createPollsDoc` deliberately authors no shared defaults before the server sync
arrives. Reads return local UI defaults such as `[]`; the first real mutation
lazily creates its shared type. This prevents a reconnecting client's defaults
from winning a Yjs map conflict and replacing live room state.

## 3. Implement the renderer

Use `useAppDoc("polls")` for the document and lock state. Do not write when the
room is locked unless the current user is an admin.

```tsx
import { useAppDoc, useApps } from "@conclave/apps-sdk";

export function PollsWebApp() {
  const { doc, locked } = useAppDoc("polls");
  const { isAdmin } = useApps();
  const canEdit = !locked || Boolean(isAdmin);

  return <section>{canEdit ? "Poll editor" : "Poll results"}</section>;
}
```

The app entry point binds metadata, document creation, and the renderer:

```ts
export const pollsApp = defineApp({
  id: "polls",
  name: "Polls",
  createDoc: createPollsDoc,
  web: PollsWebApp,
});
```

## 4. Add it to the meeting host

Import the definition in `apps/web/src/app/meets-client.tsx` and append it to
the stable `MEETING_APPS` array. `AppsProvider` exposes that array, and
`MeetingAppLayout` renders the active definition's `web` component.

Use `useApps()` from an admin control to open, close, or lock it:

```ts
const { openApp, closeApp, setLocked } = useApps();

await openApp("polls");
await setLocked(true);
await closeApp();
```

## 5. Verify it

```bash
pnpm -C packages/apps-sdk run check:apps
pnpm -C packages/apps-sdk run typecheck
pnpm -C apps/web run typecheck
pnpm -C apps/web run lint
pnpm -C apps/web run test
```

Runtime smoke test two browser participants: open the app, edit from both,
reload one participant, lock/unlock it, close it, and reconnect. Confirm the
document converges and non-admin writes are blocked while locked.

The active native app in `apps/conclave-skip` implements the same SFU protocol
directly in Swift/Kotlin; it does not consume this React package.
