# Core Concepts

This page explains the conceptual model behind `@conclave/apps-sdk`: what an app is, where state lives, and how host/app/server responsibilities are split.

## What Is an App in Conclave

An app is a collaborative in-meeting surface with:

- stable app id (for example `whiteboard`, `polls`)
- a web renderer
- optional empty-on-join shared Yjs doc factory (`createDoc`)

Apps are defined with `defineApp(...)` and passed to `AppsProvider`.

## Collaborative Apps and Games

Conclave supports two in-meeting extension shapes:

- Collaborative apps use Yjs. Everyone converges on the same shared document. Use this for whiteboards, notes, polls, checklists, and tools where the shared state can be visible to all participants.
- Games use the server-authoritative game runtime. The SFU owns rules, timers, scoring, and private player views. Use this for hidden roles, trivia answers, timed reactions, scoring, and any rule set that clients should not be able to forge.
- Prompt-based games can opt into server-side generated content before the game starts. The host sends a normal config value such as a topic, and the SFU validates the generated object before it becomes game state.

The game runtime also provides, out of the box:

- Typed move contracts: each game exports a discriminated union of its legal moves, decoded and validated on the server, with `createTypedMove` giving renderers compile-time safety.
- Tile adornments: games light up the participant video tiles (locked in, correct, eliminated, winner, rank) and can make tiles tappable during votes, so the grid doubles as the game board. See [Tile Adornments](./tile-adornments.md).
- Host options and rematch: a game declares its settings schema, the host configures a run, and the chosen config rides the public state so the results screen can restart the same game with one action.
- Game votes: the host can put the game choice to the room and start the winner.
- Canonical identity: snapshots carry `selfId`, the server's id for you, so clients never rebuild identity locally.

If you are adding a game, start with [Add a Game to Conclave](../guides/add-a-game.md).

## Runtime Layers

Think of the system in four layers:

1. App definition layer:
   - `defineApp` shape validation
   - app metadata and renderer entrypoints
2. Host runtime layer:
   - explicit app list passed to `AppsProvider`
   - `AppsProvider` context for state + sync
3. App UI layer:
   - hooks (`useApps`, `useAppDoc`, `useAppPresence`)
   - mutation/read logic with lock-aware behavior
4. SFU server layer:
   - socket handlers enforce permissions
   - relay Yjs and awareness updates by active `appId`

## Main Building Blocks

### 1. App Definition

`defineApp` validates app shape early:

- `id` required
- `name` required
- web renderer required

### 2. Host App List

The host passes a stable array of definitions to `AppsProvider`. This keeps the
available apps explicit and avoids mutable process-global registration state.

### 3. Runtime Provider

`AppsProvider` bridges the host socket and app hooks:

- owns one Yjs doc per app id
- owns one awareness instance per app id
- keeps shared room state in context (`activeAppId`, `locked`)
- exposes control operations (`openApp`, `closeApp`, `setLocked`, `refreshState`)

### 4. Shared Data Model (Yjs)

Each app can have one shared Yjs doc.

Use Yjs for:

- canonical collaborative data
- state that must survive reconnects
- state all participants should converge on

Create an empty doc with `createAppDoc`, return local defaults from readers, and
lazily create shared types from real mutation paths. Writing defaults before
the initial server sync can overwrite live state during Yjs conflict resolution.

### 5. Awareness / Presence

Awareness is for ephemeral participant state:

- cursor position
- transient selection
- temporary presence metadata

Do not store canonical app content in awareness.

### 6. Room App State

Global app state is room-scoped and shared:

- `activeAppId`
- `locked`

This state is exposed as `useApps().state`.

## Data Ownership Rules

- Durable shared content: Yjs doc.
- Ephemeral shared presence: awareness.
- Local-only UI state: React component state.

A useful rule: if it must be correct after reconnect, do not rely on awareness alone.

## Permission and Locking Model

- Admins can open/close/lock apps.
- Non-admins still receive state and sync traffic.
- When `locked = true`, non-admin Yjs content updates are dropped server-side.

Implication for app code:

- render read-only state when `locked && !isAdmin`
- keep presence updates visible even while read-only

## Typical Lifecycle Flow

1. Host registers apps.
2. Admin opens an app (`openApp(appId)`).
3. Server broadcasts `apps:state` with `activeAppId`.
4. Provider syncs active app doc via `apps:yjs:sync`.
5. App UI reads doc with `useAppDoc(appId)`.
6. App UI publishes awareness with `useAppPresence(appId)`.
7. App edits propagate through `apps:yjs:update`.
8. On lock, non-admin content edits are ignored by server.

## Host Responsibilities

- register the app definitions available in the meeting
- mount `AppsProvider` with socket + identity + role context
- expose app controls only where appropriate (usually admin-only)
- visibly communicate lock/read-only mode

## App Responsibilities

- use a stable app id in all call sites
- design clean doc schema and separate awareness from durable data
- guard write paths for lock/read-only behavior
- avoid optimistic local writes when server will reject updates

## Where to Go Next

- [Runtime APIs and Hooks](./runtime-apis.md)
- [Permissions and Locking](./permissions-and-locking.md)
- [Socket Events and Sync](./socket-events-and-sync.md)
- [Add a New App Integration](../guides/add-a-new-app-integration.md)
