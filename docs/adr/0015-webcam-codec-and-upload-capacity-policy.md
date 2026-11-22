# 0015. Webcam codec and upload capacity policy

- Status: Accepted
- Date: 2026-11-22

## Context

The SFU picks one webcam codec per room from what every participant declares it can send and receive. VP8 simulcast gives receivers a small survival layer. VP9 L2T1 only offers a half-resolution floor layer, and the current H264 sender path is single-layer. Publishers on poor networks must keep audio and some video alive inside a tight upload budget.

## Decision

Codec selection:

- VP8 simulcast is the default because its small base layer keeps a weak viewer on video.
- VP9 is fail closed. It is used only when an operator enables it, every receiver declares profile 0 support and every potential publisher declares continuous L2T1 inter-layer prediction. A viewer whose bandwidth falls below the VP9 floor layer would otherwise receive no video at all.
- VP8 wins over H264 even when a client reports H264 as hardware accelerated, because the H264 path is single-layer and can force a constrained participant to decode the full stream. H264 stays the interoperability fallback when VP8 is really unavailable.
- Legacy clients predate capability negotiation and publish VP8. Never infer VP9 from router support or from another participant.
- A client's declared receive capabilities may only grow after join. A later update can refine an incomplete declaration but never remove support, so it cannot churn the room codec policy.

Upload capacity:

- Constrained producer transports carry an aggregate ingress ceiling that includes audio headroom. mediasoup's transport-wide bandwidth estimate then decides which VP8 RID fits, without asking Chromium for a live `RTCRtpSender.setParameters()` change.
- The emergency ceiling is 160 kbps, enough for the 80 kbps survival RID, a live Opus microphone, RTP and RTCP, and retransmissions. The earlier 105 kbps ceiling was only the sum of nominal payload caps. It starved protocol overhead, collapsed the sender estimate to about 60 kbps and made recovery pause every simulcast encoder.
- On the web, the microphone profile follows the publisher's own producer-transport bandwidth estimate, so it tracks the real uplink down and back up.

## Consequences

- Rooms stay on VP8 unless every participant proves VP9 support.
- Raising the survival layer bitrate needs the emergency ceiling raised with it.

## Alternatives considered

- **VP9 whenever the router supports it:** rejected because a single weak viewer loses video.
- **Hardware H264 by default:** rejected while the H264 path has no simulcast.

## Code

- `packages/sfu/server/webcamCodecPolicy.ts`: `selectRoomWebcamCodec`, `participantsSupportWebcamCodec`, `buildWebcamCodecPolicy`
- `packages/sfu/config/classes/Client.ts`: `updateMediaCapabilities`
- `packages/sfu/server/producerTransportNetworkProfile.ts`: `PRODUCER_TRANSPORT_EMERGENCY_MAX_INCOMING_BITRATE_BPS`, `getProducerTransportMaxIncomingBitrate`
- `apps/web/src/app/lib/microphone-send-estimate.ts`: `stepMicrophoneSendEstimate`
