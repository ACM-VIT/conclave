# 0019. Game analytics are server-observed and pseudonymous

- Status: Accepted
- Date: 2026-11-22

## Context

Product analytics for games go to PostHog. Counting lifecycle events on clients would count each transition once per participant, and participant identifiers can be email addresses.

## Decision

- The SFU owns canonical game state, so it captures each lifecycle transition exactly once. A per-play `instanceId`, created at start and kept in a `WeakMap` keyed by the `GameSession`, correlates a play's events. Every event belongs to the room group, keyed by `room.channelId`.
- Only opaque ids, counts, booleans, durations, phase labels and numeric or enum config are sent: never names, chat, the AI topic, the Imposter word, emails or any free text. The free-text `topic` option becomes a `has_topic` boolean.
- The PostHog `distinct_id` is an HMAC of the stable room user key with `SFU_SECRET`. The raw key can be an email and never leaves the SFU, and the HMAC keeps reconnects grouped without being reversible or guessable from a dictionary.
- `game_ended` means abandonment. It fires only when a host ends a game that had not finished, and it is captured before the session is cleared. A finished game already sent `game_finished`.

## Consequences

- Dashboards can trust one event per transition.
- Rotating `SFU_SECRET` splits each user's history at the rotation.

## Alternatives considered

- **Client-side capture:** rejected because of double counting and the need for host-only gating.

## Code

- `packages/sfu/server/socket/handlers/gameHandlers.ts`: `TEXT_TOPIC_OPTION_ID`, `stableDistinctId`, `maybeCaptureGameFinished`, `playAnalyticsBySession`
- `packages/sfu/server/analytics/posthog.ts`
