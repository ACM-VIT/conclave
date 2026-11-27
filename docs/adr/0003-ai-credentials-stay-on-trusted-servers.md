# 0003. AI credentials stay on trusted servers

- Status: Accepted
- Date: 2026-11-22

## Context

Room AI features (the assistant, summaries, captions and model discovery) run on the web Worker but are configured per room on the SFU that owns the room. Rooms can be routed to SFUs in different deployments, each with its own provider account. Provider keys, the shared server secret and personal keys must never reach a client, a prompt, a log or the wrong account.

Cloudflare Workers drops the useful fields of SDK `Error` objects when it serializes them, so logging the raw error loses the diagnosis and can still leak request data.

## Decision

- A routed room resolves its AI settings and credentials only from the SFU that owns it, over a server-to-server call authenticated by a shared secret that never comes from a client. Discovery and execution use the same account and endpoint, and missing room settings never fall back to another Worker's account.
- Every call that carries a credential or the shared secret uses `redirect: "manual"`, so the secret is never forwarded to a `Location` target.
- Only configuration is returned to callers. Credentials and transport data never enter a prompt.
- Failures are logged as fixed, redacted diagnostic fields: never the SDK error, the request, its headers, identities or response bodies. Discovery failures show a fixed message and fall back to the built-in model list.
- On the SFU, deployment values set the defaults and explicit room choices override them. Discovery, the settings UI and inference all read the same effective profile, so the UI never shows a model the run would not use.
- A personal key supplied for model discovery is used for that request only and is never cached or retained on the room.

## Consequences

- A compromised client or prompt cannot read a provider key.
- Diagnosing a provider failure relies on the fixed diagnostic fields rather than the raw error.

## Alternatives considered

- **Passing room credentials through the client:** rejected because any participant could read them.
- **Falling back to the Worker's own account when a room has no settings:** rejected because it bills and exposes the wrong tenant.

## Code

- `packages/ai/src/room-server.ts`: `roomAiEnvironment`, `fetchRoomAiEnvironment`, `describeRoomAiLookupFailure`
- `packages/ai/src/catalog-server.ts`: model discovery fetches
- `packages/ai/src/errors.ts`: `describeAiError`
- `packages/sfu/server/roomAiSettings.ts`: `roomAiFeatureDefaults`
- `packages/sfu/server/roomAiCredentials.ts`: `RoomAiCredentials`
