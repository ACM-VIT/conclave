# Headless video-quality harness

This harness measures what a receiver actually decodes, rather than treating
WebRTC configuration as proof of quality. A publisher sends a deterministic
moving camera fixture through the real Conclave web client and mediasoup SFU.
A primary receiver compares decoded frames with the expected source and records
frame cadence plus raw WebRTC statistics. Up to three additional receivers run
continuous passive telemetry against the same publisher source. Every receiver
is independently bound, measured, and gated; only the primary pays the cost of
pixel-level visual analysis.
The camera workload combines repository-owned photographic meeting backgrounds
with deterministic face, hair, hand, exposure, pan, and low-light sensor motion;
the contract fingerprints every source asset.

Every browser is launched with `--headless=new` and `--mute-audio`. The page
also suppresses HTML media and Web Audio output and cancels/stubs Web Speech
synthesis. The harness never clicks
Unmute, so running it must not produce sound or claim the user's microphone.
Publisher and every receiver's microphone requests are served by synthetic
zero-valued tracks; any attempted native audio capture is blocked, audited, and
fails the run.

## Run

Start the local web and SFU services, then run:

```bash
pnpm quality:video:quick
pnpm quality:video
pnpm quality:video:compat
pnpm quality:video:asymmetric
pnpm quality:video:repeat
pnpm quality:video:compat:repeat
pnpm quality:video:transition
```

The quick command measures the pristine profile. The full command runs the
pristine, broadband, constrained, and poor matrix. Both use the `all-modern`
codec scenario and fail unless the live path is VP9 profile 0 with one exact
`L2T1` sender encoding. The compatibility command removes VP9 from the
headless viewer before application code loads, matching the active Skip-native
contract (send VP8; receive VP8/H.264), and proves that an existing VP9 publisher is
replaced by a working VP8 publisher within 15 seconds. Reports are written under
`artifacts/video-quality/` and include JSON, a readable Markdown scorecard,
and worst/p10/median/best decoded, reference, and difference frame triplets.

The asymmetric command keeps the publisher unthrottled while applying the poor
profile only to the viewer. It protects against optimizations that look healthy
from the sender but remove the low layer a constrained receiver needs. As with
every impaired run, it is marked `INVALID` unless WebRTC stats prove that the
requested downstream conditions were actually realized.

The repeat commands run three independent rooms and browser pairs, retain every
artifact, and report score, visual, FPS, bitrate, interval codec cost, and
process-CPU ranges. Repetitions are comparable only when every browser carries
the same non-sensitive hardware identity. Use them for codec or bitrate
decisions where a single run's scheduler variance would be too easy to mistake
for a product change.

`quality:video:transition` is the explicit schema-13 causal network run. It is
not part of the normal matrix and cannot accept matrix/native-compat settings:
it always uses all-modern VP9, UDP, one publisher, a primary visual receiver, a
pristine control receiver, one 103-second repetition, and a 450 ms visual
cadence. After all three joined pages and exact media paths stabilize, modern
flattened CDP sessions and product-consumed Network Information hints are armed
at least 15 seconds before one shared future epoch. No deprecated CDP fallback
is allowed.

The fixed schedule is:

- 0–12 s: every endpoint pristine.
- At 12 s: only the primary receiver changes to 140 ms latency, 380 kbps
  download, 9% loss, queue length 16, and reordering. Publisher and control
  remain pristine; a sustained two-second receiver-only downshift is required.
- At 24 s: the publisher changes to 140 ms latency, 220 kbps upload, 9% loss,
  queue length 16, and reordering. The primary remains impaired and the control
  remains pristine; the publisher/primary downshift must hold for two seconds.
- At 36 s: every impairment and poor hint is explicitly cleared. Good recovery
  must hold for three seconds by 46 s, and full 960×540@24, full-ladder/top-layer
  recovery must hold for three seconds by 91 s.
- 91–103 s: recovered visual score, compositor FPS, and capture-to-display p95
  are compared with the pristine 0–12 s phase.

One continuous 500 ms observation authority is reused: the exact publisher
sender observer plus the two already-bound receiver path observers. Every
checkpoint must retain the initial publisher sender and each receiver's exact
connection/stat/SSRC/consumer identity; an in-window producer, consumer, or RTP
path replacement invalidates the run. Visual-worker samples and
`requestVideoFrameCallback` presentations remain separate raw streams, and
camera timestamps are joined by source generation and source sequence. UDP
counter deltas use checkpoints strictly inside acknowledged mutation
boundaries (normally 0.5–11.5 s, 24.5–35.5 s, and 91.5–102.5 s), so a timer/CDP
race cannot dilute the measured impairment. Baselines are comparable only to
another valid schema-13 transition report with the same measurement contract,
runtime, Chrome, OS, and hardware identity.

Before scoring, warmup is bound to the final producer, consumer, codec, inbound
SSRC, decoded resolution, and preferred spatial layer. That exact path must stay
unchanged for four seconds and enough decoded frames; any replacement or layer
change resets the clock. Quick and compatibility runs sample the circular
360-frame fixture motion phase on a fixed cadence. A largest unsampled gap over
18 frames (less than 95% circular coverage) is a harness failure, so an
unusually easy slice cannot inflate the visual gate.

Every scored callback snapshots the decoded video exactly once. A compact
Manchester/SECDED marker requires two matching copies and carries a rolling
11-bit source sequence; full source generations are unwrapped across marker
rollover, while visual motion remains the circular 360-frame phase. Only the
marker's exact 2-D pixels are masked. Reference rendering and pixel analysis
run in a dedicated worker, while the main thread records its own p50/p95/max cost, duty, queue
depth, and skipped work. The run fails if the observer perturbs the media path.
Publisher source timing is reset at the exact measurement boundary. A source
render longer than one frame, a render interval over three frames, insufficient
source frames, or excessive missed deadlines makes the run `INVALID` instead
of mislabeling fixture or machine scheduling as a Conclave freeze.
High-end scoring gives each camera scene equal weight and retains per-scene
mean and worst-decile quality, so callback gaps cannot over-sample an easy
scene and intermittent damage remains visible instead of saturating at 100.
Every sample also compares motion-weighted pixels against
expected frames N-1 and N+1; frame N must win at least 98% of the time and the
p10 relative margin must remain positive.

Useful overrides:

```bash
pnpm quality:video -- --profile constrained --duration-ms 30000
pnpm quality:video -- --profile pristine --codec-scenario native-compat
pnpm quality:video -- --profile pristine --codec-scenario native-compat --receiver-count 2
pnpm quality:video -- --profile pristine --receiver-count 2 --receiver-profiles pristine,poor
pnpm quality:video -- --profile pristine --codec-scenario native-compat --require-udp
CONCLAVE_QUALITY_WEB_URL=http://localhost:3100 pnpm quality:video:quick
CONCLAVE_QUALITY_RECEIVER_COUNT=2 pnpm quality:video:compat
CONCLAVE_QUALITY_RECEIVER_PROFILES=pristine,poor CONCLAVE_QUALITY_RECEIVER_COUNT=2 pnpm quality:video:quick
CONCLAVE_QUALITY_REQUIRE_UDP=1 pnpm quality:video:compat
pnpm quality:video -- --profile broadband --baseline artifacts/video-quality/baseline/matrix.json
```

`--receiver-count` (or `CONCLAVE_QUALITY_RECEIVER_COUNT`) accepts 1–4 and
defaults to one. Every receiver is a separate `--headless=new`, `--mute-audio`,
page-silenced browser with synthetic zero-valued audio. `--receiver-profiles`
(or `CONCLAVE_QUALITY_RECEIVER_PROFILES`) accepts an ordered comma-separated
profile for every receiver. Its first value must match `--profile`, because
that receiver owns visual scoring; use an explicit single `--profile` for a
heterogeneous run such as `pristine,poor`. When omitted, the primary profile is
repeated for every receiver. The ordered list is stored in reports and baseline
compatibility, so assignments cannot silently swap.

All receivers stabilize against the final producer independently before the
window starts, then start and stop concurrently. The primary uses the visual
worker. Passive telemetry creates no metric worker or full-frame snapshot: it
uses `requestVideoFrameCallback`, reads only the compact source marker, and
samples the exact bound peer connection/inbound RTP stat/playout policy every
500 ms. Every receiver persists start/end RTC snapshots, producer/consumer/PC/
stat/SSRC/codec binding, joined/ICE/track continuity, resolution, presented and
decoded FPS, p95/maximum frame gaps, freezes, decoder drops, loss, jitter-buffer
average and interval p95, shared-source capture-to-display p95/maximum,
received bitrate, network realization, and capture-safety evidence. Missing or
sparse evidence makes that labeled receiver `INVALID`; quality-limit failures
make the run fail. A passive receiver can therefore never disappear behind a
healthy primary score.

Every exact Chrome instance also owns a second CDP connection to the browser
endpoint; page-target CDP is never treated as process authority. Immediately
around the concurrent measurement window, `SystemInfo.getProcessInfo` captures
the browser, renderer, GPU, and utility CPU counters. The same browser PID and
complete PID/type set must exist at both boundaries, every counter must be
monotonic, and the wall window must cover 90–120% of the requested duration.
Reports store total/per-type CPU seconds and sustained one-core equivalents.
Missing, stale, reset, type-changing, or process-churn evidence makes the run
`INVALID`. Primary visual-receiver CPU is clearly labeled because it includes
the visual observer; its page/worker duty remains a separate validity gate.

`SystemInfo.getInfo` binds reports to a non-sensitive hardware identity:
platform, architecture, logical CPU count, power-of-two memory bucket, GPU
device/driver identity, and exact Chrome version. Hostnames, usernames, model
serials, and Chrome command lines are not recorded. Baselines and repeated-run
ranges reject unlike or missing hardware identities rather than mixing machine
performance.

Native-compatible
VP8 has two distinct, fail-closed contracts. One receiver must prove that the
initial simulcast producer was replaced under a server lease, then remain on a
steady `single-layer` proof with one active RID-less 1,650 kbps / 30 fps sender
encoding. Two or more receivers must keep the same producer and the complete
80/220/1650 kbps three-layer adaptive simulcast ladder. Every configured and
live outbound VP8 encoding must report `L1T1`, and the exact bound receiver
must remain on temporal layer zero on adaptive simulcast paths. Evidence is bound to
the final producer's own RTP sender; stale peer-connection stats left behind by
a closed predecessor remain diagnostic and cannot be mistaken for live
encoders. Modern VP9 remains one SVC sender encoding. Receiver count is part of
runtime compatibility, so a baseline from a different topology is rejected
instead of producing a misleading delta.

`--require-udp` (or `CONCLAVE_QUALITY_REQUIRE_UDP=1`) makes the selected ICE
protocol a validity gate. Use it for authoritative codec/quality calibration;
transport-agnostic runs remain useful for TURN/TCP reliability testing but can
never be compared with a UDP-strict baseline.

## What is scored

- visual fidelity: true five-level MS-SSIM, BT.709 luma/chroma SSIM,
  PSNR/error, retained edges, and scale-aware blockiness across daylight,
  office-motion, and temporally correlated low-light portrait scenes
- motion: compositor-presented FPS, decoded FPS, exact decoder dropped-frame
  ratio, freezes, and independently gated nearest-rank p95/maximum visible-frame
  gap
- capture-to-display latency: every valid compositor callback joins its rolling
  marker sequence to the publisher timestamp captured immediately before
  `requestFrame()`. Reports gate nearest-rank p95 and maximum latency and fail
  closed on ambiguous wrap generation, source-generation mismatch, unavailable
  `expectedDisplayTime`, sparse coverage, negative samples, or clock anomalies
- efficiency: delivered visual-motion quality per Mbps and profile budget
- publisher bandwidth authority: topology ceilings are 1.75 Mbps for VP8
  true-single and VP9 SVC and 2.05 Mbps for VP8 three-layer simulcast. Every
  exact active layer is bound to its configured `maxBitrate` and may use at
  most `cap × 1.05 + 5 kbps`; missing cap/live-layer authority invalidates the
  run. Provisional hard quality-density floors are 0.50/0.40/0.45 quality/Mbps
  for VP8 true-single/VP8 simulcast/VP9 respectively
- codec performance: exact producer-bound outbound and every exact
  consumer-bound inbound RTP counter are sampled every 500 ms. Counter-safe
  `totalEncodeTime/framesEncoded` and `totalDecodeTime/framesDecoded` intervals
  report arithmetic mean, nearest-rank p95, and maximum ms/frame, so a spike
  cannot hide inside a healthy full-window average. Reports retain authoritative
  QP when present, implementation and power-efficient flags, and publisher
  quality-limitation reasons/durations including a hard CPU-limitation ratio
- process performance: per-Chrome total and process-type CPU seconds plus
  one-core equivalents, with topology-aware publisher, primary visual, and
  passive receiver ceilings
- reliability: joined state, packet loss, bounded receive playout delay, browser
  errors, and unexpected recoveries, independently for every receiver
- startup convergence: navigation to first decode and stable target resolution
- startup generation continuity: an authoritative versioned client audit must
  prove exactly one planned overlapping consumer replacement after top-layer
  VP8 simulcast convergence (and none on inapplicable paths). Independent
  `requestVideoFrameCallback` track evidence binds the old and replacement
  consumer IDs and gates their visible interruption at 250/250/400/700 ms for
  pristine/broadband/constrained/poor profiles, even though the replacement
  occurs before the normal measurement window
- measurement convergence: one continuously polled, unchanged final producer/
  consumer/codec/SSRC/resolution/layer path, phase-spanning deterministic motion
  phase, two-copy frame marker, frame-alignment canary, and bounded observer
  overhead
- codec correctness: actual receiver codec, sender codec parameters, active RTP
  encodings, VP9 SVC mode, and modern-to-native compatibility republishing

The synthetic camera honors the app's requested width, height, and frame rate,
so capture downshifts and reopen recovery are part of the measured path. Each
report records the actual publisher capture state and selected SFU origin (but
never its join token).

For throttled profiles, the runner also validates that latency, loss, and the
upload ceiling were actually observable in WebRTC stats. A profile is marked
`INVALID`, not passed or failed, when the named impairment was not realized
(for example when loopback ICE-TCP masks configured packet loss).

The profile gates are intentionally explicit and versioned in `profiles.mjs`.
Modern VP9 and native-compatible VP8 have separate pristine visual floors
because the phase-spanning benchmark measures a real codec-efficiency gap; both
retain the same resolution, cadence, freeze, reliability, and bandwidth scoring.
Receive jitter-buffer delay is a hard product gate, not a way to buy a smooth
score with hidden latency: both the full-window average and nearest-rank p95 of
bound 500 ms media-path intervals must stay within 70/85/150/230 ms per emitted
frame for pristine/broadband/constrained/poor runs respectively. At least 80%
of scheduled intervals, 90% measurement-window coverage, bounded poll gaps,
non-resetting exact start/end counters, and exact-bound requested/observed
target agreement are required. Missing or sparse evidence invalidates the
harness; an unsupported or ineffective client target fails the product gate.
Capture-to-display p95/maximum guards are currently conservative provisional
limits at 250/500, 300/600, 500/1000, and 900/1800 ms for pristine, broadband,
constrained, and poor. They are fail-safe ceilings, not final performance
targets; recalibrate them downward only from at least five valid schema-13
rooms per codec/profile. The rolling marker resets at the measurement boundary,
and its full source generation is unwrapped safely across the 2,048-sequence
cycle. A backwards/large jump is excluded as ambiguous, and any generation that
cannot be joined uniquely invalidates the latency evidence.
Each schema-13 report carries a SHA-256 measurement-contract ID covering the fixture,
metrics, scoring, calibration, and critical source files. Baseline comparison
is rejected when IDs differ. Floors must be calibrated from at least five
independent valid rooms per codec after any contract change; retain previous
reports rather than silently mixing incompatible evidence.

Detailed reports also state whether UDP was required, the selected ICE
transport, and the exact source-fixture window (elapsed time, rendered frames,
maximum render cost, maximum render interval, duty, and missed deadlines).
This keeps transport fallback or source scheduling stalls visible in every
verdict.

The runner detects Next.js development assets. Media convergence remains
scored there, but cold navigation time is informational because dev/HMR chunks
are not representative. Navigation-to-target is a hard gate on production
builds.

Visual comparisons use BT.709 luma/chroma and true five-scale MS-SSIM at a
maximum width of 640 pixels. Both the decoded frame and deterministic reference
are high-quality downsampled to the same raster, while chroma is filtered 2×
before comparison and marker masks are OR-pooled through every metric scale.
The resulting SSIM and PSNR are end-to-end fidelity measurements: they include
capture scaling, codec loss, and color conversion, while decoded resolution is
gated separately. `requestVideoFrameCallback` callback counts are diagnostic;
motion scoring prefers its monotonic `presentedFrames` counter, while visual
analysis runs off the page main thread and is independently load-gated.

Pass `--baseline` to turn a prior `matrix.json` into a regression gate. The
comparison fails on a material score, visual-fidelity, decoded-FPS, or freeze
regression. It also compares interval encode/decode mean, nearest-rank p95 and
maximum, CPU-limitation ratio, publisher/receiver process CPU, aggregate
bandwidth-budget utilization, and quality per Mbps. Candidate frontier work can
apply stricter limits to the persisted raw layer and topology metrics without
weakening the versioned product gates.
