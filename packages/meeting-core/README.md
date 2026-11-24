# @conclave/meeting-core

Shared meeting domain logic for `apps/web` and mirrored native behavior.

## What belongs here

- Data contracts shared by the web client and SFU (`types.ts`, `sfu-types.ts`)
- The guest claims of a join token, as one schema that the join route signs from and the SFU parses with (`guest-join-claims.ts`)
- Pure meeting domain reducers and command parsing
- Configurable media encoding helpers

## What should stay in app code

- Platform-specific UI and hooks
- Transport wiring and side effects (browser APIs, native APIs)
- Environment-specific constants

## Why this exists

The web client and SFU were duplicating core domain files. This package keeps
those TypeScript primitives in one place. The active Skip client mirrors the
small pure algorithms it needs in Swift and verifies them with native tests.
