# Core Concepts

This page explains the conceptual model behind `@conclave/apps-sdk`: what an app is, where state lives, and how host/app/server responsibilities are split.

## What Is an App in Conclave

An app is a collaborative in-meeting surface with:

- stable app id (for example `whiteboard`, `polls`)
- at least one renderer (`web` and/or `native`)
- optional shared Yjs doc initializer (`createDoc`)

Apps are defined with `defineApp(...)` and registered with `registerApps(...)`.

## Runtime Layers

Think of the system in four layers:

1. App definition layer:
   - `defineApp` shape validation
   - app metadata and renderer entrypoints
2. Host runtime layer:
   - app registry (`registerApp`, `registerApps`)
   - `AppsProvider` context for state + sync
3. App UI layer:
   - hooks (`useApps`, `useAppDoc`, `useAppPresence`, `useAppAssets`)
   - mutation/read logic with lock-aware behavior
4. SFU server layer:
   - socket handlers enforce permissions
   - relay Yjs and awareness updates by active `appId`

## Main Building Blocks

### 1. App Definition

`defineApp` validates app shape early:

- `id` required
- `name` required
- at least one renderer required (`web` or `native`)

### 2. Registry

`registerApp` / `registerApps` stores app definitions in a process-local map.

Key behaviors:

- repeated registration is safe
- registry updates are observable (`subscribeRegistry`)
- host process controls what apps are available

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

Use `createAppDoc` + helper initializers for deterministic schema setup.

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

- register correct app definitions for the platform
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
