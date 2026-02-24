# @conclave/meeting-core

Shared meeting domain logic for both `apps/web` and `apps/mobile`.

## What belongs here

- Data contracts shared by both surfaces (`types.ts`, `sfu-types.ts`)
- Pure meeting domain reducers and command parsing
- Configurable media encoding helpers

## What should stay in app code

- Platform-specific UI and hooks
- Transport wiring and side effects (browser APIs, native APIs)
- Environment-specific constants

## Why this exists

The web and mobile meeting implementations were duplicating core domain files.
This package keeps those shared primitives in one place so feature changes can
land once, then be consumed by both apps through thin wrappers.
