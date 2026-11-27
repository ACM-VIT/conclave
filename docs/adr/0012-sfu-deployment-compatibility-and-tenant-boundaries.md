# 0012. SFU deployment compatibility and tenant boundaries

- Status: Accepted
- Date: 2026-11-22

## Context

The SFU serves several client namespaces (tenants) from one deployment, is deployed blue-green while calls continue, and talks to older clients and older shared-browser services during a rollout.

## Decision

- **Tenant migration:** schedule lookups fall back to the deployment's legacy client ids. The requested namespace comes from the request (a query parameter or the `x-sfu-client` header), so data only ever moves into the deployment's default client, and only from one of its legacy aliases. Moving data on any request once let anyone pull a scheduled meeting or webinar out of its tenant with `?clientId=<anything>`.
- **CORS:** `SFU_CORS_ORIGINS` is a comma-separated allowlist. Development falls back to `*`. In production a wildcard must be an explicit operator choice through `SFU_ALLOW_OPEN_CORS=1`, otherwise startup fails. The result works for both the `cors` middleware and socket.io.
- **Invite codes:** each time an invite code is set it gets a fresh random version tag, so a host can tell whether its saved code is current without the tag revealing anything about the code.
- **Legacy request fields:** endpoints whose callers have historically sent numbers or booleans as strings read them with the coercing readers. Strict readers stay the default for every other field.
- **Shared-browser rollout:** an older browser service has no capabilities endpoint. A 404 there means the legacy Chromium provider with audio and video and no agentic mode, so rolling deployments keep working.

## Consequences

- A request cannot move stored data between tenants.
- A production SFU without a CORS policy does not start.

## Alternatives considered

- **Migrating into whatever namespace a request names:** rejected after it let any caller move another tenant's meetings.

## Code

- `packages/sfu/server/clientIds.ts`: `canMigrateClientNamespace`
- `packages/sfu/server/cors.ts`: `resolveCorsOrigins`
- `packages/sfu/server/inviteCodeVersion.ts`: `newInviteCodeVersion`
- `packages/sfu/utilities/untrusted.ts`: `readCoercedNumber`, `readCoercedBoolean`
- `packages/sfu/server/browserServiceClient.ts`: capabilities fallback
