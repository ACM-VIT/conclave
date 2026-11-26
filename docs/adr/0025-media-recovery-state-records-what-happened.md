# 0025. Media recovery state records what happened, not what was planned

- Status: Accepted
- Date: 2026-11-27

## Context

The web client recovers a media direction (send or receive) in steps: ICE restart, a check that media moved, one rebuild of that direction through TURN alone, then the blocked warning with Try again. One record per direction (`DirectionRecovery` in `media-path-recovery.ts`) holds where that direction is on the ladder.

Until PR #273 review round 31 the record was written when a step was planned. `planMediaPathFailure` marked the transport escalated and the rebuild tried before the reconnect run had fetched credentials, checked the path or touched a transport. The run could then end without rebuilding (the path carried media again, the transport had been replaced, the check was cancelled), and nothing took the plan back. Four review findings came from that one premise:

- A run that skipped its rebuild left the transport escalated. Later stalls restarted ICE and were dropped as already escalated: no rebuild, no warning, no Try again (90 s with 5 ICE restarts in the reviewer's repro).
- The same run left the rebuild marked tried, so the next failure went straight to the warning without ever trying TURN.
- A rebuild held behind another direction's run kept only the transport and the reason. The producers known not to reach the SFU were dropped, so a quiet camera next to a working microphone passed as proof.
- One flag covered both directions' sampling, and a reconnect run reset both directions' watches, so one direction's slow recovery delayed the other's by up to 30 s.

A fifth finding had the same shape in the ICE restart check: a sender count that timed out read as "the sharer sent nothing", which read as "recovered".

## Decision

The recovery reducer is the only owner of recovery state, and it records events that happened.

1. **A failure is handled by one run, and the record says so only while that run is in flight.** `planMediaPathFailure` stores the failure as `escalation` (transport, reason, producers known to be failing). The reconnect run that serves it sends `escalation-settled` from its `finally`, on every exit. A blocked direction holds no escalation: its health and `rebuildTried` already say everything.
2. **A rebuild counts when it starts.** `rebuildTried` is set only by `rebuild-started`, sent at the point a transport is torn down for the failure being handled (the one-direction rebuild, or the rejoin it falls back to). The reducer ignores it once the failure is no longer handled, for example after Try again.
3. **Proof of delivery is media flowing.** The check before a rebuild and the check after an ICE restart send `media-flowing` when they prove delivery on the current transport, so the whole record starts over. The check before a rebuild reads the producers it must prove from the escalation at the moment it judges, so evidence added during the check is covered.
4. **Evidence is never dropped on the way.** A later report for the same transport adds its producers to the escalation or to the held rebuild. A held rebuild is replayed with everything it held. A transport reporting connected voids a held rebuild only when the failure was that it could not connect.
5. **Directions are independent.** Each direction has its own sampling slot, and a direction's watch is reset only while its own failure is being handled.
6. **Unknown is not recovered.** `expectationAfterIceRestart` returns `unknown` when a sender count is missing, and `judgeIceRestart` treats that as not recovered.

## Consequences

- A direction with a known failure rebuilds, recovers on proof, or shows the warning within a bound. `media-path-recovery-model.test.ts` drives 5,000 seeded interleavings of stalls, reports, checks, cancelled checks, concurrent runs, transport replacement, Try again and leave, and checks after every step that the record matches a ledger of what happened. Seven mutations of the reducer, including each old behaviour, fail it.
- `media-recovery-state.test.tsx` runs the same property on the real hook through `call-rig.tsx`, with three seeds pinned that left the receive path stuck on the previous head.
- A direction with a held rebuild reads `recovering`, not `healthy`.
- The other direction's stall clock keeps running during a one-direction rebuild. It still acts only after that run ends.
- Still open: after a watch is reset, a camera that failed and then sends nothing has no failure on record, so the watchdog can report the direction healthy on the microphone alone. The checks above do not have this gap because they carry the failing producers.
- Revisit if recovery gains a second concurrent run, since rule 1 relies on one run at a time.

## Alternatives considered

- **Keep writing at plan time and reset on each skipped exit:** rejected. This was the previous shape, and each review round found one more exit.
- **Release an escalation when its transport reports connected:** rejected. Connecting proves nothing about media, and ICE often stays connected through a media stall, so the release never came.
- **Let the watchdog keep sampling the direction being rebuilt:** rejected in round 30. Aggregate flow on the transport proved a camera that was not delivering.

## Code

- `apps/web/src/app/lib/media-path-recovery.ts`: `DirectionRecovery`, `FailedPath`, `planMediaPathFailure`, `advanceMediaPathRecovery`, `takeDeferredRebuilds`, `expectationAfterIceRestart`, `judgeIceRestart`
- `apps/web/src/app/lib/reconnect-request-policy.ts`: `planScopedRebuild`
- `apps/web/src/app/hooks/useMeetSocket.ts`: `escalateMediaPathFailure`, `handleReconnect` (`noteEscalation`), the media path watchdog effect
- `apps/web/test/media-path-recovery-model.test.ts`, `apps/web/test/media-recovery-state.test.tsx`, `apps/web/test/media-path-recovery.test.ts`
