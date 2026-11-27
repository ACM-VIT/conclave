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

Round 33 found it once more, outside the reducer. Three places still decided that a path works from bytes that left the browser and receiver reports that came back, and mediasoup sends receiver reports whether or not any RTP arrived:

- The check before a relay move (`hasCarriedMedia`) marked a send transport as having carried media once it had sent any bytes and held any receiver report. A send path rebuilt while no TURN credentials were usable, on a network that passes ICE and RTCP and drops RTP, was marked that way when fresh credentials arrived. The relay move was skipped, the one rebuild was already spent, and the path was reported blocked until Try again.
- The watchdog marked a transport the same way on any sample with bytes sent and a newer report, as long as no known-failing stream was being sent. With count replies missing, a transport that never delivered a packet got an ICE restart before its rebuild, and a newer relay that only passed ICE and reports replaced the relay that had delivered.
- The two checks and the reducer took a sample in which nothing was delivered (a still screen share with reports arriving) as the path carrying what is sent.

## Decision

The recovery reducer is the only owner of recovery state, and it records events that happened.

1. **A failure is handled by one run, and the record says so only while that run is in flight.** `planMediaPathFailure` stores the failure as `escalation` (transport and reason). The reconnect run that serves it sends `escalation-settled` from its `finally`, on every exit. A blocked direction holds no escalation: its health and `rebuildTried` already say everything.
2. **A rebuild counts when it starts.** `rebuildTried` is set only by `rebuild-started`, sent at the point a transport is torn down for the failure being handled (the one-direction rebuild, or the rejoin it falls back to). The reducer ignores it once the failure is no longer handled, for example after Try again.
3. **The record names the streams known to be failing.** `DirectionRecovery.failingStreams` lists the sent streams (`mic`, `camera`, `screen`, `screen-audio`) that were seen sending packets the SFU did not count. A stream goes on the list at the first sample that shows it, before any stall. The list is keyed by stream and not by producer id, so it survives a watch that starts over, a producer published again and a rebuilt transport. Nothing else holds this evidence: the watch keeps only packet counters, and a failure handed to a run carries no stream list.
4. **Only delivery takes a stream off the list.** A stream leaves `failingStreams` when a sample shows the SFU counting its packets again. Try again and leaving the call clear the whole list. A missing reply, a quiet stream, a stream that is not being sent, a new transport and a new watch all leave it where it is.
5. **A direction starts over only on proof.** Every sample, from the watchdog, the check after an ICE restart or the check before a rebuild, goes to the reducer as one `path-sampled` event with what it saw. `PathEvidence` is `{ received }` for a receive path (RTP bytes arrived here) and `{ sent }` for a send path (one verdict per sent stream: `delivered`, `undelivered`, `quiet`, `unconfirmed`). It has no field for bytes sent or receiver reports. The reducer starts the direction over only when `pathCarriesWhatIsSent` holds. `unconfirmed` covers a missing or late count reply, a producer's first sample and a missing stats row. It is never proof.
6. **One function says a path works.** `pathCarriesWhatIsSent(evidence, knownFailing)` is true for a receive path when bytes arrived. For a send path, at least one stream must be `delivered`, other sampled streams must be `delivered` or `quiet`, and no failures can remain after applying `failingStreamsAfter`. A camera that is still awaiting publish remains on that list even when the microphone arrives. `delivered` means the SFU's packet count for that producer grew. The reducer, the lifetime transport mark, the relay promotion, and both checks use this rule. Bytes sent and receiver reports can keep the stall clock off while nothing can be judged, but do not prove delivery on the current web and SFU.
7. **A transport has carried media only on that proof.** The mark is set by a sample that passes rule 6, or by `hasCarriedMedia`, which reads a transport's whole life with the same per-stream rule: bytes received on a receive transport, and for a send transport the SFU's count above zero for the streams being sent. The mark decides three things. A transport without it gets no ICE restart and goes straight to its rebuild. The relay reconciler never moves a transport that has it, and moves one without it onto the relay once TURN alone is wanted and usable credentials are held that it was not offered. A relay replaces the one kept as proven only when a sample on it passes rule 6 and its candidate pairs carried at least half of the bytes.
8. **A check may also find nothing to judge.** `checkPath` answers `carries` on rule 6. It answers `sends-nothing` when no sent stream moved a packet, none of them is known to be failing, signs of life are present and the transport has carried media before. Both answers leave the transport alone, but only `carries` is proof. An absent stream does not keep the watchdog timer running. It still remains on the failure list. Without `sends-nothing` a still screen share would be torn down after any pause in receiver reports, and a send rebuild publishes only the microphone and the camera again.
9. **The stall clock runs while a known failure is being sent.** A sample reads as flowing only when no stream on the list is among the streams being sent, and either a stream was delivered or the path shows signs of life.
10. **Directions are independent.** Each direction has its own sampling slot, and a direction's watch is reset only while its own failure is being handled.
11. **Unknown is not recovered.** After an ICE restart, growth on any watched consumer means media is expected. If no count grew and a watched consumer lacks either reading, `expectationAfterIceRestart` returns `unknown`, and `judgeIceRestart` treats that as not recovered. Zero is a readable count. The screen-share watch preserves each watched consumer's last readable count across a missing reply or an omitted entry.
12. **A queued Try again is spent only by the settlement.** `handleReconnect` no longer clears it when an automatic rejoin succeeds. `planReconnectSettlement` sees it and runs the full Try again.
13. **A one-direction rebuild names the transport it may replace.** The request carries its direction, transport ID, and reconnect generation. A replacement during credential refresh or the media check invalidates the scoped rebuild and the check's evidence. Only the path that owns a watchdog escalation starts or settles that escalation.

## Consequences

- A camera that keeps failing gets one rebuild and then the warning. The microphone is torn down once, not once per stall.
- The warning stays while the failing stream is muted, turned off or quiet. It clears when that stream is seen arriving, or after Try again once media is proven. A user who turns a blocked camera off still sees the warning, with Try again and dismiss.
- A direction can stay `recovering` for as long as its failing stream is not sent. `recovering` shows nothing to the user and tears nothing down.
- After a rebuild or a new watch, proof takes one sample longer, because a producer's first sample is `unconfirmed`.
- On an SFU that counts packets, proof needs the count replies. If they never come, a blocked direction stays blocked until Try again.
- On a browser that gives no `mid` on `outbound-rtp`, a stream is judged by the SFU's count alone: `delivered` when the count grows, `unconfirmed` otherwise.
- A Try again pressed during an automatic rejoin runs after that rejoin, so the call rejoins twice.
- A send path rebuilt without TURN that drops RTP moves onto the relay as soon as credentials are usable, whether or not it was already reported blocked. The move is one more teardown of that direction.
- A transport whose microphone arrives and whose camera does not has not carried what it sends. It gets no ICE restart on later stalls, and it is moved onto the relay when credentials return.
- A direction that is `recovering` or `blocked` while only a still screen share is sent stays that way until a frame of it is counted, or Try again. Receiver reports alone no longer clear it.
- A send path whose packets the SFU counts reads as flowing and proven even when no receiver report comes back.
- A relay move asks the SFU for one more packet count. If that reply is missing the move waits for the next reconcile, which runs on every watchdog sample.
- `media-path-recovery-model.test.ts` drives the real watch and the real reducer together through 5,000 seeded interleavings: path and per-stream drops, quiet streams, missing count replies, watch resets on the same transport, streams published late or turned off, held rebuilds, concurrent runs, Try again and leave. After every step the record must match a ledger of what happened. A direction leaves `blocked` or gets its rebuild back only on a sample the test's own rule calls proof. A direction is torn down at most once between proofs. In calm conditions every direction ends healthy or blocked within 40 rounds. Of eighteen mutations of the library, including each old behaviour, seventeen fail it in those 5,000 seeds. The other one (a send sample that judged no stream counts as proof) fails the 200,000-seed run, `RECOVERY_MODEL_EXTENDED=1`. All eighteen fail `media-path-recovery.test.ts`.
- `media-failure-evidence.test.tsx` and `media-recovery-state.test.tsx` run the reviewer's reproductions and the seeded property on the real hook through `call-rig.tsx`. The rig closes producers with their transport and publishes the microphone and camera again after a rebuild, as the app does.
- Since round 33 the model also has a path that sends packets and gets receiver reports back while nothing arrives, a still screen share alone on a send path, a ledger of what arrived on each transport, and the relay move check. A transport may be taken as having carried media only if something arrived on it, `hasCarriedMedia` must agree with what the SFU counted for each stream, and each check must give the answer the model's own rule gives. `media-delivery-proof.test.tsx` runs the round 33 reproductions on the real hook.
- Revisit if recovery gains a second concurrent run, since rule 1 relies on one run at a time.

## Alternatives considered

- **Keep writing at plan time and reset on each skipped exit:** rejected. This was the previous shape, and each review round found one more exit.
- **Release an escalation when its transport reports connected:** rejected. Connecting proves nothing about media, and ICE often stays connected through a media stall, so the release never came.
- **Let the watchdog keep sampling the direction being rebuilt:** rejected in round 30. Aggregate flow on the transport proved a camera that was not delivering.
- **Key known failures by producer id and clear them on a new transport:** rejected. A rebuild publishes new producers, so the list would be empty exactly when the rebuild has to prove itself, and the microphone published first would prove it.
- **Stop sampling a direction that holds a rebuild:** rejected. Under rule 5 a sample cannot drop a held rebuild without proof, and sampling lets real proof cancel a rebuild that is no longer needed.
- **Take a stream off the list when it stops being sent:** rejected. "Not sent yet after a rebuild" and "turned off" look the same to the watchdog, and mute then unmute would hand the rebuild back.
- **Mark a transport once any one stream was delivered:** rejected. A path that passes small audio packets and drops video would be marked, and the relay would never be tried for it once credentials came back.
- **Keep bytes sent and receiver reports inside `PathEvidence` as "reached":** rejected. Every reader had to remember that the field is not proof on a send path, and three of them did not.
- **Run the two-sample check in the relay reconciler instead of reading the transport's life:** rejected. A transport that carried media and then went quiet would read as never having carried any, and the rebuild that follows a move already runs the two-sample check.

## Code

- `apps/web/src/app/lib/media-path-recovery.ts`: `DirectionRecovery`, `SentStream`, `PathEvidence`, `judgeProducerDelivery`, `advanceProducerDeliveries`, `judgeDeliveryWindow`, `failingStreamsAfter`, `pathCarriesWhatIsSent`, `checkPath`, `hasCarriedMedia`, `pathShowsLife`, `advanceMediaPathWatch`, `advanceMediaPathRecovery`, `planMediaPathFailure`, `takeDeferredRebuilds`, `expectationAfterIceRestart`, `judgeIceRestart`
- `apps/web/src/app/lib/reconnect-request-policy.ts`: `planScopedRebuild`, `planReconnectSettlement`, `PathProbeResult`
- `apps/web/src/app/lib/relay-credentials.ts`: `reconcileRelayPaths`, `transportsToMoveOntoRelay`, `relayProvenByMedia`, `noteRelayCarryingMedia`
- `apps/web/src/app/hooks/useMeetSocket.ts`: `escalateMediaPathFailure`, `handleReconnect` (`noteEscalation`), `reconcileRelayPathsNow`, the media path watchdog effect (`noteDeliveryProof`, `readCarriedMediaRef`)
- `apps/web/test/media-path-recovery-model.test.ts`, `apps/web/test/media-failure-evidence.test.tsx`, `apps/web/test/media-recovery-state.test.tsx`, `apps/web/test/media-delivery-proof.test.tsx`, `apps/web/test/media-path-recovery.test.ts`
