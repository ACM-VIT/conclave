import assert from "node:assert/strict";
import test from "node:test";
import { buildMatrixMarkdown, buildRunMarkdown } from "./report.mjs";

const scoring = {
  passed: true,
  grade: "A",
  score: 95,
  visual: { score: 94, sceneScores: [] },
  motion: { score: 96, freezeRatio: 0 },
  efficiency: { score: 95 },
  reliability: {
    score: 100,
    packetLossRatio: 0,
    jitterBufferDelayMsPerFrame: 41.25,
    jitterBufferTargetDelayMsPerFrame: 40,
    jitterBufferMinimumDelayMsPerFrame: 12.5,
    jitterBufferDelayIntervals: {
      sampleCount: 20,
      p50MsPerFrame: 40,
      p95MsPerFrame: 48.75,
      maximumMsPerFrame: 52,
    },
    jitterBufferDelayIntervalCoverage: {
      observationIntervalMs: 500,
      coverageRatio: 0.98,
      maximumObservationIntervalMs: 510,
      maximumAllowedObservationIntervalMs: 1_250,
    },
    receiverPlayoutPolicyObservations: {
      observationCount: 21,
      evidenceCount: 21,
      authoritativeCount: 21,
      maximumRequestedTargetMs: 40,
    },
    worstJitterBufferLatencyMs: 48.75,
    jitterBufferLatencyScorePenalty: 0,
    maximumJitterBufferDelayMsPerFrame: 70,
    consoleErrorCount: 0,
  },
  startup: { transitions: [] },
  captureToDisplayLatency: {
    valid: true,
    matchedSampleCount: 350,
    presentationObservationCount: 357,
    markerSequenceModulus: 2_048,
    sourceMarkerGenerationCount: 1,
    ambiguousObservationCount: 0,
    sampleCoverageRatio: 0.98,
    presentedFrameSampleRatio: 0.96,
    windowCoverageRatio: 0.97,
    meanMs: 118.25,
    p50Ms: 116.5,
    p95Ms: 142.75,
    maximumMs: 188.5,
  },
  performance: {
    version: 1,
    hardwareIdentityId: "hardware-a",
    publisher: {
      timing: {
        intervalMeanMsPerFrame: 4,
        intervalP95MsPerFrame: 5,
        intervalMaximumMsPerFrame: 8,
        qp: { authority: "authoritative", fullWindowAverage: 31 },
      },
      metadata: {
        implementations: ["libvpx"],
        powerEfficient: [false],
      },
      qualityLimitations: {
        cpuRatio: 0.01,
        maximumCpuRatio: 0.05,
        durationsSeconds: { none: 9.9, cpu: 0.1 },
      },
    },
    receivers: [],
    browserProcesses: [
      {
        label: "publisher",
        role: "publisher",
        coreEquivalents: 1.25,
        p95CoreEquivalents: 1.75,
        maximumObservedCoreEquivalents: 2.25,
        maximumCoreEquivalents: 3,
        cpuSecondsByType: { browser: 1, renderer: 10 },
        coveredDurationMs: 10_000,
        coverageRatio: 1,
      },
      {
        label: "viewer",
        role: "primary-visual-receiver",
        coreEquivalents: 1.5,
        p95CoreEquivalents: 2,
        maximumObservedCoreEquivalents: 2.5,
        maximumCoreEquivalents: 5,
      },
    ],
  },
  publisherBandwidth: {
    topology: "vp8-true-single",
    aggregateBitrateBps: 1_600_000,
    aggregateBudgetUtilizationRatio: 0.9143,
    qualityPerMbps: 0.55,
    budget: {
      maximumAggregateBitrateBps: 1_750_000,
      minimumQualityPerMbps: 0.5,
    },
    layers: [
      {
        key: "single",
        observedBitrateBps: 1_600_000,
        configuredCapBps: 1_650_000,
        allowedBitrateBps: 1_737_500,
      },
    ],
  },
  failures: [],
  productFailures: [],
};

const result = {
  valid: true,
  codecScenario: "native-compat",
  receiverCount: 1,
  measurementContractId: "contract-v6",
  profile: {
    name: "pristine",
    description: "Reference path",
    maximumP95FrameGapMs: 50,
    maximumVisibleFrameGapMs: 150,
    maximumDroppedFrameRatio: 0.02,
    maximumCaptureToDisplayP95Ms: 250,
    maximumCaptureToDisplayMs: 500,
  },
  environment: {
    hardwareIdentityId: "hardware-a",
    hardwareIdentity: {
      platform: "darwin",
      architecture: "arm64",
      osRelease: "25.5.0",
      logicalCpuCount: 10,
      memoryBucketGiB: 32,
      gpu: {
        devices: [
          {
            vendorString: "Example GPU Vendor",
            deviceString: "Example Integrated GPU",
          },
        ],
      },
      chrome: { product: "Chrome/140.0.1.2" },
    },
    runtimeParameters: { requireUdp: true },
  },
  scoring,
  measurement: {
    codecNegotiation: { passed: true },
    cadence: { presentedFrameCount: 357 },
    rtc: { selectedCandidatePairProtocol: "udp" },
    receiverPlayoutPolicy: {
      evidencePresent: true,
      requestedTargetMs: 40,
      observedTargetMs: 40,
      status: "unchanged",
    },
    consumerGenerationReset: {
      expected: true,
      completedEntryCount: 1,
      visibleInterruptionMs: 84,
      firstDecodeThroughResetMaximumGapMs: 112,
      maximumVisibleInterruptionMs: 250,
    },
    startup: {
      frameContinuity: {
        presentedFrameCount: 400,
        consumerGenerationTransitions: [{}],
        longestPresentedFrameGapMs: 84,
      },
    },
    samplerOverhead: {
      pathObservationMs: { p95: 4.5, maximum: 6 },
      pathObservationDutyRatio: 0.01,
    },
    publisher: {
      fixture: {
        end: {
          performance: {
            elapsedMs: 12_345,
            renderedFrameCount: 371,
            renderDurationMs: { p95: 0.5, maximum: 0.9 },
            renderIntervalMs: { maximum: 36.2 },
            renderDutyRatio: 0.008,
            missedRenderDeadlines: 0,
          },
        },
      },
    },
  },
  artifacts: {},
  reproduceCommand: "pnpm quality:video:compat",
};

test("run report exposes transport strictness and exact source timing window", () => {
  const markdown = buildRunMarkdown(result);
  assert.match(markdown, /ICE transport: `udp` · UDP required/);
  assert.match(markdown, /12,?345\.0 ms, 371 rendered frames/);
  assert.match(markdown, /maximum render interval 36\.20 ms/);
  assert.match(
    markdown,
    /jitter-buffer full-window average \/ 500 ms interval-average p95 41\.25 \/ 48\.75 ms \(70 ms budget\)/,
  );
  assert.match(markdown, /target \/ network minimum: 40\.00 \/ 12\.50 ms/);
  assert.match(markdown, /Jitter-buffer evidence coverage: 98\.00%/);
  assert.match(
    markdown,
    /maximum latency-evidence observation gap 510\.00 \/ 1,?250\.00 ms/,
  );
  assert.match(markdown, /Jitter-buffer latency score penalty: 0\.00 points/);
  assert.match(markdown, /40 ms requested \/ 40 ms observed \(unchanged\)/);
  assert.match(markdown, /Continuous receiver-target authority: 21\/21/);
  assert.match(markdown, /Bound-path observer overhead: p95 \/ maximum 4\.50 \/ 6\.00 ms/);
  assert.match(
    markdown,
    /1 completed; old→new interruption 84\.0 ms; first-decode-through-reset maximum gap 112\.0 \/ 250\.0 ms/,
  );
  assert.match(markdown, /400 frames observed; 1 consumer transition/);
  assert.match(
    markdown,
    /Capture-to-display latency: mean \/ p50 \/ nearest-rank p95 \/ maximum 118\.25 \/ 116\.50 \/ 142\.75 \/ 188\.50 ms/,
  );
  assert.match(
    markdown,
    /350\/357 compositor callbacks \(98\.00%\), 96\.00% of presented frames sampled/,
  );
  assert.match(markdown, /generations 1, ambiguous joins 0/);
  assert.match(markdown, /## Compute and codec performance/);
  assert.match(markdown, /4\.00 \/ 5\.00 \/ 8\.00 ms encode\/frame/);
  assert.match(markdown, /avg \/ p95 \/ max 1\.250 \/ 1\.750 \/ 2\.250/);
  assert.match(markdown, /interval p95 \/ maximum 1\.750 \/ 2\.250 cores/);
  assert.match(markdown, /Continuous browser-level CDP process polling/);
  assert.match(markdown, /Publisher CPU quality limitation: 1\.00%/);
  assert.match(markdown, /Hardware identity: `hardware-a`/);
  assert.match(markdown, /OS release 25\.5\.0/);
  assert.match(markdown, /GPU Example GPU Vendor\/Example Integrated GPU/);
  assert.match(markdown, /## Publisher bandwidth authority/);
  assert.match(markdown, /vp8-true-single; aggregate 1600 kbps \/ 1750 kbps/);
  assert.match(markdown, /single 1600 kbps \/ 1650 kbps configured/);
});

test("matrix report exposes transport requirement and selected protocol", () => {
  const markdown = buildMatrixMarkdown({
    receiverCount: 1,
    requireUdp: true,
    codecScenario: "native-compat",
    summary: {
      passed: 1,
      total: 1,
      invalid: 0,
      averageScore: 95,
      minimumScore: 95,
    },
    repeatability: [],
    results: [result],
  });
  assert.match(markdown, /ICE transport requirement: UDP required/);
  assert.match(markdown, /\| pristine \| native-compat \| udp \| PASS \|/);
  assert.match(markdown, /\| 41\.3\/48\.8 ms \|/);
  assert.match(markdown, /\| 142\.8\/188\.5 ms \|/);
});

test("reports expose independently gated visual and passive receiver telemetry", () => {
  const allReceivers = structuredClone(result);
  allReceivers.receiverCount = 2;
  allReceivers.receiverProfiles = ["pristine", "poor"];
  allReceivers.scoring.receiverTelemetry = {
    expectedCount: 2,
    observedCount: 2,
    validCount: 2,
    passedCount: 2,
  };
  allReceivers.measurement.networkProfiles = {
    publisher: "pristine",
    viewer: "pristine",
    receivers: ["pristine", "poor"],
  };
  const receiver = ({ label, profile, mode, fps, bitrate }) => ({
    label,
    profile: { name: profile },
    mode,
    assessment: {
      valid: true,
      passed: true,
      metrics: {
        decodedFps: fps,
        p95FrameGapMs: 40,
        maximumFrameGapMs: 75,
        freezeRatio: 0,
        droppedRatio: 0.01,
        packetLossRatio: 0.02,
        jitterBufferDelayMsPerFrame: 30,
        jitterBufferP95MsPerFrame: 40,
        captureToDisplayP95Ms: 180,
        captureToDisplayMaximumMs: 240,
        bitrateBps: bitrate,
      },
    },
    binding: { valid: true },
    connection: { finalState: "joined" },
    renderedVideo: { width: 1280, height: 720 },
    peerConnectionStats: { start: {}, end: {} },
    sourceEvidenceReference:
      "measurement.publisher.fixture.captureToDisplaySource",
  });
  allReceivers.measurement.receivers = [
    receiver({
      label: "viewer",
      profile: "pristine",
      mode: "visual",
      fps: 30,
      bitrate: 1_600_000,
    }),
    receiver({
      label: "viewer-2",
      profile: "poor",
      mode: "telemetry",
      fps: 12,
      bitrate: 300_000,
    }),
  ];

  const runMarkdown = buildRunMarkdown(allReceivers);
  assert.match(runMarkdown, /## Receiver telemetry/);
  assert.match(runMarkdown, /\| viewer-2 \| poor \/ telemetry \| PASS \|/);
  assert.match(runMarkdown, /start→end/);
  assert.match(runMarkdown, /referenced by every receiver/);

  const matrixMarkdown = buildMatrixMarkdown({
    receiverCount: 2,
    requireUdp: true,
    codecScenario: "native-compat",
    summary: {
      passed: 1,
      total: 1,
      invalid: 0,
      averageScore: 95,
      minimumScore: 95,
    },
    repeatability: [],
    results: [allReceivers],
  });
  assert.match(matrixMarkdown, /Ordered receiver profiles: pristine, poor/);
  assert.match(matrixMarkdown, /\| 2\/2 pass \|/);
});

test("schema-13 report exposes staged causal transition authority", () => {
  const dynamic = structuredClone(result);
  dynamic.runMode = "dynamic-network-transition";
  dynamic.dynamicNetworkTransitionSchemaVersion = 13;
  dynamic.measurement.dynamicNetworkTransition = {
    schemaVersion: 13,
    controllerFailures: [],
    sampler: { checkpoints: Array.from({ length: 207 }) },
    networkRealization: {
      baseline: {
        counterStartScheduledOffsetMs: 500,
        counterEndScheduledOffsetMs: 11_500,
      },
      receiverLimited: {
        counterStartScheduledOffsetMs: 12_500,
        counterEndScheduledOffsetMs: 23_500,
      },
      publisherLimited: {
        counterStartScheduledOffsetMs: 24_500,
        counterEndScheduledOffsetMs: 35_500,
      },
      recovered: {
        counterStartScheduledOffsetMs: 91_500,
        counterEndScheduledOffsetMs: 102_500,
      },
    },
  };
  dynamic.measurement.dynamicNetworkTransitionAssessment = {
    valid: true,
    transitionProofs: {
      receiverIsolation: {
        passed: true,
        startOffsetMs: 14_000,
        endOffsetMs: 16_000,
      },
      downshift: {
        passed: true,
        startOffsetMs: 24_500,
        endOffsetMs: 26_500,
      },
      recoveryFull: {
        passed: true,
        startOffsetMs: 88_000,
        endOffsetMs: 91_000,
      },
    },
  };
  dynamic.reproduceCommand = "pnpm quality:video:transition";

  const markdown = buildRunMarkdown(dynamic);
  assert.match(markdown, /Dynamic network transition \(schema 13\)/);
  assert.match(markdown, /receiver-only impairment at 12 s/);
  assert.match(markdown, /207 synchronized 500 ms checkpoints/);
  assert.match(markdown, /receiver-limited 12500–23500 ms/);
  assert.match(markdown, /publisher-limited 24500–35500 ms/);
  assert.match(markdown, /RTT\/loss fields are diagnostic only/);
  assert.match(markdown, /fixed media paths/i);
});
