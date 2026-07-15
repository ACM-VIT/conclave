import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArmSamplerExpression,
  buildBeginSamplerExpression,
  buildFixtureInjectionScript,
  buildStartSamplerExpression,
  buildStopSamplerExpression,
  calculatePresentedFrameDelta,
  calculateStrictCounterDelta,
  createSyntheticSourceLifecycle,
  getSyntheticCaptureReopenConstraint,
  normalizeMeasurementWindow,
  resolveSamplerBeginEvaluationTimeoutMs,
  resolveRollingMarkerSequence,
  resolveSyntheticVideoCaptureSettings,
} from "./browser-fixture.mjs";
import { assessReceiverCodecPerformance } from "./codec-performance.mjs";
import { buildAlignedWindowObservationTargets } from "./epoch-aligned-observer.mjs";

const measurementWindow = Object.freeze({
  version: 1,
  id: "shared-window-1",
  startedAtEpochMs: 10_000,
  endedAtEpochMs: 20_000,
  durationMs: 10_000,
});

const fixtureCapabilities = {
  defaultWidth: 1280,
  defaultHeight: 720,
  defaultFrameRate: 30,
  minWidth: 160,
  maxWidth: 1280,
  minHeight: 90,
  maxHeight: 720,
  minFrameRate: 1,
  maxFrameRate: 30,
};

test("fixture script contains deterministic camera and silent capture hooks", () => {
  const script = buildFixtureInjectionScript({
    enableSyntheticCamera: true,
    targetFps: 30,
    width: 1280,
    height: 720,
  });
  assert.match(script, /__conclaveQualityHarness/);
  assert.match(script, /canvas\.captureStream/);
  assert.match(script, /createMediaStreamDestination/);
  assert.match(script, /MARKER_REPETITIONS/);
  assert.match(script, /renderScaledFixtureFrame/);
  assert.match(script, /captureAtomicVideoSnapshot/);
  assert.match(script, /resetFixturePerformance/);
  assert.match(script, /getSourceLatencyEvidence/);
  assert.match(script, /MARKER_SEQUENCE_MODULUS = markerSequenceModulus/);
  assert.match(script, /sourceFrameTimeline/);
  assert.match(script, /performance-time-origin-before-request-frame/);
  assert.match(script, /metadata\?\.expectedDisplayTime/);
  assert.match(script, /const presentedAtMs = expectedDisplayTimeMs \?\? callbackAtMs/);
  assert.match(
    script,
    /const presentationGap = Math\.max\([\s\S]*?presentedAtMs - state\.lastPresentedAt/,
  );
  assert.match(script, /updateMarkerCadence\(state, marker, presentedAtMs\)/);
  assert.match(script, /timestampMode: selectedSource\.timestampMode/);
  assert.match(script, /runtime\.nextFixtureSourceSequence = 0/);
  assert.match(
    script,
    /sourceTimelineResetAtEpochMs: runtime\.fixtureTimelineResetAtEpochMs/,
  );
  assert.match(script, /fixture\.renderIntervals = \[\]/);
  assert.match(script, /jitterBufferEmittedCount/);
  assert.match(script, /jitterBufferTargetDelay/);
  assert.match(script, /jitterBufferMinimumDelay/);
  assert.match(script, /totalFreezesDuration/);
  assert.match(script, /await sender\.getStats\(\)/);
  assert.match(script, /stats: senderStats/);
  assert.match(script, /rtpSenderIds: new WeakMap\(\)/);
  assert.match(script, /actualContext\.drawImage\(snapshot/);
  assert.match(script, /Changing synthetic/);
  assert.doesNotMatch(script, /\.connect\(context\.destination\)/);
  assert.doesNotThrow(() => new Function(script));
});

test("synthetic microphone capture can be enabled without a synthetic camera", () => {
  const script = buildFixtureInjectionScript({
    enableSyntheticCamera: false,
    enableSyntheticAudio: true,
  });
  assert.match(script, /"enableSyntheticCamera":false/);
  assert.match(script, /"enableSyntheticAudio":true/);
  assert.match(script, /blocked a native microphone capture attempt/);
  assert.doesNotThrow(() => new Function(script));
});

test("cumulative latency evidence requires an exact monotonic baseline", () => {
  assert.deepEqual(calculateStrictCounterDelta(12, 10), {
    valid: true,
    reset: false,
    delta: 2,
  });
  assert.deepEqual(calculateStrictCounterDelta(2, undefined), {
    valid: false,
    reset: false,
    delta: null,
  });
  assert.deepEqual(calculateStrictCounterDelta(2, 5), {
    valid: false,
    reset: true,
    delta: null,
  });
});

test("rolling markers preserve full source generation across wrap", () => {
  assert.deepEqual(
    resolveRollingMarkerSequence({
      previousSourceSequence: 2_047,
      markerSequence: 0,
      elapsedSourceFrames: 2_048,
      modulus: 2_048,
    }),
    {
      valid: true,
      ambiguous: false,
      sourceSequence: 2_048,
      markerGeneration: 1,
    },
  );
  assert.deepEqual(
    resolveRollingMarkerSequence({
      previousSourceSequence: 152,
      markerSequence: 0,
      elapsedSourceFrames: 3,
      modulus: 2_048,
    }),
    {
      valid: true,
      ambiguous: true,
      sourceSequence: 0,
      markerGeneration: 0,
    },
  );
});

test("synthetic silent audio is the fail-safe default", () => {
  const script = buildFixtureInjectionScript({
    enableSyntheticCamera: false,
  });

  assert.match(script, /"enableSyntheticAudio":true/);
});

test("synthetic capture resolves the app camera profiles exactly", () => {
  const profiles = [
    [1280, 720, 30],
    [640, 360, 20],
    [426, 240, 12],
    [320, 180, 12],
  ];

  assert.deepEqual(
    resolveSyntheticVideoCaptureSettings(true, fixtureCapabilities),
    { width: 1280, height: 720, frameRate: 30 },
  );
  for (const [width, height, frameRate] of profiles) {
    assert.deepEqual(
      resolveSyntheticVideoCaptureSettings(
        {
          width: { ideal: width, max: width },
          height: { ideal: height, max: height },
          frameRate: { ideal: frameRate, max: frameRate },
        },
        fixtureCapabilities,
      ),
      { width, height, frameRate },
    );
  }
});

test("synthetic capture distinguishes ideals from mandatory constraints", () => {
  assert.deepEqual(
    resolveSyntheticVideoCaptureSettings(
      { width: 2000, height: { ideal: 1080 }, frameRate: 60 },
      fixtureCapabilities,
    ),
    { width: 1280, height: 720, frameRate: 30 },
  );
  assert.deepEqual(
    resolveSyntheticVideoCaptureSettings(
      {
        width: { max: 640 },
        height: { max: 360 },
        frameRate: { max: 20 },
      },
      fixtureCapabilities,
    ),
    { width: 640, height: 360, frameRate: 20 },
  );
  assert.deepEqual(
    resolveSyntheticVideoCaptureSettings(
      { width: { min: 640 }, height: { min: 360 } },
      {
        ...fixtureCapabilities,
        defaultWidth: 320,
        defaultHeight: 180,
      },
    ),
    { width: 640, height: 360, frameRate: 30 },
  );

  assert.throws(
    () =>
      resolveSyntheticVideoCaptureSettings(
        { width: { exact: 1920 } },
        fixtureCapabilities,
      ),
    (error) => error instanceof RangeError && error.constraint === "width",
  );
  assert.throws(
    () =>
      resolveSyntheticVideoCaptureSettings(
        { frameRate: { min: 25, max: 12 } },
        fixtureCapabilities,
      ),
    (error) => error instanceof RangeError && error.constraint === "frameRate",
  );
});

test("capture changes identify the property that must reopen the source", () => {
  const standard = { width: 1280, height: 720, frameRate: 30 };
  assert.equal(getSyntheticCaptureReopenConstraint(standard, standard), null);
  assert.equal(
    getSyntheticCaptureReopenConstraint(standard, {
      ...standard,
      width: 640,
    }),
    "width",
  );
  assert.equal(
    getSyntheticCaptureReopenConstraint(standard, {
      ...standard,
      frameRate: 20,
    }),
    "frameRate",
  );
});

test("synthetic source lifecycle reuses, replaces, and retires sources safely", () => {
  const created = [];
  const stopped = [];
  const lifecycle = createSyntheticSourceLifecycle({
    createSource(settings, { generation }) {
      const source = { generation, settings, live: true };
      created.push(source);
      return source;
    },
    stopSource(source) {
      source.live = false;
      stopped.push(source.generation);
    },
    isSourceLive: (source) => source.live,
    sourceKey: ({ width, height, frameRate }) =>
      `${width}x${height}@${frameRate}`,
  });
  const standard = { width: 1280, height: 720, frameRate: 30 };
  const poor = { width: 426, height: 240, frameRate: 15 };

  const first = lifecycle.acquire(standard);
  const effectsClone = first.retain();
  const sameSource = lifecycle.acquire(standard);
  assert.equal(created.length, 1);
  assert.equal(first.source, effectsClone.source);
  assert.equal(first.source, sameSource.source);
  assert.equal(lifecycle.snapshot().current.leaseCount, 3);

  first.release();
  const replacement = lifecycle.acquire(poor);
  assert.equal(created.length, 2);
  assert.equal(stopped.length, 0);
  assert.deepEqual(lifecycle.getCurrent().settings, poor);
  assert.equal(lifecycle.snapshot().openSourceCount, 2);

  effectsClone.release();
  assert.equal(stopped.length, 0);
  sameSource.release();
  assert.deepEqual(stopped, [1]);
  assert.equal(lifecycle.snapshot().openSourceCount, 1);

  const replacementClone = replacement.retain();
  replacement.release();
  assert.equal(stopped.length, 1);
  replacementClone.release();
  assert.deepEqual(stopped, [1, 2]);
  assert.deepEqual(lifecycle.snapshot(), {
    current: null,
    openSourceCount: 0,
    sources: [],
  });
});

test("fixture state can fall back to a still-live source after replacement rollback", () => {
  const stopped = [];
  const lifecycle = createSyntheticSourceLifecycle({
    createSource: (settings, { generation }) => ({
      generation,
      settings,
      live: true,
    }),
    stopSource(source) {
      source.live = false;
      stopped.push(source.generation);
    },
    isSourceLive: (source) => source.live,
  });
  const original = lifecycle.acquire({
    width: 1280,
    height: 720,
    frameRate: 30,
  });
  const replacement = lifecycle.acquire({
    width: 320,
    height: 180,
    frameRate: 12,
  });

  assert.equal(lifecycle.getLatestActive().generation, 2);
  replacement.release();
  assert.deepEqual(stopped, [2]);
  assert.equal(lifecycle.getLatestActive().generation, 1);
  assert.deepEqual(lifecycle.getLatestActive().settings, {
    width: 1280,
    height: 720,
    frameRate: 30,
  });
  original.release();
  assert.equal(lifecycle.getLatestActive(), null);
  assert.deepEqual(stopped, [2, 1]);
});

test("presented-frame deltas recover compositor frames missed by callbacks", () => {
  assert.equal(calculatePresentedFrameDelta(233, 229), 4);
  assert.equal(calculatePresentedFrameDelta(10, 10), 1);
  assert.equal(calculatePresentedFrameDelta(1, 900), 1);
  assert.equal(calculatePresentedFrameDelta(null, 10), 1);
});

test("sampler expressions use the installed harness API", () => {
  const defaultSampler = buildArmSamplerExpression({
    sampleIntervalMs: 250,
    targetTrackId: "consumer-final",
  });
  assert.match(defaultSampler, /targetTrackId: "consumer-final"/);
  assert.match(defaultSampler, /mode: "visual"/);
  assert.match(defaultSampler, /armSampler/);
  const telemetrySampler = buildStartSamplerExpression({
    mode: "telemetry",
    targetTrackId: "consumer-passive",
  });
  assert.match(telemetrySampler, /mode: "telemetry"/);
  const withSourceFixture = buildStartSamplerExpression({
    sampleIntervalMs: 250,
    sourceFixture: {
      width: 426,
      height: 240,
      fps: 15,
      sourceGeneration: 3,
      markerSequenceModulus: 2_048,
      active: true,
    },
  });
  assert.match(withSourceFixture, /"width":426/);
  assert.match(withSourceFixture, /"height":240/);
  assert.match(withSourceFixture, /"fps":15/);
  assert.match(withSourceFixture, /"markerSequenceModulus":2048/);
  const withBinding = buildStartSamplerExpression({
    targetTrackId: "consumer-final",
    mediaPathBinding: {
      producerId: "producer-final",
      consumerId: "consumer-final",
      connectionId: "pc-viewer",
      statId: "inbound-final",
      ssrc: 1234,
      codecMimeType: "video/VP9",
      frameWidth: 1280,
      frameHeight: 720,
      spatialLayer: 2,
      temporalLayer: 2,
    },
  });
  assert.match(withBinding, /"producerId":"producer-final"/);
  assert.match(withBinding, /"statId":"inbound-final"/);
  assert.match(withBinding, /"ssrc":"1234"/);
  const begin = buildBeginSamplerExpression(measurementWindow);
  const stop = buildStopSamplerExpression(measurementWindow);
  assert.match(begin, /beginSamplerWindow/);
  assert.match(begin, /"id":"shared-window-1"/);
  assert.match(stop, /stopSampler/);
  assert.match(stop, /"startedAtEpochMs":10000/);
});

test("samplers arm fully before a future shared epoch opens", () => {
  const source = buildFixtureInjectionScript();
  const armBody = source.slice(
    source.indexOf("async function armSampler"),
    source.indexOf("function finalizeCadence"),
  );
  const beginBody = source.slice(
    source.indexOf("async function beginSamplerWindow"),
    source.indexOf("function stopSampler"),
  );
  assert.match(armBody, /await Promise\.race[\s\S]*state\.armed = true/);
  assert.doesNotMatch(armBody, /scheduleFrameCallbacks\(state\)/);
  assert.match(beginBody, /await waitUntilEpoch\(measurementWindow\.startedAtEpochMs\)/);
  assert.match(beginBody, /scheduleFrameCallbacks\(state\)/);
  assert.ok(
    beginBody.indexOf("scheduleFrameCallbacks(state)") <
      beginBody.indexOf("state.statsStartPromise = collectPeerConnectionStats()"),
  );
  assert.match(beginBody, /armBoundMediaPathObservationSchedule/);
  assert.match(beginBody, /state\.statsStart = await state\.statsStartPromise/);
  assert.match(beginBody, /measurement-window-start-skew-exceeded/);
});

test("measurement-window builders reject shifted or internally inconsistent epochs", () => {
  assert.deepEqual(normalizeMeasurementWindow(measurementWindow), measurementWindow);
  assert.throws(
    () =>
      buildBeginSamplerExpression({
        ...measurementWindow,
        endedAtEpochMs: 20_500,
      }),
    /measurementWindow/,
  );
  assert.throws(
    () => buildStopSamplerExpression({ ...measurementWindow, id: "" }),
    /measurementWindow/,
  );
  assert.throws(
    () =>
      buildBeginSamplerExpression({
        ...measurementWindow,
        endedAtEpochMs: 20_600,
        durationMs: 10_600,
      }),
    /measurementWindow/,
  );
});

test("sampler begin evaluation timeout includes the future barrier lead", () => {
  assert.equal(
    resolveSamplerBeginEvaluationTimeoutMs(measurementWindow, 1_000),
    19_000,
  );
  assert.equal(
    resolveSamplerBeginEvaluationTimeoutMs(measurementWindow, 12_000),
    10_000,
  );
  assert.equal(
    resolveSamplerBeginEvaluationTimeoutMs(
      {
        ...measurementWindow,
        startedAtEpochMs: 16_000,
        endedAtEpochMs: 26_000,
      },
      1_000,
    ),
    25_000,
  );
  assert.throws(
    () => resolveSamplerBeginEvaluationTimeoutMs(measurementWindow, -1),
    /current epoch/,
  );
});

test("frame sampling rearms rVFC before dispatching worker analysis", () => {
  const source = buildFixtureInjectionScript();
  assert.match(
    source,
    /state\.frameCallbackId = null;\s*\/\/ Arm the next[\s\S]*?next\(\);\s*handleVideoFrame/,
  );
  assert.match(source, /new Worker/);
  assert.match(source, /dedicated-web-worker/);
  assert.match(
    source,
    /state\.nextVisualSampleAt \+=\s*elapsedScheduleSlots \* state\.sampleIntervalMs/,
  );
  assert.match(
    source,
    /p95FrameGapMs: round\(\s*nearestRankPercentile/,
  );
  assert.doesNotMatch(
    source,
    /state\.nextVisualSampleAt = callbackAtMs \+ state\.sampleIntervalMs/,
  );
});

test("telemetry mode retains cadence and exact-path evidence without visual workers", () => {
  const source = buildFixtureInjectionScript();
  assert.match(source, /state\.mode === "visual" && callbackAtMs/);
  assert.match(
    source,
    /mode === "visual" \? document\.createElement\("canvas"\) : null/,
  );
  assert.match(source, /if \(mode === "visual"\) \{\s*try \{\s*state\.metricWorker/);
  assert.match(source, /if \(state\.mode === "visual"\) await waitForMetricDrain/);
  assert.match(source, /disabled-telemetry-only/);
  assert.match(source, /decodeMarkerFromVideo\(state, state\.video\)/);
  assert.match(source, /appConnectionState/);
  assert.match(source, /peerConnectionState/);
  assert.match(source, /videoTrackReadyState/);
  assert.match(source, /frameObserverDurations/);
  assert.match(source, /frameObserverDutyRatio/);
  assert.match(source, /PATH_TERMINAL_LEAD_MS = 50/);
  assert.match(
    source,
    /MAX_PATH_TICK_LATENESS_MS = MAX_WINDOW_BOUNDARY_SKEW_MS/,
  );
  assert.match(source, /observedMaximumTickLatenessMs/);
  assert.match(source, /armBoundMediaPathObservationSchedule/);
  assert.match(source, /pathObservationTerminalPromise/);
  assert.match(source, /pathObservationBoundaryAuthority/);
  assert.match(
    source,
    /target\.phase === "terminal"[\s\S]*collectTerminalPeerConnectionStats\(state\)/,
  );
  assert.match(source, /state\.statsEndPromise \?\?= collectPeerConnectionStats/);
  assert.match(source, /if \(state\.stopPromise\) return state\.stopPromise/);
  assert.match(
    source,
    /state\.stopPromise = finalizeSamplerStop\(state, measurementWindow\)/,
  );
});

test("browser-aligned receiver evidence passes the real codec boundary validator", () => {
  const targets = buildAlignedWindowObservationTargets({
    measurementWindow,
    observationIntervalMs: 500,
    terminalLeadMs: 50,
  });
  const expected = {
    producerId: "producer-1",
    consumerId: "consumer-1",
    connectionId: "pc-viewer",
    statId: "inbound-1",
    ssrc: "222",
    codecMimeType: "video/vp9",
    codecId: "codec-1",
    codecPayloadType: 98,
    codecFmtpLine: "profile-id=0",
    scalabilityMode: "L2T1",
    decoderImplementation: "libvpx",
    powerEfficientDecoder: false,
  };
  const observations = targets.map((target, index) => ({
    ...expected,
    measurementWindowId: measurementWindow.id,
    matched: true,
    scheduledAtEpochMs: target.scheduledAtEpochMs,
    observationPhase: target.phase,
    capturedAtEpochMs: target.scheduledAtEpochMs + 20,
    sampledAtMs:
      target.scheduledAtEpochMs +
      20 -
      measurementWindow.startedAtEpochMs,
    framesDecoded: 1_000 + index * 15,
    totalDecodeTime: 2 + index * 0.045,
    qpSum: 25_000 + index * 375,
  }));
  const snapshot = {
    peerConnections: [
      {
        id: expected.connectionId,
        stats: [
          {
            id: expected.statId,
            type: "inbound-rtp",
            kind: "video",
            ssrc: 222,
            trackIdentifier: expected.consumerId,
            codecId: expected.codecId,
            scalabilityMode: expected.scalabilityMode,
            decoderImplementation: expected.decoderImplementation,
            powerEfficientDecoder: expected.powerEfficientDecoder,
          },
          {
            id: expected.codecId,
            type: "codec",
            mimeType: "video/VP9",
            payloadType: expected.codecPayloadType,
            sdpFmtpLine: expected.codecFmtpLine,
          },
        ],
      },
    ],
  };
  const result = assessReceiverCodecPerformance({
    label: "viewer",
    observations,
    binding: {
      valid: true,
      measurementWindowId: measurementWindow.id,
      observationIntervalMs: 500,
      observationCount: observations.length,
      observerMetadata: {
        valid: true,
        observationIntervalMs: 500,
        scheduledObservationCount: targets.length,
        completedObservationCount: observations.length,
        skippedTickCount: 0,
        lateTickCount: 0,
        overlapTickCount: 0,
        captureErrors: [],
        observerStartedAtEpochMs: measurementWindow.startedAtEpochMs,
        observerStoppedAtEpochMs: measurementWindow.endedAtEpochMs,
      },
      expected,
      observations,
    },
    measurementWindow,
    startSnapshot: snapshot,
    endSnapshot: snapshot,
    durationMs: measurementWindow.durationMs,
    limits: {
      maximumMeanMsPerFrame: 12,
      maximumP95MsPerFrame: 22,
      maximumMsPerFrame: 50,
    },
  });

  assert.equal(targets.at(-1).scheduledAtEpochMs, 19_950);
  assert.equal(observations[0].capturedAtEpochMs, 10_020);
  assert.equal(observations.at(-1).capturedAtEpochMs, 19_970);
  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
});

test("fixture builder rejects unsafe dimensions and cadence", () => {
  assert.throws(
    () => buildFixtureInjectionScript({ targetFps: 0 }),
    /targetFps/,
  );
  assert.throws(
    () => buildFixtureInjectionScript({ width: 100 }),
    /width/,
  );
  assert.throws(
    () => buildStartSamplerExpression({ sampleIntervalMs: 20 }),
    /sampleIntervalMs/,
  );
  assert.throws(
    () => buildStartSamplerExpression({ mode: "unknown" }),
    /mode/,
  );
  assert.throws(
    () =>
      buildStartSamplerExpression({
        sourceFixture: { width: 1280, height: 720, fps: 0 },
      }),
    /sourceFixture\.fps/,
  );
  assert.throws(
    () =>
      buildStartSamplerExpression({
        mediaPathBinding: { producerId: "only-one-field" },
      }),
    /mediaPathBinding/,
  );
  assert.throws(
    () => buildFixtureInjectionScript({ enableSyntheticAudio: "yes" }),
    /enableSyntheticAudio/,
  );
});

test("fixture snapshots serialize live sender parameters for codec proof", () => {
  const script = buildFixtureInjectionScript({
    enableSyntheticCamera: true,
    enableSyntheticAudio: true,
  });
  assert.match(script, /getSenders/);
  assert.match(script, /sender\.getParameters/);
  assert.match(script, /parametersError/);
  assert.match(script, /readyState/);
});
