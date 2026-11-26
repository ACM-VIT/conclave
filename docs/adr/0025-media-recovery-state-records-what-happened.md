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

Round 32 found the same family one level down. The evidence that a stream does not reach the SFU lived in the watchdog's watch (`failingSince` per producer), and in copies handed to the run that served the failure. The watch starts over after every stall, on every new transport and while a run is in flight. After it started over, the first samples had nothing against the camera, so a microphone that kept arriving proved the whole direction. Seven reproductions followed from that:

- One missing `getOwnPacketCounts` reply on a fresh watch counted as media flowing. On a rebuilt transport it handed the rebuild back, and the client tore down the working microphone a second time. On a blocked transport it hid the warning.
- A camera that sent nothing for 5 s after a stall did the same.
- A send rebuild held behind a receive rebuild was dropped when the camera went quiet or one reply was lost, and the failed send transport was never rebuilt.
- After a rebuild the app publishes the microphone before the camera. The microphone alone proved the new transport, the record started over, and each camera failure after that tore the microphone down again with no warning.

## Decision

The recovery reducer is the only owner of recovery state, and it records events that happened.

1. **A failure is handled by one run, and the record says so only while that run is in flight.** `planMediaPathFailure` stores the failure as `escalation` (transport and reason). The reconnect run that serves it sends `escalation-settled` from its `finally`, on every exit. A blocked direction holds no escalation: its health and `rebuildTried` already say everything.
2. **A rebuild counts when it starts.** `rebuildTried` is set only by `rebuild-started`, sent at the point a transport is torn down for the failure being handled (the one-direction rebuild, or the rejoin it falls back to). The reducer ignores it once the failure is no longer handled, for example after Try again.
3. **The record names the streams known to be failing.** `DirectionRecovery.failingStreams` lists the sent streams (`mic`, `camera`, `screen`, `screen-audio`) that were seen sending packets the SFU did not count. A stream goes on the list at the first sample that shows it, before any stall. The list is keyed by stream and not by producer id, so it survives a watch that starts over, a producer published again and a rebuilt transport. Nothing else holds this evidence: the watch keeps only packet counters, and a failure handed to a run carries no stream list.
4. **Only delivery takes a stream off the list.** A stream leaves `failingStreams` when a sample shows the SFU counting its packets again. Try again and leaving the call clear the whole list. A missing reply, a quiet stream, a stream that is not being sent, a new transport and a new watch all leave it where it is.
5. **A direction starts over only on proof.** Every sample, from the watchdog, the check after an ICE restart or the check before a rebuild, goes to the reducer as one `path-sampled` event with what it saw: whether media reached the far end, and one verdict per sent stream (`delivered`, `undelivered`, `quiet`, `unconfirmed`). The reducer starts the direction over only when media reached the far end, every stream being sent is `delivered` or `quiet`, and `failingStreams` is empty after the sample. A known-failing stream has to be `delivered`. `unconfirmed` covers a missing or late count reply, a producer's first sample and a missing stats row, and it is never proof. There is no other way out of `blocked` or `recovering`, and no event that only says "media is flowing".
6. **A check answers a narrower question than the record.** The two checks decide whether to act with `pathCarriesWhatIsSent`: does the path carry everything being sent now, with known-failing streams held to `delivered`. A known-failing stream that is no longer sent does not make a check fail, so nothing is rebuilt for a camera the user turned off. It stays on the list, so the direction does not start over either.
7. **The stall clock runs while a known failure is being sent.** A sample reads as flowing only when media reached the far end and no stream on the list is among the streams being sent.
8. **Directions are independent.** Each direction has its own sampling slot, and a direction's watch is reset only while its own failure is being handled.
9. **Unknown is not recovered.** `expectationAfterIceRestart` returns `unknown` when a sender count is missing, and `judgeIceRestart` treats that as not recovered.
10. **A queued Try again is spent only by the settlement.** `handleReconnect` no longer clears it when an automatic rejoin succeeds. `planReconnectSettlement` sees it and runs the full Try again.

## Consequences

- A camera that keeps failing gets one rebuild and then the warning. The microphone is torn down once, not once per stall.
- The warning stays while the failing stream is muted, turned off or quiet. It clears when that stream is seen arriving, or after Try again once media is proven. A user who turns a blocked camera off still sees the warning, with Try again and dismiss.
- A direction can stay `recovering` for as long as its failing stream is not sent. `recovering` shows nothing to the user and tears nothing down.
- After a rebuild or a new watch, proof takes one sample longer, because a producer's first sample is `unconfirmed`.
- On an SFU that counts packets, proof needs the count replies. If they never come, a blocked direction stays blocked until Try again.
- On a browser that gives no `mid` on `outbound-rtp`, a stream is judged by the SFU's count alone: `delivered` when the count grows, `unconfirmed` otherwise.
- A Try again pressed during an automatic rejoin runs after that rejoin, so the call rejoins twice.
- `media-path-recovery-model.test.ts` drives the real watch and the real reducer together through 5,000 seeded interleavings: path and per-stream drops, quiet streams, missing count replies, watch resets on the same transport, streams published late or turned off, held rebuilds, concurrent runs, Try again and leave. After every step the record must match a ledger of what happened. A direction leaves `blocked` or gets its rebuild back only on a sample the test's own rule calls proof. A direction is torn down at most once between proofs. In calm conditions every direction ends healthy or blocked within 40 rounds. Seventeen mutations of the library, including each old behaviour, fail it.
- `media-failure-evidence.test.tsx` and `media-recovery-state.test.tsx` run the reviewer's reproductions and the seeded property on the real hook through `call-rig.tsx`. The rig closes producers with their transport and publishes the microphone and camera again after a rebuild, as the app does.
- Revisit if recovery gains a second concurrent run, since rule 1 relies on one run at a time.

## Alternatives considered

- **Keep writing at plan time and reset on each skipped exit:** rejected. This was the previous shape, and each review round found one more exit.
- **Release an escalation when its transport reports connected:** rejected. Connecting proves nothing about media, and ICE often stays connected through a media stall, so the release never came.
- **Let the watchdog keep sampling the direction being rebuilt:** rejected in round 30. Aggregate flow on the transport proved a camera that was not delivering.
- **Key known failures by producer id and clear them on a new transport:** rejected. A rebuild publishes new producers, so the list would be empty exactly when the rebuild has to prove itself, and the microphone published first would prove it.
- **Stop sampling a direction that holds a rebuild:** rejected. Under rule 5 a sample cannot drop a held rebuild without proof, and sampling lets real proof cancel a rebuild that is no longer needed.
- **Take a stream off the list when it stops being sent:** rejected. "Not sent yet after a rebuild" and "turned off" look the same to the watchdog, and mute then unmute would hand the rebuild back.

## Code

- `apps/web/src/app/lib/media-path-recovery.ts`: `DirectionRecovery`, `SentStream`, `PathEvidence`, `judgeProducerDelivery`, `advanceProducerDeliveries`, `judgeDeliveryWindow`, `failingStreamsAfter`, `pathCarriesWhatIsSent`, `advanceMediaPathWatch`, `advanceMediaPathRecovery`, `planMediaPathFailure`, `takeDeferredRebuilds`, `expectationAfterIceRestart`, `judgeIceRestart`
- `apps/web/src/app/lib/reconnect-request-policy.ts`: `planScopedRebuild`, `planReconnectSettlement`, `PathProbeResult`
- `apps/web/src/app/hooks/useMeetSocket.ts`: `escalateMediaPathFailure`, `handleReconnect` (`noteEscalation`), the media path watchdog effect
- `apps/web/test/media-path-recovery-model.test.ts`, `apps/web/test/media-failure-evidence.test.tsx`, `apps/web/test/media-recovery-state.test.tsx`, `apps/web/test/media-path-recovery.test.ts`
