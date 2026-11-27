# 0016. Consumer handoff, transport connect and keyframe recovery

- Status: Accepted
- Date: 2026-11-22

## Context

A receiver can replace its server Consumer for a producer (a planned handoff), for example to reset startup jitter history. Consume acknowledgements can be lost, retries can arrive late, and signaling can repeat while DTLS is still connecting. Each of these, handled naively, has caused duplicate consumers, frozen tiles or leaks on the worker.

## Decision

Consumer handoff:

- Handoff request ids are replay fences for the lifetime of one socket-owned `Client`. Finished records stay as tombstones instead of being recycled, because accepting an old aborted id again would turn a delayed duplicate into a second consumer. The record ceiling (`MAX_CONSUMER_HANDOFF_RECORDS`) is high and fails closed.
- A successor consumer is provisional until its predecessor retires. If the successor closes during the overlap, the newest live predecessor is restored as current, so controls and telemetry bind to flowing media again.
- A client whose consume acknowledgement was lost cannot name the successor, so the server-side reservation is its authority. Abort changes media only while the reservation still owns the exact live producer generation and its exact predecessor can be restored.
- Each producer keeps at most `MAX_LIVE_CONSUMER_GENERATIONS` (three) live generations. Every consume re-arms the predecessors' retirement timers, so without a bound a client re-consuming faster than the retirement delay kept every generation alive. Restoration only uses the newest predecessor, so older ones close at once.

Transport connect:

- ICE can start DTLS before the signaling request supplies the peer fingerprint, so a `connecting` DTLS state does not prove `connect()` ran. Connect is idempotent on a recorded completion or a `connected` state only, and repeated signaling never connects the transport twice.

Keyframes:

- Webcam keyframe requests coalesce over 150 ms. A half-second window is visible as a frozen participant during layer or decoder recovery, while 150 ms still folds duplicate receiver requests into one encoder keyframe. Screen share keeps a one-second window, and socket fanout is rate limited separately.
- A paused mediasoup video Consumer requests its keyframe as part of `resume()`, so an explicit request in the same path only causes a duplicate encoder burst. Explicit requests are kept for consumers that are already flowing and need decoder recovery.

## Consequences

- Late or repeated signaling cannot create extra consumers or reconnect a transport.
- The handoff bookkeeping is spread across `Client`; changes need the handoff tests.

## Alternatives considered

- **Recycling handoff ids:** rejected because delayed duplicates would create consumers.
- **Treating `connecting` as connected:** rejected because ICE can start DTLS before connect.

## Code

- `packages/sfu/config/classes/Client.ts`: `reserveConsumerHandoff`, `abortConsumerHandoff`, `MAX_CONSUMER_HANDOFF_RECORDS`, `MAX_LIVE_CONSUMER_GENERATIONS`
- `packages/sfu/server/socket/transportConnect.ts`: `connectWebRtcTransportOnce`
- `packages/sfu/test/transport-connect.test.ts`
- `packages/sfu/server/mediaPolicy.ts`: `WEBCAM_KEY_FRAME_REQUEST_DELAY_MS`, `SCREEN_KEY_FRAME_REQUEST_DELAY_MS`, `shouldExplicitlyRequestConsumerKeyFrame`
