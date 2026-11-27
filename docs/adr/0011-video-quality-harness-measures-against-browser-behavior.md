# 0011. The video quality harness measures against real browser behavior and calibrated floors

- Status: Accepted
- Date: 2026-11-22

## Context

`scripts/quality` drives headless Chrome publishers and receivers against a local SFU, samples presented frames with `requestVideoFrameCallback` (rVFC), reads `getStats`, shapes the network with CDP and scores the result. Chrome's timers, stats and callbacks have quirks that look like product failures if the harness takes them at face value, and the floors only mean something if they come from measured runs.

## Decision

Browser behavior the harness relies on:

- rVFC may coalesce notifications, and a busy sampler can miss callbacks, while `presentedFrames` shows the compositor kept presenting. Cadence gaps are normalized by `presentedFrames` unless the same source marker was seen repeating. Latency can only be joined for callbacks that ran, so callback matches set sample coverage, and temporal window coverage stops a sparse cluster from passing as a full-window distribution.
- Prefer `presentedFrames` over callback counts and decoder counters for decoded fps. rVFC sees what the compositor presented and `totalFreezesDuration` comes from the decoder, so freeze duration is the larger of the two.
- Chromium can keep zero-byte RTP placeholders marked `active`, or send a maintenance frame after an encoding is disabled. An encoding counts as live only when it is configured active and transmitting, while aggregate bandwidth counts every byte.
- Chromium rounds the nominal 426x240 low layer to 427x240.
- Chromium can briefly report the selected candidate pair as `in-progress` during a connectivity check while DTLS stays connected. That state counts as usable, and path identity, selection, transport state and advancing counters carry the proof.
- RTCStats ids are scoped to one peer connection, and Chrome reuses values such as `T01` in every browser process, so path ids are compared per endpoint.
- Chromium's outbound-rtp `bytesSent` is counted before the CDP upload queue, so the publisher's upload ceiling is proven from both receivers' fixed UDP paths instead.
- Timers can wake slightly early, and the transition ledger is bound to absolute epochs, so `sleepUntil` waits until the target epoch is really reached.
- The run establishes its full receiver topology before waiting for primary decode. Waiting first would leave a multi-receiver run at one receiver long enough to trigger the SFU's one-to-one producer handoff, so startup speed would decide which topology was measured.
- The visual metric toolkit keeps every dependency inside `createVisualMetricToolkit`, so its source can be serialized into `Page.addScriptToEvaluateOnNewDocument`.

Scoring and floors:

- The VP9 floor sits 0.60 points below the 89.10 to 89.80 band measured on exploratory runs, and the final contract needs five independent repetitions with harness-invalid runs rejected. The VP8 floor comes from stable runs at 88.82 to 88.89. A frozen, phase-incomplete 90.74 outlier was not used.
- SSIM and PSNR ceilings and the quality density target leave ranking headroom. The old .96 and 40 dB ceilings and the 0.48 density threshold scored visibly different VP8 and VP9 output the same once the atomic-frame sampler removed a comparison race.
- The three camera scenes weigh equally, so a callback stall that under-samples the hardest scene cannot make a damaged run look better.
- Crossing a product gate costs a fixed five points in the ranked score, so even a narrow miss shows after rounding, while severe misses stay bounded.

## Consequences

- A Chrome upgrade that changes any of these behaviors can invalidate runs, and the harness reports it as invalid rather than as a product regression.
- Lowering a floor needs new measured runs.

## Alternatives considered

- **Trusting callback counts or `bytesSent` directly:** rejected because both misreport under load or shaping.

## Code

- `scripts/quality/browser-fixture.mjs`: `handleVideoFrame`
- `scripts/quality/media-latency.mjs`: `summarizeCaptureToDisplayLatency`
- `scripts/quality/rtc-summary.mjs`
- `scripts/quality/dynamic-network-transition.mjs`: `selectedCandidatePairIsUsable`
- `scripts/quality/dynamic-network-runner.mjs`: `sleepUntil`
- `scripts/quality/run-headless-video-quality.mjs`
- `scripts/quality/profiles.mjs`
- `scripts/quality/scoring.mjs`: `linearScore`, `qualityDensityTarget`, `latencyScorePenalty`
- `scripts/quality/visual-metrics.mjs`: `createVisualMetricToolkit`
