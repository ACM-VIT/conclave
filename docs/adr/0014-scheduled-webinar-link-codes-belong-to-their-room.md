# 0014. Scheduled webinar link codes belong to their room

- Status: Accepted
- Date: 2026-11-22

## Context

A webinar's public link code routes its audience into a room. The scheduler binds the code to the scheduled room only around the event, so for some time a scheduled code is not bound to any live room.

## Decision

A scheduled webinar's link code is reserved for that schedule's room before and after the scheduler binds it. An ad-hoc room may only take an unreserved code, or its own scheduled code, so it can never receive another webinar's audience.

## Consequences

- Setting a link code that a schedule reserves fails with "This webinar link code is already in use."

## Code

- `packages/sfu/server/socket/handlers/webinarHandlers.ts`: link code update, `getScheduledWebinarBySlug`
