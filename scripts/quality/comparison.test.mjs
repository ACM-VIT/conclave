import assert from "node:assert/strict";
import test from "node:test";
import { compareQualityMatrices } from "./comparison.mjs";

const result = ({
  score,
  visual,
  fps,
  freeze,
  bitrate,
  density,
  passed = true,
  jitterBufferAverage = 20,
  jitterBufferP95 = 25,
  captureToDisplayP95 = 140,
  captureToDisplayMaximum = 190,
  valid = true,
  profile = "pristine",
  codecScenario = null,
  devicePixelRatio = 2,
  publisherNetworkProfile = profile,
  chromeVersion = null,
  receiverProfiles = null,
  receiverMetrics = null,
  hardwareIdentityId = null,
  performance = null,
  repetition = 1,
  repetitions = 1,
  runMode = "steady-profile",
  dynamicNetworkTransitionSchemaVersion = null,
}) => ({
  valid,
  repetition,
  repetitions,
  runMode,
  dynamicNetworkTransitionSchemaVersion,
  profile: {
    name: profile,
    devicePixelRatio,
    targetVideoBitrateBps: 1_800_000,
    network: null,
  },
  codecScenario,
  receiverProfiles,
  environment: {
    ...(chromeVersion ? { chromeVersion } : {}),
    ...(hardwareIdentityId ? { hardwareIdentityId } : {}),
  },
  measurement: {
    clientDebug: {
      renderedVideo: { devicePixelRatio },
    },
    networkProfiles: {
      publisher: publisherNetworkProfile,
      viewer: profile,
      receivers: receiverProfiles,
    },
    receivers: Array.isArray(receiverMetrics)
      ? receiverMetrics.map((metrics, index) => ({
          label: index === 0 ? "viewer" : `viewer-${index + 1}`,
          profile: {
            name: receiverProfiles?.[index] ?? profile,
          },
          assessment: { metrics },
        }))
      : undefined,
  },
  scoring: {
    harnessValid: valid,
    passed,
    score,
    visual: { score: visual },
    motion: { decodedFps: fps, freezeRatio: freeze },
    efficiency: {
      averageVideoBitrateBps: bitrate,
      qualityPerMbps: density,
    },
    reliability: {
      jitterBufferDelayMsPerFrame: jitterBufferAverage,
      jitterBufferDelayIntervals: {
        p95MsPerFrame: jitterBufferP95,
      },
    },
    captureToDisplayLatency: {
      p95Ms: captureToDisplayP95,
      maximumMs: captureToDisplayMaximum,
    },
    performance,
  },
});

const report = ({
  score,
  visual,
  fps,
  freeze,
  bitrate,
  density,
  repetitions = 1,
  receiverCount = 1,
  requireUdp = false,
  osRelease = "24.5.0",
  chromeVersion = "Chrome/152.0.1.0",
  hardwareIdentityId = "hardware-default",
  runMode = "steady-profile",
  dynamicNetworkTransitionSchemaVersion = null,
  durationMs = 12_000,
  ...resultOverrides
}) => ({
  measurementContractId: "contract-v5",
  runMode,
  dynamicNetworkTransitionSchemaVersion,
  durationMs,
  warmupMs: 4_000,
  targetFps: 30,
  sampleIntervalMs: 450,
  repetitions,
  receiverCount,
  requireUdp,
  environment: {
    chromeVersion,
    hardwareIdentityId,
    osRelease,
    runtimeParameters: {
      repetitions,
      receiverCount,
      requireUdp,
      osRelease,
      runMode,
      dynamicNetworkTransitionSchemaVersion,
    },
  },
  results: [
    result({
      score,
      visual,
      fps,
      freeze,
      bitrate,
      density,
      repetitions,
      chromeVersion,
      hardwareIdentityId,
      runMode,
      dynamicNetworkTransitionSchemaVersion,
      ...resultOverrides,
    }),
  ],
});

test("comparison detects material regressions", () => {
  const comparison = compareQualityMatrices(
    report({
      score: 80,
      visual: 78,
      fps: 24,
      freeze: 0.03,
      bitrate: 1_200_000,
      density: 0.5,
    }),
    report({
      score: 90,
      visual: 88,
      fps: 29,
      freeze: 0,
      bitrate: 1_100_000,
      density: 0.6,
    }),
  );

  assert.equal(comparison.regressed, true);
  assert.ok(comparison.regressions.length >= 3);
});

test("comparison records efficiency and quality improvements", () => {
  const comparison = compareQualityMatrices(
    report({
      score: 93,
      visual: 92,
      fps: 30,
      freeze: 0,
      bitrate: 900_000,
      density: 0.8,
    }),
    report({
      score: 86,
      visual: 86,
      fps: 27,
      freeze: 0,
      bitrate: 1_400_000,
      density: 0.55,
    }),
  );

  assert.equal(comparison.regressed, false);
  assert.ok(comparison.improvements.length >= 3);
});

test("comparison rejects an invalid impairment run instead of averaging it away", () => {
  const current = report({
    score: 20,
    visual: 20,
    fps: 5,
    freeze: 0.5,
    bitrate: 100_000,
    density: 0.1,
  });
  current.results[0].valid = false;
  const baseline = report({
    score: 95,
    visual: 94,
    fps: 30,
    freeze: 0,
    bitrate: 1_200_000,
    density: 0.7,
  });

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.validComparison, false);
  assert.equal(comparison.comparableProfiles, 0);
  assert.equal(comparison.regressed, false);
  assert.deepEqual(comparison.profiles, []);
  assert.equal(comparison.incompatibleComparison, true);
  assert.ok(
    comparison.runtimeParameterMismatches.some(
      (mismatch) => mismatch.parameter === "comparisonAuthority",
    ),
  );
});

test("comparison never mixes codec scenarios", () => {
  const current = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 900_000,
    density: 0.7,
  });
  current.codecScenario = "all-modern";
  current.results[0].codecScenario = "all-modern";
  const baseline = structuredClone(current);
  baseline.codecScenario = "native-compat";
  baseline.results[0].codecScenario = "native-compat";

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.validComparison, false);
  assert.equal(comparison.comparableProfiles, 0);
  assert.deepEqual(comparison.profiles, []);
});

test("comparison requires exact schema-13 transition authority", () => {
  const dynamic = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 900_000,
    density: 0.7,
    runMode: "dynamic-network-transition",
    dynamicNetworkTransitionSchemaVersion: 13,
    durationMs: 103_000,
    receiverCount: 2,
    requireUdp: true,
    codecScenario: "all-modern",
  });
  let comparison = compareQualityMatrices(dynamic, structuredClone(dynamic));
  assert.equal(comparison.validComparison, false);
  assert.ok(
    comparison.runtimeParameterMismatches.some((mismatch) =>
      String(mismatch.current).includes("schema-13 transition authority"),
    ),
  );

  dynamic.results[0].measurement.dynamicNetworkTransition = {
    schemaVersion: 13,
  };
  dynamic.results[0].measurement.dynamicNetworkTransitionAssessment = {
    valid: true,
  };
  comparison = compareQualityMatrices(dynamic, structuredClone(dynamic));
  assert.equal(comparison.validComparison, true);
});

test("comparison rejects incompatible measurement contracts", () => {
  const current = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 900_000,
    density: 0.7,
  });
  const baseline = structuredClone(current);
  baseline.measurementContractId = "older-contract";

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.validComparison, false);
  assert.equal(comparison.comparableProfiles, 0);
  assert.equal(comparison.incompatibleMeasurementContracts, true);
  assert.equal(comparison.incompatibleComparison, true);
  assert.equal(comparison.incompatibilities[0].type, "measurement-contract");
});

test("comparison rejects different effective matrix runtime parameters", async (t) => {
  const base = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });
  for (const [parameter, currentValue] of [
    ["durationMs", 15_000],
    ["warmupMs", 5_000],
    ["targetFps", 60],
    ["sampleIntervalMs", 500],
  ]) {
    await t.test(parameter, () => {
      const current = structuredClone(base);
      current[parameter] = currentValue;
      const comparison = compareQualityMatrices(current, base);
      assert.equal(comparison.comparableProfiles, 0);
      assert.equal(comparison.incompatibleRuntimeParameters, true);
      assert.ok(
        comparison.runtimeParameterMismatches.some(
          (mismatch) => mismatch.parameter === parameter,
        ),
      );
    });
  }
});

test("comparison binds OS release and repetition count exactly", async (t) => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });

  await t.test("OS release", () => {
    const current = structuredClone(baseline);
    current.environment.osRelease = "26.0.0";
    current.environment.runtimeParameters.osRelease = "26.0.0";
    const comparison = compareQualityMatrices(current, baseline);
    assert.equal(comparison.validComparison, false);
    assert.ok(
      comparison.runtimeParameterMismatches.some(
        (mismatch) => mismatch.parameter === "osRelease",
      ),
    );
  });

  await t.test("repetitions", () => {
    const current = report({
      score: 90,
      visual: 90,
      fps: 30,
      freeze: 0,
      bitrate: 1_000_000,
      density: 0.7,
      repetitions: 2,
    });
    current.results.push(
      result({
        score: 90,
        visual: 90,
        fps: 30,
        freeze: 0,
        bitrate: 1_000_000,
        density: 0.7,
        repetition: 2,
        repetitions: 2,
      }),
    );
    const comparison = compareQualityMatrices(current, baseline);
    assert.equal(comparison.validComparison, false);
    assert.ok(
      comparison.runtimeParameterMismatches.some(
        (mismatch) => mismatch.parameter === "repetitions",
      ),
    );
  });
});

test("comparison rejects missing exact Chrome or hardware authority", async (t) => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });
  for (const [name, mutate, expected] of [
    [
      "Chrome",
      (candidate) => {
        delete candidate.environment.chromeVersion;
        delete candidate.results[0].environment.chromeVersion;
      },
      /Chrome authority is missing/,
    ],
    [
      "hardware",
      (candidate) => {
        delete candidate.environment.hardwareIdentityId;
        delete candidate.results[0].environment.hardwareIdentityId;
      },
      /hardware identity authority is missing/,
    ],
  ]) {
    await t.test(name, () => {
      const current = structuredClone(baseline);
      mutate(current);
      const comparison = compareQualityMatrices(current, baseline);
      assert.equal(comparison.validComparison, false);
      assert.ok(
        comparison.runtimeParameterMismatches.some((mismatch) =>
          expected.test(String(mismatch.current)),
        ),
      );
    });
  }
});

test("comparison rejects incomplete repetitions and unequal group coverage", async (t) => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });

  await t.test("incomplete repetitions", () => {
    const current = structuredClone(baseline);
    current.repetitions = 2;
    current.environment.runtimeParameters.repetitions = 2;
    current.results[0].repetitions = 2;
    const comparison = compareQualityMatrices(current, baseline);
    assert.equal(comparison.validComparison, false);
    assert.ok(
      comparison.runtimeParameterMismatches.some((mismatch) =>
        String(mismatch.current).includes(
          "does not contain exactly 2 valid unique repetition",
        ),
      ),
    );
  });

  await t.test("codec/profile group coverage", () => {
    const current = structuredClone(baseline);
    current.results.push(
      result({
        score: 90,
        visual: 90,
        fps: 30,
        freeze: 0,
        bitrate: 1_000_000,
        density: 0.7,
        profile: "poor",
      }),
    );
    const comparison = compareQualityMatrices(current, baseline);
    assert.equal(comparison.validComparison, false);
    assert.ok(
      comparison.runtimeParameterMismatches.some((mismatch) =>
        String(mismatch.current).includes("group coverage differs"),
      ),
    );
  });
});

test("comparison rejects a different receiver topology", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });
  const current = structuredClone(baseline);
  current.receiverCount = 2;
  current.environment = {
    ...current.environment,
    runtimeParameters: {
      ...current.environment.runtimeParameters,
      receiverCount: 2,
    },
  };

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.validComparison, false);
  assert.equal(comparison.comparableProfiles, 0);
  assert.equal(comparison.incompatibleRuntimeParameters, true);
  assert.ok(
    comparison.runtimeParameterMismatches.some(
      (mismatch) => mismatch.parameter === "receiverCount",
    ),
  );
});

test("comparison rejects different ordered receiver profile assignments", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    receiverProfiles: ["pristine", "poor"],
  });
  baseline.receiverCount = 2;
  baseline.environment.runtimeParameters.receiverCount = 2;
  const current = structuredClone(baseline);
  current.results[0].receiverProfiles = ["pristine", "constrained"];
  current.results[0].measurement.networkProfiles.receivers = [
    "pristine",
    "constrained",
  ];

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.comparableProfiles, 0);
  assert.equal(comparison.incompatibleRuntimeParameters, true);
  assert.ok(
    comparison.runtimeParameterMismatches.some((mismatch) =>
      mismatch.parameter.includes("receiverProfiles"),
    ),
  );
});

test("comparison catches a passive receiver regression with unchanged primary scoring", () => {
  const common = {
    score: 92,
    visual: 92,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    receiverProfiles: ["pristine", "poor"],
  };
  const healthy = {
    decodedFps: 30,
    freezeRatio: 0,
    p95FrameGapMs: 35,
    maximumFrameGapMs: 50,
    droppedRatio: 0,
    packetLossRatio: 0,
    jitterBufferP95MsPerFrame: 30,
    captureToDisplayP95Ms: 150,
    captureToDisplayMaximumMs: 200,
    bitrateBps: 900_000,
  };
  const baseline = report({
    ...common,
    receiverMetrics: [healthy, { ...healthy, decodedFps: 15 }],
  });
  baseline.receiverCount = 2;
  baseline.environment.runtimeParameters.receiverCount = 2;
  const current = report({
    ...common,
    receiverMetrics: [
      healthy,
      {
        ...healthy,
        decodedFps: 12,
        p95FrameGapMs: 55,
        jitterBufferP95MsPerFrame: 45,
      },
    ],
  });
  current.receiverCount = 2;
  current.environment.runtimeParameters.receiverCount = 2;

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.incompatibleRuntimeParameters, false);
  assert.equal(comparison.regressed, true);
  assert.ok(
    comparison.regressions.some((regression) =>
      regression.includes("worst receiver decoded fps"),
    ),
  );
  assert.ok(
    comparison.regressions.some((regression) =>
      regression.includes("worst receiver jitter-buffer p95"),
    ),
  );
});

test("comparison rejects legacy reports without explicit receiver-count authority", () => {
  const legacy = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });
  delete legacy.receiverCount;
  delete legacy.environment.runtimeParameters.receiverCount;
  const explicit = structuredClone(legacy);
  explicit.receiverCount = 1;
  explicit.environment = {
    ...explicit.environment,
    runtimeParameters: {
      ...explicit.environment.runtimeParameters,
      receiverCount: 1,
    },
  };

  const comparison = compareQualityMatrices(explicit, legacy);
  assert.equal(comparison.incompatibleRuntimeParameters, true);
  assert.equal(comparison.comparableProfiles, 0);
  assert.ok(
    comparison.runtimeParameterMismatches.some((mismatch) =>
      String(mismatch.current).includes("receiverCount authority is missing"),
    ),
  );
});

test("comparison never mixes UDP-strict and transport-agnostic runs", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
  });
  const current = structuredClone(baseline);
  current.requireUdp = true;
  current.environment = {
    ...current.environment,
    runtimeParameters: {
      ...current.environment.runtimeParameters,
      requireUdp: true,
    },
  };

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.comparableProfiles, 0);
  assert.equal(comparison.incompatibleRuntimeParameters, true);
  assert.ok(
    comparison.runtimeParameterMismatches.some(
      (mismatch) => mismatch.parameter === "requireUdp",
    ),
  );
});

test("comparison rejects different DPR, profile, publisher network, and Chrome settings", async (t) => {
  const base = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    chromeVersion: "Chrome/152.0.1.0",
  });
  const cases = [
    ["device pixel ratio", (current) => {
      current.results[0].measurement.clientDebug.renderedVideo.devicePixelRatio = 3;
    }, "devicePixelRatio"],
    ["profile settings", (current) => {
      current.results[0].profile.targetVideoBitrateBps = 2_000_000;
    }, "profileSettings.targetVideoBitrateBps"],
    ["publisher network", (current) => {
      current.results[0].measurement.networkProfiles.publisher = "poor";
    }, "publisherNetworkProfile"],
    ["Chrome version", (current) => {
      current.results[0].environment.chromeVersion = "Chrome/153.0.1.0";
    }, "chrome"],
  ];
  for (const [name, mutate, expectedParameter] of cases) {
    await t.test(name, () => {
      const current = structuredClone(base);
      mutate(current);
      const comparison = compareQualityMatrices(current, base);
      assert.equal(comparison.incompatibleRuntimeParameters, true);
      assert.ok(
        comparison.runtimeParameterMismatches.some((mismatch) =>
          mismatch.parameter.includes(expectedParameter),
        ),
      );
    });
  }
});

test("comparison aggregates valid repetitions once per codec and profile", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 28,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    codecScenario: "all-modern",
    repetitions: 2,
  });
  baseline.codecScenario = "all-modern";
  baseline.results.push(
    result({
      score: 92,
      visual: 92,
      fps: 30,
      freeze: 0,
      bitrate: 1_200_000,
      density: 0.7,
      codecScenario: "all-modern",
      repetition: 2,
      repetitions: 2,
    }),
  );
  const current = structuredClone(baseline);
  current.results = [
    result({
      score: 88,
      visual: 88,
      fps: 27,
      freeze: 0,
      bitrate: 1_000_000,
      density: 0.65,
      codecScenario: "all-modern",
      repetition: 1,
      repetitions: 2,
    }),
    result({
      score: 90,
      visual: 90,
      fps: 29,
      freeze: 0,
      bitrate: 1_200_000,
      density: 0.65,
      codecScenario: "all-modern",
      repetition: 2,
      repetitions: 2,
    }),
  ];

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.comparableProfiles, 1);
  assert.equal(comparison.profiles.length, 1);
  assert.equal(comparison.profiles[0].baselineRuns.validRuns, 2);
  assert.equal(comparison.profiles[0].currentRuns.validRuns, 2);
  assert.equal(comparison.profiles[0].currentRuns.invalidRuns, 0);
  assert.equal(comparison.profiles[0].changes.score, -2);
  assert.equal(comparison.profiles[0].changes.visual, -2);
});

test("comparison detects material quality-per-Mbps regression", () => {
  const comparison = compareQualityMatrices(
    report({
      score: 90,
      visual: 90,
      fps: 30,
      freeze: 0,
      bitrate: 1_000_000,
      density: 0.5,
    }),
    report({
      score: 90,
      visual: 90,
      fps: 30,
      freeze: 0,
      bitrate: 1_000_000,
      density: 0.6,
    }),
  );

  assert.equal(comparison.regressed, true);
  assert.ok(comparison.regressions.some((entry) => entry.includes("quality/Mbps")));
});

test("comparison detects a material bitrate increase without quality gain", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 29,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.6,
  });
  const current = report({
    score: 90,
    visual: 90,
    fps: 29,
    freeze: 0,
    bitrate: 1_300_000,
    density: 0.6,
  });
  const comparison = compareQualityMatrices(current, baseline);

  assert.equal(comparison.regressed, true);
  assert.ok(comparison.regressions.some((entry) => entry.includes("video bitrate")));

  current.results[0].scoring.visual.score = 92;
  const qualityGain = compareQualityMatrices(current, baseline);
  assert.equal(
    qualityGain.regressions.some((entry) => entry.includes("video bitrate")),
    false,
  );
});

test("comparison detects capture-to-display p95 and maximum regressions", () => {
  const current = report({
    score: 90,
    visual: 90,
    fps: 29,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    captureToDisplayP95: 180,
    captureToDisplayMaximum: 290,
  });
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 29,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    captureToDisplayP95: 140,
    captureToDisplayMaximum: 190,
  });

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.regressed, true);
  assert.match(comparison.regressions.join("\n"), /capture-to-display p95/);
  assert.match(
    comparison.regressions.join("\n"),
    /capture-to-display maximum/,
  );
});

test("comparison treats a pass-to-fail latency-only change as a regression", () => {
  const baseline = report({
    score: 94,
    visual: 92,
    fps: 30,
    freeze: 0,
    bitrate: 1_200_000,
    density: 0.7,
    passed: true,
    jitterBufferAverage: 20,
    jitterBufferP95: 25,
  });
  const current = report({
    score: 94,
    visual: 92,
    fps: 30,
    freeze: 0,
    bitrate: 1_200_000,
    density: 0.7,
    passed: false,
    jitterBufferAverage: 75,
    jitterBufferP95: 90,
  });

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.regressed, true);
  assert.ok(
    comparison.regressions.some((entry) =>
      entry.includes("passed baseline but failed current"),
    ),
  );
  assert.ok(
    comparison.regressions.some((entry) =>
      entry.includes("jitter-buffer interval-average p95"),
    ),
  );
});

test("comparison reports a material latency improvement while both runs pass", () => {
  const baseline = report({
    score: 94,
    visual: 92,
    fps: 30,
    freeze: 0,
    bitrate: 1_200_000,
    density: 0.7,
    jitterBufferAverage: 55,
    jitterBufferP95: 65,
  });
  const current = report({
    score: 94,
    visual: 92,
    fps: 30,
    freeze: 0,
    bitrate: 1_200_000,
    density: 0.7,
    jitterBufferAverage: 30,
    jitterBufferP95: 35,
  });

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.regressed, false);
  assert.ok(
    comparison.improvements.some((entry) =>
      entry.includes("jitter-buffer average"),
    ),
  );
});

test("comparison rejects unlike hardware even when Chrome and runtime match", () => {
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    hardwareIdentityId: "hardware-a",
  });
  baseline.environment.hardwareIdentityId = "hardware-a";
  const current = structuredClone(baseline);
  current.environment.hardwareIdentityId = "hardware-b";
  current.results[0].environment.hardwareIdentityId = "hardware-b";

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.incompatibleRuntimeParameters, true);
  assert.ok(
    comparison.runtimeParameterMismatches.some((mismatch) =>
      mismatch.parameter.includes("hardwareIdentityId"),
    ),
  );
});

test("comparison detects interval codec and process CPU regressions", () => {
  const performance = ({ encodeP95, decodeP95, publisherCpu }) => ({
    publisher: {
      timing: {
        intervalMeanMsPerFrame: 5,
        intervalP95MsPerFrame: encodeP95,
        intervalMaximumMsPerFrame: encodeP95 + 5,
      },
      qualityLimitations: { cpuRatio: 0 },
    },
    receivers: [
      {
        timing: {
          intervalMeanMsPerFrame: 3,
          intervalP95MsPerFrame: decodeP95,
          intervalMaximumMsPerFrame: decodeP95 + 5,
        },
      },
    ],
    browserProcesses: [
      {
        role: "publisher",
        coreEquivalents: publisherCpu,
      },
      {
        role: "primary-visual-receiver",
        coreEquivalents: 2,
      },
    ],
  });
  const baseline = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    performance: performance({
      encodeP95: 10,
      decodeP95: 8,
      publisherCpu: 1,
    }),
  });
  const current = report({
    score: 90,
    visual: 90,
    fps: 30,
    freeze: 0,
    bitrate: 1_000_000,
    density: 0.7,
    performance: performance({
      encodeP95: 17,
      decodeP95: 13,
      publisherCpu: 1.4,
    }),
  });

  const comparison = compareQualityMatrices(current, baseline);
  assert.equal(comparison.regressed, true);
  assert.match(comparison.regressions.join("\n"), /publisher encode p95/);
  assert.match(comparison.regressions.join("\n"), /receiver decode p95/);
  assert.match(comparison.regressions.join("\n"), /publisher process CPU/);
});
