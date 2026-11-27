# 0013. Operator access and room moderation

- Status: Accepted
- Date: 2026-11-22

## Context

Anyone becomes a room admin by creating a room. Operators (verified super admins) run the admin dashboard and moderation across rooms. Admin socket handlers can be registered from several paths on the same live socket.

## Decision

- Listing other meetings is only for verified super admins. A room admin sees only their own room.
- Moderation immunity belongs only to verified super admins, including older join tokens that mark the verified email allowlist with `isForcedHost`. Room creation and host promotion never confer it.
- The operator audit trail is an in-memory, bounded, per-process feed. The HTTP admin routes are its only writer and the admin gateway streams it to dashboards. It is an operations feed, not a compliance store.
- Room admin listeners are bound once per socket. `joinRoom` (including the in-place room switch) and both host-promotion paths can each ask to bind them on the same socket, and binding twice would make every kick, end-room or promote fire several times and leak listeners. The single bound set resolves the current room from the per-socket context through `ensureAdminRoom` when it runs.

## Consequences

- Creating a room never exposes other rooms or grants moderation immunity.
- Audit history is lost on restart.

## Alternatives considered

- **A durable audit store:** not needed for an operations feed, and out of scope for the SFU.

## Code

- `packages/sfu/server/socket/handlers/adminHandlers.ts`: `canSeeOtherRooms`, `adminHandlersRegistered`, `ensureAdminRoom`
- `packages/sfu/server/admin/moderation.ts`: `isSuperAdminClient`
- `packages/sfu/server/admin/adminAudit.ts`: `recordAdminAudit`
