# 0002. A client host claim never grants host

- Status: Accepted
- Date: 2026-11-22

## Context

The web `/api/sfu/join` route mints the token the SFU trusts for host and admin authority. A join body can carry `isHost` or `isAdmin`. Trusting that flag once let any client claim host in someone else's room. The decision lives in `packages/meeting-core/src/host-grant.ts` so the invariant can be unit tested and cannot regress silently.

## Decision

A client claim (`requestedHost`) never makes anyone host on its own. Host comes only from a verified session: the email is on the deployment's always-host allowlist (`isForcedHost`) or matches a scheduled room's host or co-host (`scheduledRoomHostMatch`).

A claim, or an explicit `allowRoomCreation` intent, only grants the ability to create a room that does not exist yet, and never for a scheduled room. The SFU's server-authoritative `createdRoom` path then makes the creator host. Nobody can take over an existing or scheduled room by asking.

The host token itself makes the SFU treat the join as host-requested, which is what lets a verified host create the room even when `allowRoomCreation` is false.

## Consequences

- Host authority always traces back to a server-verified identity.
- Starting a new ad-hoc room still works from a plain claim, through the create path.
- Any new way to become host has to go through `resolveHostGrant` and its tests.

## Alternatives considered

- **Trusting the client flag and checking later in the SFU:** rejected because the token is the authority the SFU acts on.

## Code

- `packages/meeting-core/src/host-grant.ts`: `resolveHostGrant`, `HostGrantInput`
- `packages/meeting-core/test/host-grant.test.ts`
