# 0026. The join card hands live media to the in-call device reducer with one dispatch

- Status: Accepted
- Date: 2026-11-27

## Context

Two reviewed models for microphone and camera state met when staging was merged into PR #262.

PR #310, on staging, rebuilt the join card. Each `getUserMedia` request owns one capture slot per device kind. A newer choice releases the slot, and a superseded result may only stop its own tracks. `replacePreviewTracks` is the only writer of the preview stream and of what the microphone and camera buttons show. Join never waits for a capture: it cancels every slot and hands over the tracks that are live. Choices carried from a rejoin are read once per page and applied once.

PR #262 gave in-call media one owner. A reducer (`lib/device-intent.ts`) holds `{chosen, request, capturing}` for each device, `publishIntent` is the only source of what a join publishes, and one camera session (`lib/camera-session.ts`) runs every camera request. PR #262 also put its own join card on that reducer. There a button showed a choice as soon as it was pressed, and Join handed over the choice.

Both join cards cannot stay. Two owners of the same buttons is the fault both pull requests fixed. They also disagree on what Join hands over while a capture is pending: the choice (#262) or what is live (#310).

## Decision

The join card is #310's. The reducer and the camera session own media from the moment of Join. The two meet at one point, the prejoin handoff.

1. The card commits `{stream, isMicOn, isCameraOn, isAudioOnly, skipMutedMicWarmup}`, read from its live tracks.
2. `handlePrejoinMediaCommit` adopts those tracks as the call's stream and makes one `set` dispatch to the meeting's reducer. From then on the mute and camera state derive from the reducer, and the join publishes `publishIntent`.
3. `skipMutedMicWarmup` lives in one ref from the commit until the join succeeds or the connection is cleaned up. The join's media needs read it, so a join does not put a second microphone prompt behind a stalled one.
4. The card is a capture owner like any other. When a call releases its captures (a refused join, an ended call), the card cancels its slots and clears its preview through `replacePreviewTracks`.
5. Carried choices use one store (`lib/rejoin-intent.ts`, keyed by room and tenant). The end screen saves into it. `MeetsClient` reads it once per page and drops it when the card uses it or the call is joined.

## Consequences

- What the card shows, what it hands over and what the join publishes are one value at every step: live tracks, then one dispatch, then the reducer.
- A press on the card does not show as on while its permission prompt is pending, and a Join pressed during a pending capture joins with that device off. PR #262's "Starting camera" and "Camera turns on when you join" labels are gone with the state they described.
- After a refused join the card shows both devices off and a retry joins with them off. PR #262 alone kept the choice and reopened the devices on the retry.
- The reducer's join card helpers (`captureDevices`, `chooseDevice`, `handOffDevices`) and the link helpers `meetingTarget` and `parseMeetingInput` are deleted. The code field's `resolveCodeField` and `codeFieldTenant` carry the tenant rules.
- Revisit if the card should show a pending choice again. That needs a "chosen, not yet live" state in the card's single writer, not a second store.

## Alternatives considered

- **Keep PR #262's join card on the reducer:** rejected. It loses the zero-movement layout, the early Join and the restore rules that staging's tests pin.
- **Run the card's slots on the reducer:** rejected. The reducer marks a device chosen when a capture starts, and the card shows a device only once it is live. One store cannot say both. The slots also record who asked (a choice, a restore, the permission button), which the reducer has no place for.
- **Reopen the card's devices after a refused join:** rejected. It starts a capture nobody pressed for, right after entry was refused.

## Code

- `apps/web/src/app/components/JoinScreen.tsx`: `captureSlotsRef`, `replacePreviewTracks`, `settlePreviewForEntry`, `commitPrejoinMedia`, `dropReleasedPreview`
- `apps/web/src/app/meets-client.tsx`: `handlePrejoinMediaCommit`, `rejoinMedia`, `pageTenant`
- `apps/web/src/app/hooks/useMeetSocket.ts`: `getJoinMediaNeeds`, `resolveMediaPublishIntent`
- `apps/web/src/app/hooks/useMeetRefs.ts`: `deviceIntents`, `skipMutedMicWarmupRef`
- `apps/web/src/app/lib/device-intent.ts`, `apps/web/src/app/lib/camera-session.ts`, `apps/web/src/app/lib/rejoin-intent.ts`
- `apps/web/test/join-screen-rejoin-media.test.tsx`: the restore races, plus "shows both devices off, and joins with them off, once the call has released every capture" and "does not ask again for a permission request the call released while it was pending"
- `apps/web/test/device-intent-model.test.ts`: the seeded handoff, refusal, retry and late-result model
- `apps/web/test/meeting-shutdown.test.ts`: "does not reacquire a muted microphone after prejoin skips warmup"
