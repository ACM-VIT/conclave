import { DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION } from "./dynamic-network-transition.mjs";

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const mean = (values) => {
  const usable = values.map(finite).filter((value) => value !== null);
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
};

const minimum = (values) => {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length > 0 ? Math.min(...usable) : null;
};

const maximum = (values) => {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length > 0 ? Math.max(...usable) : null;
};

const aggregateProcessTypeCpu = (results, role) => {
  const resultMaps = results.map((result) => {
    const processes = (result.scoring?.performance?.browserProcesses ?? [])
      .filter((process) => process?.role === role);
    const types = new Set(
      processes.flatMap((process) =>
        Object.keys(process?.cpuSecondsByType ?? {}),
      ),
    );
    return Object.fromEntries(
      Array.from(types)
        .sort()
        .map((type) => [
          type,
          maximum(
            processes.map((process) => process?.cpuSecondsByType?.[type]),
          ),
        ]),
    );
  });
  const types = new Set(resultMaps.flatMap((entry) => Object.keys(entry)));
  return Object.fromEntries(
    Array.from(types)
      .sort()
      .map((type) => [type, mean(resultMaps.map((entry) => entry[type]))]),
  );
};

const deltaMaps = (current, baseline) =>
  Object.fromEntries(
    Array.from(
      new Set([
        ...Object.keys(current ?? {}),
        ...Object.keys(baseline ?? {}),
      ]),
    )
      .sort()
      .map((key) => [key, delta(current?.[key], baseline?.[key])]),
  );

const uniqueSorted = (values) =>
  Array.from(
    new Set(
      values.filter((value) => value !== null && value !== undefined),
    ),
  ).sort();

const aggregateDurationMaps = (results) => {
  const maps = results.map(
    (result) =>
      result.scoring?.performance?.publisher?.qualityLimitations
        ?.durationsSeconds ?? {},
  );
  const reasons = new Set(maps.flatMap((entry) => Object.keys(entry)));
  return Object.fromEntries(
    Array.from(reasons)
      .sort()
      .map((reason) => [reason, mean(maps.map((entry) => entry[reason]))]),
  );
};

const aggregatePublisherLayers = (results, field) => {
  const maps = results.map((result) =>
    Object.fromEntries(
      (result.scoring?.publisherBandwidth?.layers ?? []).map((layer) => [
        layer?.key,
        layer?.[field],
      ]),
    ),
  );
  const keys = new Set(maps.flatMap((entry) => Object.keys(entry)));
  return Object.fromEntries(
    Array.from(keys)
      .sort()
      .map((key) => [key, mean(maps.map((entry) => entry[key]))]),
  );
};

const delta = (current, baseline) => {
  const currentValue = finite(current);
  const baselineValue = finite(baseline);
  if (currentValue === null || baselineValue === null) return null;
  return round(currentValue - baselineValue);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const stableJson = (value) => JSON.stringify(canonicalize(value));

const isValidResult = (result) =>
  result?.valid === true && result?.scoring?.harnessValid === true;

const firstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null) ?? null;

const chromeIdentity = (report, result = null) => {
  const environment = result?.environment ?? {};
  const diagnostics = result?.browserDiagnostics ?? {};
  const reportEnvironment = report?.environment ?? {};
  const version = firstPresent(
    environment.chromeVersion,
    environment.browserVersion,
    environment.chrome?.version,
    environment.browser?.version,
    diagnostics.chromeVersion,
    diagnostics.browserVersion,
    result?.measurement?.environment?.chromeVersion,
    reportEnvironment.chromeVersion,
    reportEnvironment.browserVersion,
    reportEnvironment.chrome?.version,
    reportEnvironment.browser?.version,
    report?.chromeVersion,
    report?.browserVersion,
  );
  const explicitMajor = firstPresent(
    environment.chromeMajorVersion,
    environment.chromeMajor,
    environment.chrome?.major,
    diagnostics.chromeMajorVersion,
    reportEnvironment.chromeMajorVersion,
    reportEnvironment.chromeMajor,
    reportEnvironment.chrome?.major,
    report?.chromeMajorVersion,
    report?.chromeMajor,
  );
  const versionMatch =
    typeof version === "string"
      ? version.match(/(?:Chrome|Chromium)\/(\d+)|^(\d+)/)
      : null;
  const parsedMajor = versionMatch
    ? Number(versionMatch[1] ?? versionMatch[2])
    : null;
  const major =
    (explicitMajor === null ? null : finite(Number(explicitMajor))) ??
    finite(parsedMajor);
  if (version === null && major === null) return null;
  return canonicalize({
    major,
    version: version === null ? null : String(version),
  });
};

const reportRuntimeConfig = (report) =>
  canonicalize({
    runMode: firstPresent(
      report?.runMode,
      report?.environment?.runtimeParameters?.runMode,
    ),
    dynamicNetworkTransitionSchemaVersion: firstPresent(
      report?.dynamicNetworkTransitionSchemaVersion,
      report?.environment?.runtimeParameters
        ?.dynamicNetworkTransitionSchemaVersion,
    ),
    durationMs: report?.durationMs ?? null,
    warmupMs: report?.warmupMs ?? null,
    targetFps: report?.targetFps ?? null,
    sampleIntervalMs: report?.sampleIntervalMs ?? null,
    repetitions: firstPresent(
      report?.repetitions,
      report?.environment?.runtimeParameters?.repetitions,
    ),
    osRelease: firstPresent(
      report?.environment?.runtimeParameters?.osRelease,
      report?.environment?.osRelease,
      report?.osRelease,
    ),
    receiverCount: firstPresent(
      report?.receiverCount,
      report?.environment?.runtimeParameters?.receiverCount,
    ),
    requireUdp: firstPresent(
      report?.requireUdp,
      report?.environment?.runtimeParameters?.requireUdp,
    ),
    chrome: chromeIdentity(report),
    hardwareIdentityId: firstPresent(
      report?.environment?.hardwareIdentityId,
      report?.environment?.hardwareIdentity?.hardwareIdentityId,
      report?.hardwareIdentityId,
    ),
  });

const reportAuthorityFailures = (report, groups, side) => {
  const failures = [];
  const config = reportRuntimeConfig(report);
  for (const field of [
    "durationMs",
    "warmupMs",
    "targetFps",
    "sampleIntervalMs",
    "receiverCount",
    "repetitions",
  ]) {
    if (!Number.isFinite(config?.[field]) || config[field] <= 0) {
      failures.push(`${side} ${field} authority is missing`);
    }
  }
  if (typeof config?.requireUdp !== "boolean") {
    failures.push(`${side} UDP authority is missing`);
  }
  if (
    config?.runMode !== "steady-profile" &&
    config?.runMode !== "dynamic-network-transition"
  ) {
    failures.push(`${side} run-mode authority is missing or unsupported`);
  }
  if (
    config?.runMode === "dynamic-network-transition"
      ? config.dynamicNetworkTransitionSchemaVersion !==
        DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
      : config?.dynamicNetworkTransitionSchemaVersion !== null
  ) {
    failures.push(
      `${side} dynamic-network schema authority is missing or incompatible`,
    );
  }
  if (
    config?.runMode === "dynamic-network-transition" &&
    (config.durationMs !== 103_000 ||
      config.sampleIntervalMs !== 450 ||
      config.receiverCount !== 2 ||
      config.repetitions !== 1 ||
      config.requireUdp !== true)
  ) {
    failures.push(`${side} schema-13 transition runtime is not exact`);
  }
  if (
    !config?.chrome ||
    !Number.isFinite(config.chrome.major) ||
    typeof config.chrome.version !== "string" ||
    config.chrome.version.length === 0
  ) {
    failures.push(`${side} exact Chrome authority is missing`);
  }
  if (
    typeof config?.hardwareIdentityId !== "string" ||
    config.hardwareIdentityId.length === 0
  ) {
    failures.push(`${side} hardware identity authority is missing`);
  }
  if (typeof config?.osRelease !== "string" || config.osRelease.length === 0) {
    failures.push(`${side} OS release authority is missing`);
  }
  if (groups.size === 0) {
    failures.push(`${side} codec/profile groups are empty`);
  }
  const repetitions = Number(config?.repetitions);
  for (const [key, results] of groups) {
    const repetitionValues = results.map((result) => result?.repetition);
    const declaredRepetitions = results.map((result) => result?.repetitions);
    if (
      !Number.isInteger(repetitions) ||
      results.length !== repetitions ||
      results.some((result) => !isValidResult(result)) ||
      repetitionValues.some(
        (value) => !Number.isInteger(value) || value < 1 || value > repetitions,
      ) ||
      new Set(repetitionValues).size !== repetitions ||
      declaredRepetitions.some((value) => value !== repetitions)
    ) {
      failures.push(
        `${side} group ${key} does not contain exactly ${repetitions || "the required"} valid unique repetition(s)`,
      );
    }
    for (const result of results) {
      if (
        result?.runMode !== config.runMode ||
        result?.dynamicNetworkTransitionSchemaVersion !==
          config.dynamicNetworkTransitionSchemaVersion
      ) {
        failures.push(`${side} group ${key} run-mode/schema binding is stale`);
      }
      if (
        config.runMode === "dynamic-network-transition" &&
        (result?.measurement?.dynamicNetworkTransition?.schemaVersion !==
          DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION ||
          result?.measurement?.dynamicNetworkTransitionAssessment?.valid !==
            true)
      ) {
        failures.push(
          `${side} group ${key} schema-13 transition authority is invalid`,
        );
      }
    }
  }
  return failures;
};

const profileSettings = (profile) => {
  if (!profile || typeof profile !== "object") return null;
  const { description: _description, name: _name, ...settings } = profile;
  return canonicalize(settings);
};

const resultRuntimeConfig = (report, result) => {
  const profile = result?.profile ?? null;
  const receiverProfiles = firstPresent(
    result?.receiverProfiles,
    result?.measurement?.networkProfiles?.receivers,
    Array.isArray(result?.measurement?.receivers)
      ? result.measurement.receivers.map(
          (receiver) => receiver?.profile?.name ?? null,
        )
      : null,
    profile?.name ? [profile.name] : null,
  );
  return canonicalize({
    runMode: result?.runMode ?? report?.runMode ?? null,
    dynamicNetworkTransitionSchemaVersion:
      result?.dynamicNetworkTransitionSchemaVersion ??
      report?.dynamicNetworkTransitionSchemaVersion ??
      null,
    profileSettings: profileSettings(profile),
    devicePixelRatio: firstPresent(
      result?.measurement?.clientDebug?.renderedVideo?.devicePixelRatio,
      result?.environment?.devicePixelRatio,
      report?.environment?.devicePixelRatio,
      report?.requestedDevicePixelRatio,
      report?.devicePixelRatio,
      profile?.devicePixelRatio,
    ),
    publisherNetworkProfile: firstPresent(
      result?.measurement?.networkProfiles?.publisher,
      result?.environment?.publisherNetworkProfile,
      report?.publisherNetworkProfile,
      report?.requestedPublisherNetworkProfile,
      profile?.name,
    ),
    viewerNetworkProfile: firstPresent(
      result?.measurement?.networkProfiles?.viewer,
      result?.environment?.viewerNetworkProfile,
      profile?.name,
    ),
    receiverProfiles,
    chrome: chromeIdentity(report, result),
    hardwareIdentityId: firstPresent(
      result?.environment?.hardwareIdentityId,
      result?.environment?.hardwareIdentity?.hardwareIdentityId,
      result?.measurement?.performance?.hardwareIdentityId,
      report?.environment?.hardwareIdentityId,
      report?.environment?.hardwareIdentity?.hardwareIdentityId,
    ),
  });
};

const collectMismatches = (
  current,
  baseline,
  { scope, profile = null, codecScenario = null },
  path = "",
) => {
  if (stableJson(current) === stableJson(baseline)) return [];
  if (
    current &&
    baseline &&
    typeof current === "object" &&
    typeof baseline === "object" &&
    !Array.isArray(current) &&
    !Array.isArray(baseline)
  ) {
    const keys = Array.from(
      new Set([...Object.keys(current), ...Object.keys(baseline)]),
    ).sort();
    return keys.flatMap((key) =>
      collectMismatches(
        current[key],
        baseline[key],
        { scope, profile, codecScenario },
        path ? `${path}.${key}` : key,
      ),
    );
  }
  return [
    {
      scope,
      profile,
      codecScenario,
      parameter: path || "configuration",
      current: current ?? null,
      baseline: baseline ?? null,
    },
  ];
};

const comparisonKey = (report, result) => {
  const profileName = result?.profile?.name;
  const codecScenario =
    result?.codecScenario ?? report?.codecScenario ?? "unspecified";
  return profileName ? `${codecScenario}::${profileName}` : null;
};

const groupResults = (report) => {
  const groups = new Map();
  for (const result of report?.results ?? []) {
    const key = comparisonKey(report, result);
    if (!key) continue;
    const values = groups.get(key) ?? [];
    values.push(result);
    groups.set(key, values);
  }
  return groups;
};

const worstReceiverMetrics = (result) => {
  const receivers = Array.isArray(result?.measurement?.receivers)
    ? result.measurement.receivers
    : [];
  const metrics = receivers.map(
    (receiver) => receiver?.assessment?.metrics ?? {},
  );
  return {
    minimumDecodedFps: minimum(metrics.map((entry) => entry.decodedFps)),
    maximumFreezeRatio: maximum(metrics.map((entry) => entry.freezeRatio)),
    maximumP95FrameGapMs: maximum(
      metrics.map((entry) => entry.p95FrameGapMs),
    ),
    maximumFrameGapMs: maximum(
      metrics.map((entry) => entry.maximumFrameGapMs),
    ),
    maximumDroppedRatio: maximum(metrics.map((entry) => entry.droppedRatio)),
    maximumPacketLossRatio: maximum(
      metrics.map((entry) => entry.packetLossRatio),
    ),
    maximumJitterBufferP95Ms: maximum(
      metrics.map((entry) => entry.jitterBufferP95MsPerFrame),
    ),
    maximumCaptureToDisplayP95Ms: maximum(
      metrics.map((entry) => entry.captureToDisplayP95Ms),
    ),
    maximumCaptureToDisplayMs: maximum(
      metrics.map((entry) => entry.captureToDisplayMaximumMs),
    ),
    maximumBitrateBps: maximum(metrics.map((entry) => entry.bitrateBps)),
  };
};

const aggregateResults = (results) => {
  const valid = results.filter(isValidResult);
  const metric = (reader) => mean(valid.map(reader));
  const receiverWorst = valid.map(worstReceiverMetrics);
  const passedRuns = valid.filter((result) => result.scoring?.passed).length;
  return {
    totalRuns: results.length,
    validRuns: valid.length,
    invalidRuns: results.length - valid.length,
    passedRuns,
    passed: valid.length > 0 && passedRuns === valid.length,
    score: metric((result) => result.scoring?.score),
    visual: metric((result) => result.scoring?.visual?.score),
    decodedFps: metric((result) => result.scoring?.motion?.decodedFps),
    freezeRatio: metric((result) => result.scoring?.motion?.freezeRatio),
    jitterBufferDelayMsPerFrame: metric(
      (result) => result.scoring?.reliability?.jitterBufferDelayMsPerFrame,
    ),
    jitterBufferP95MsPerFrame: metric(
      (result) =>
        result.scoring?.reliability?.jitterBufferDelayIntervals?.p95MsPerFrame,
    ),
    captureToDisplayP95Ms: metric(
      (result) => result.scoring?.captureToDisplayLatency?.p95Ms,
    ),
    captureToDisplayMaximumMs: metric(
      (result) => result.scoring?.captureToDisplayLatency?.maximumMs,
    ),
    videoBitrateBps: metric(
      (result) => result.scoring?.efficiency?.averageVideoBitrateBps,
    ),
    qualityPerMbps: metric(
      (result) => result.scoring?.efficiency?.qualityPerMbps,
    ),
    navigationToTargetMs: metric(
      (result) => result.scoring?.startup?.navigationToTargetMs,
    ),
    receiverMinimumDecodedFps: mean(
      receiverWorst.map((entry) => entry.minimumDecodedFps),
    ),
    receiverMaximumFreezeRatio: mean(
      receiverWorst.map((entry) => entry.maximumFreezeRatio),
    ),
    receiverMaximumP95FrameGapMs: mean(
      receiverWorst.map((entry) => entry.maximumP95FrameGapMs),
    ),
    receiverMaximumFrameGapMs: mean(
      receiverWorst.map((entry) => entry.maximumFrameGapMs),
    ),
    receiverMaximumDroppedRatio: mean(
      receiverWorst.map((entry) => entry.maximumDroppedRatio),
    ),
    receiverMaximumPacketLossRatio: mean(
      receiverWorst.map((entry) => entry.maximumPacketLossRatio),
    ),
    receiverMaximumJitterBufferP95Ms: mean(
      receiverWorst.map((entry) => entry.maximumJitterBufferP95Ms),
    ),
    receiverMaximumCaptureToDisplayP95Ms: mean(
      receiverWorst.map((entry) => entry.maximumCaptureToDisplayP95Ms),
    ),
    receiverMaximumCaptureToDisplayMs: mean(
      receiverWorst.map((entry) => entry.maximumCaptureToDisplayMs),
    ),
    receiverMaximumBitrateBps: mean(
      receiverWorst.map((entry) => entry.maximumBitrateBps),
    ),
    publisherEncodeMeanMsPerFrame: metric(
      (result) =>
        result.scoring?.performance?.publisher?.timing
          ?.intervalMeanMsPerFrame,
    ),
    publisherEncodeP95MsPerFrame: metric(
      (result) =>
        result.scoring?.performance?.publisher?.timing
          ?.intervalP95MsPerFrame,
    ),
    publisherEncodeMaximumMsPerFrame: metric(
      (result) =>
        result.scoring?.performance?.publisher?.timing
          ?.intervalMaximumMsPerFrame,
    ),
    publisherCpuQualityLimitationRatio: metric(
      (result) =>
        result.scoring?.performance?.publisher?.qualityLimitations?.cpuRatio,
    ),
    publisherAverageQp: metric(
      (result) =>
        result.scoring?.performance?.publisher?.timing?.qp
          ?.fullWindowAverage,
    ),
    receiverMaximumAverageQp: metric((result) =>
      maximum(
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.timing?.qp?.fullWindowAverage,
        ),
      ),
    ),
    receiverDecodeMeanMsPerFrame: metric((result) =>
      maximum(
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.timing?.intervalMeanMsPerFrame,
        ),
      ),
    ),
    receiverDecodeP95MsPerFrame: metric((result) =>
      maximum(
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.timing?.intervalP95MsPerFrame,
        ),
      ),
    ),
    receiverDecodeMaximumMsPerFrame: metric((result) =>
      maximum(
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.timing?.intervalMaximumMsPerFrame,
        ),
      ),
    ),
    publisherProcessCoreEquivalents: metric(
      (result) =>
        result.scoring?.performance?.browserProcesses?.find(
          (process) => process?.role === "publisher",
        )?.coreEquivalents,
    ),
    primaryVisualProcessCoreEquivalents: metric(
      (result) =>
        result.scoring?.performance?.browserProcesses?.find(
          (process) => process?.role === "primary-visual-receiver",
        )?.coreEquivalents,
    ),
    passiveReceiverProcessCoreEquivalents: metric((result) =>
      maximum(
        (result.scoring?.performance?.browserProcesses ?? [])
          .filter(
            (process) => process?.role === "passive-telemetry-receiver",
          )
          .map((process) => process?.coreEquivalents),
      ),
    ),
    publisherAggregateBudgetUtilizationRatio: metric(
      (result) =>
        result.scoring?.publisherBandwidth
          ?.aggregateBudgetUtilizationRatio,
    ),
    publisherLayerBitrateBps: aggregatePublisherLayers(
      valid,
      "observedBitrateBps",
    ),
    publisherLayerCapUtilizationRatio: aggregatePublisherLayers(
      valid,
      "capUtilizationRatio",
    ),
    publisherProcessCpuSecondsByType: aggregateProcessTypeCpu(
      valid,
      "publisher",
    ),
    primaryVisualProcessCpuSecondsByType: aggregateProcessTypeCpu(
      valid,
      "primary-visual-receiver",
    ),
    passiveReceiverProcessCpuSecondsByType: aggregateProcessTypeCpu(
      valid,
      "passive-telemetry-receiver",
    ),
    publisherQualityLimitationDurationsSeconds:
      aggregateDurationMaps(valid),
    publisherEncoderImplementations: uniqueSorted(
      valid.flatMap(
        (result) =>
          result.scoring?.performance?.publisher?.metadata
            ?.implementations ?? [],
      ),
    ),
    receiverDecoderImplementations: uniqueSorted(
      valid.flatMap((result) =>
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.metadata?.decoderImplementation,
        ),
      ),
    ),
    publisherPowerEfficientFlags: uniqueSorted(
      valid.flatMap(
        (result) =>
          result.scoring?.performance?.publisher?.metadata?.powerEfficient ??
          [],
      ),
    ),
    receiverPowerEfficientFlags: uniqueSorted(
      valid.flatMap((result) =>
        (result.scoring?.performance?.receivers ?? []).map(
          (receiver) => receiver?.metadata?.powerEfficientDecoder,
        ),
      ),
    ),
  };
};

const incompatibleComparison = ({
  currentContractId,
  baselineContractId,
  measurementContracts = false,
  runtimeParameterMismatches = [],
}) => ({
  validComparison: false,
  comparableProfiles: 0,
  regressed: false,
  regressions: [],
  improvements: [],
  profiles: [],
  incompatibleComparison: true,
  incompatibleMeasurementContracts: measurementContracts,
  incompatibleRuntimeParameters: runtimeParameterMismatches.length > 0,
  runtimeParameterMismatches,
  incompatibilities: measurementContracts
    ? [
        {
          type: "measurement-contract",
          current: currentContractId,
          baseline: baselineContractId,
        },
      ]
    : runtimeParameterMismatches.map((mismatch) => ({
        type: "runtime-parameter",
        ...mismatch,
      })),
  currentMeasurementContractId: currentContractId,
  baselineMeasurementContractId: baselineContractId,
});

const runtimeMismatches = (
  currentReport,
  baselineReport,
  currentGroups,
  baselineGroups,
) => {
  const mismatches = collectMismatches(
    reportRuntimeConfig(currentReport),
    reportRuntimeConfig(baselineReport),
    { scope: "matrix" },
  );
  for (const key of Array.from(currentGroups.keys()).sort()) {
    if (!baselineGroups.has(key)) continue;
    const [codecScenario, profile] = key.split("::");
    const currentValidResults = currentGroups.get(key).filter(isValidResult);
    const baselineValidResults = baselineGroups.get(key).filter(isValidResult);
    if (currentValidResults.length === 0 || baselineValidResults.length === 0) {
      continue;
    }
    const currentConfigs = Array.from(
      new Map(
        currentValidResults.map((result) => {
          const config = resultRuntimeConfig(currentReport, result);
          return [stableJson(config), config];
        }),
      ).values(),
    );
    const baselineConfigs = Array.from(
      new Map(
        baselineValidResults.map((result) => {
          const config = resultRuntimeConfig(baselineReport, result);
          return [stableJson(config), config];
        }),
      ).values(),
    );
    if (currentConfigs.length !== 1 || baselineConfigs.length !== 1) {
      mismatches.push({
        scope: "profile",
        profile,
        codecScenario,
        parameter: "internallyConsistentRuntimeConfiguration",
        current: currentConfigs,
        baseline: baselineConfigs,
      });
      continue;
    }
    mismatches.push(
      ...collectMismatches(currentConfigs[0], baselineConfigs[0], {
        scope: "profile",
        profile,
        codecScenario,
      }),
    );
  }
  return mismatches;
};

export function compareQualityMatrices(currentReport, baselineReport) {
  const currentContractId = currentReport?.measurementContractId ?? null;
  const baselineContractId = baselineReport?.measurementContractId ?? null;
  if (
    !currentContractId ||
    !baselineContractId ||
    currentContractId !== baselineContractId
  ) {
    return incompatibleComparison({
      currentContractId,
      baselineContractId,
      measurementContracts: true,
    });
  }

  const currentGroups = groupResults(currentReport);
  const baselineGroups = groupResults(baselineReport);
  const currentGroupKeys = Array.from(currentGroups.keys()).sort();
  const baselineGroupKeys = Array.from(baselineGroups.keys()).sort();
  const authorityFailures = [
    ...reportAuthorityFailures(currentReport, currentGroups, "current"),
    ...reportAuthorityFailures(baselineReport, baselineGroups, "baseline"),
  ];
  if (stableJson(currentGroupKeys) !== stableJson(baselineGroupKeys)) {
    authorityFailures.push(
      `codec/profile group coverage differs: current ${stableJson(currentGroupKeys)}, baseline ${stableJson(baselineGroupKeys)}`,
    );
  }
  if (authorityFailures.length > 0) {
    return incompatibleComparison({
      currentContractId,
      baselineContractId,
      runtimeParameterMismatches: authorityFailures.map((failure) => ({
        scope: "matrix",
        profile: null,
        codecScenario: null,
        parameter: "comparisonAuthority",
        current: failure,
        baseline: null,
      })),
    });
  }
  const parameterMismatches = runtimeMismatches(
    currentReport,
    baselineReport,
    currentGroups,
    baselineGroups,
  );
  if (parameterMismatches.length > 0) {
    return incompatibleComparison({
      currentContractId,
      baselineContractId,
      runtimeParameterMismatches: parameterMismatches,
    });
  }

  const profiles = [];
  const regressions = [];
  const improvements = [];
  for (const key of Array.from(currentGroups.keys()).sort()) {
    const baselineResults = baselineGroups.get(key);
    if (!baselineResults) continue;
    const currentResults = currentGroups.get(key);
    const current = aggregateResults(currentResults);
    const baseline = aggregateResults(baselineResults);
    const [codecScenario, profileName] = key.split("::");
    if (current.validRuns === 0 || baseline.validRuns === 0) {
      profiles.push({
        profile: profileName,
        codecScenario,
        baselinePassed: baseline.passed,
        currentPassed: current.passed,
        baselineRuns: baseline,
        currentRuns: current,
        invalid: true,
        changes: {},
        regressions: [],
        improvements: [],
      });
      continue;
    }

    const changes = {
      score: delta(current.score, baseline.score),
      visual: delta(current.visual, baseline.visual),
      decodedFps: delta(current.decodedFps, baseline.decodedFps),
      freezeRatio: delta(current.freezeRatio, baseline.freezeRatio),
      jitterBufferDelayMsPerFrame: delta(
        current.jitterBufferDelayMsPerFrame,
        baseline.jitterBufferDelayMsPerFrame,
      ),
      jitterBufferP95MsPerFrame: delta(
        current.jitterBufferP95MsPerFrame,
        baseline.jitterBufferP95MsPerFrame,
      ),
      captureToDisplayP95Ms: delta(
        current.captureToDisplayP95Ms,
        baseline.captureToDisplayP95Ms,
      ),
      captureToDisplayMaximumMs: delta(
        current.captureToDisplayMaximumMs,
        baseline.captureToDisplayMaximumMs,
      ),
      videoBitrateBps: delta(
        current.videoBitrateBps,
        baseline.videoBitrateBps,
      ),
      videoBitrateRatio:
        finite(current.videoBitrateBps) !== null &&
        finite(baseline.videoBitrateBps) !== null &&
        baseline.videoBitrateBps > 0
          ? round(
              (current.videoBitrateBps - baseline.videoBitrateBps) /
                baseline.videoBitrateBps,
              4,
            )
          : null,
      qualityPerMbps: delta(current.qualityPerMbps, baseline.qualityPerMbps),
      navigationToTargetMs: delta(
        current.navigationToTargetMs,
        baseline.navigationToTargetMs,
      ),
      receiverMinimumDecodedFps: delta(
        current.receiverMinimumDecodedFps,
        baseline.receiverMinimumDecodedFps,
      ),
      receiverMaximumFreezeRatio: delta(
        current.receiverMaximumFreezeRatio,
        baseline.receiverMaximumFreezeRatio,
      ),
      receiverMaximumP95FrameGapMs: delta(
        current.receiverMaximumP95FrameGapMs,
        baseline.receiverMaximumP95FrameGapMs,
      ),
      receiverMaximumFrameGapMs: delta(
        current.receiverMaximumFrameGapMs,
        baseline.receiverMaximumFrameGapMs,
      ),
      receiverMaximumDroppedRatio: delta(
        current.receiverMaximumDroppedRatio,
        baseline.receiverMaximumDroppedRatio,
      ),
      receiverMaximumPacketLossRatio: delta(
        current.receiverMaximumPacketLossRatio,
        baseline.receiverMaximumPacketLossRatio,
      ),
      receiverMaximumJitterBufferP95Ms: delta(
        current.receiverMaximumJitterBufferP95Ms,
        baseline.receiverMaximumJitterBufferP95Ms,
      ),
      receiverMaximumCaptureToDisplayP95Ms: delta(
        current.receiverMaximumCaptureToDisplayP95Ms,
        baseline.receiverMaximumCaptureToDisplayP95Ms,
      ),
      receiverMaximumCaptureToDisplayMs: delta(
        current.receiverMaximumCaptureToDisplayMs,
        baseline.receiverMaximumCaptureToDisplayMs,
      ),
      receiverMaximumBitrateBps: delta(
        current.receiverMaximumBitrateBps,
        baseline.receiverMaximumBitrateBps,
      ),
      receiverMaximumBitrateRatio:
        finite(current.receiverMaximumBitrateBps) !== null &&
        finite(baseline.receiverMaximumBitrateBps) !== null &&
        baseline.receiverMaximumBitrateBps > 0
          ? round(
              (current.receiverMaximumBitrateBps -
                baseline.receiverMaximumBitrateBps) /
                baseline.receiverMaximumBitrateBps,
              4,
            )
          : null,
      publisherEncodeMeanMsPerFrame: delta(
        current.publisherEncodeMeanMsPerFrame,
        baseline.publisherEncodeMeanMsPerFrame,
      ),
      publisherEncodeP95MsPerFrame: delta(
        current.publisherEncodeP95MsPerFrame,
        baseline.publisherEncodeP95MsPerFrame,
      ),
      publisherEncodeMaximumMsPerFrame: delta(
        current.publisherEncodeMaximumMsPerFrame,
        baseline.publisherEncodeMaximumMsPerFrame,
      ),
      publisherCpuQualityLimitationRatio: delta(
        current.publisherCpuQualityLimitationRatio,
        baseline.publisherCpuQualityLimitationRatio,
      ),
      publisherAverageQp: delta(
        current.publisherAverageQp,
        baseline.publisherAverageQp,
      ),
      receiverMaximumAverageQp: delta(
        current.receiverMaximumAverageQp,
        baseline.receiverMaximumAverageQp,
      ),
      receiverDecodeMeanMsPerFrame: delta(
        current.receiverDecodeMeanMsPerFrame,
        baseline.receiverDecodeMeanMsPerFrame,
      ),
      receiverDecodeP95MsPerFrame: delta(
        current.receiverDecodeP95MsPerFrame,
        baseline.receiverDecodeP95MsPerFrame,
      ),
      receiverDecodeMaximumMsPerFrame: delta(
        current.receiverDecodeMaximumMsPerFrame,
        baseline.receiverDecodeMaximumMsPerFrame,
      ),
      publisherProcessCoreEquivalents: delta(
        current.publisherProcessCoreEquivalents,
        baseline.publisherProcessCoreEquivalents,
      ),
      primaryVisualProcessCoreEquivalents: delta(
        current.primaryVisualProcessCoreEquivalents,
        baseline.primaryVisualProcessCoreEquivalents,
      ),
      passiveReceiverProcessCoreEquivalents: delta(
        current.passiveReceiverProcessCoreEquivalents,
        baseline.passiveReceiverProcessCoreEquivalents,
      ),
      publisherAggregateBudgetUtilizationRatio: delta(
        current.publisherAggregateBudgetUtilizationRatio,
        baseline.publisherAggregateBudgetUtilizationRatio,
      ),
      publisherLayerBitrateBps: deltaMaps(
        current.publisherLayerBitrateBps,
        baseline.publisherLayerBitrateBps,
      ),
      publisherLayerCapUtilizationRatio: deltaMaps(
        current.publisherLayerCapUtilizationRatio,
        baseline.publisherLayerCapUtilizationRatio,
      ),
      publisherProcessCpuSecondsByType: deltaMaps(
        current.publisherProcessCpuSecondsByType,
        baseline.publisherProcessCpuSecondsByType,
      ),
      primaryVisualProcessCpuSecondsByType: deltaMaps(
        current.primaryVisualProcessCpuSecondsByType,
        baseline.primaryVisualProcessCpuSecondsByType,
      ),
      passiveReceiverProcessCpuSecondsByType: deltaMaps(
        current.passiveReceiverProcessCpuSecondsByType,
        baseline.passiveReceiverProcessCpuSecondsByType,
      ),
      publisherQualityLimitationDurationsSeconds: deltaMaps(
        current.publisherQualityLimitationDurationsSeconds,
        baseline.publisherQualityLimitationDurationsSeconds,
      ),
      codecMetadata: {
        publisherEncoderImplementations: {
          current: current.publisherEncoderImplementations,
          baseline: baseline.publisherEncoderImplementations,
        },
        receiverDecoderImplementations: {
          current: current.receiverDecoderImplementations,
          baseline: baseline.receiverDecoderImplementations,
        },
        publisherPowerEfficientFlags: {
          current: current.publisherPowerEfficientFlags,
          baseline: baseline.publisherPowerEfficientFlags,
        },
        receiverPowerEfficientFlags: {
          current: current.receiverPowerEfficientFlags,
          baseline: baseline.receiverPowerEfficientFlags,
        },
      },
    };
    const profileRegressions = [];
    const profileImprovements = [];
    const materialBitrateIncrease =
      (changes.videoBitrateBps ?? 0) >= 100_000 &&
      (changes.videoBitrateRatio ?? 0) >= 0.1;
    const materialQualityGain =
      (changes.score ?? Number.NEGATIVE_INFINITY) >= 1 ||
      (changes.visual ?? Number.NEGATIVE_INFINITY) >= 1 ||
      (changes.decodedFps ?? Number.NEGATIVE_INFINITY) >= 1 ||
      (changes.receiverMinimumDecodedFps ?? Number.NEGATIVE_INFINITY) >= 1;
    if (baseline.passed && !current.passed) {
      profileRegressions.push("passed baseline but failed current product gates");
    }
    if (changes.score !== null && changes.score <= -3) {
      profileRegressions.push(`score ${changes.score}`);
    }
    if (changes.visual !== null && changes.visual <= -3) {
      profileRegressions.push(`visual ${changes.visual}`);
    }
    if (changes.decodedFps !== null && changes.decodedFps <= -2) {
      profileRegressions.push(`decoded fps ${changes.decodedFps}`);
    }
    if (changes.freezeRatio !== null && changes.freezeRatio >= 0.01) {
      profileRegressions.push(`freeze ratio +${changes.freezeRatio}`);
    }
    if (
      changes.jitterBufferDelayMsPerFrame !== null &&
      changes.jitterBufferDelayMsPerFrame >= 10
    ) {
      profileRegressions.push(
        `jitter-buffer average +${changes.jitterBufferDelayMsPerFrame}ms`,
      );
    }
    if (
      changes.jitterBufferP95MsPerFrame !== null &&
      changes.jitterBufferP95MsPerFrame >= 10
    ) {
      profileRegressions.push(
        `jitter-buffer interval-average p95 +${changes.jitterBufferP95MsPerFrame}ms`,
      );
    }
    if (
      changes.captureToDisplayP95Ms !== null &&
      changes.captureToDisplayP95Ms >= 30
    ) {
      profileRegressions.push(
        `capture-to-display p95 +${changes.captureToDisplayP95Ms}ms`,
      );
    }
    if (
      changes.captureToDisplayMaximumMs !== null &&
      changes.captureToDisplayMaximumMs >= 75
    ) {
      profileRegressions.push(
        `capture-to-display maximum +${changes.captureToDisplayMaximumMs}ms`,
      );
    }
    if (
      changes.navigationToTargetMs !== null &&
      changes.navigationToTargetMs >= 1_000
    ) {
      profileRegressions.push(
        `navigation-to-target +${changes.navigationToTargetMs}ms`,
      );
    }
    if (
      changes.qualityPerMbps !== null &&
      changes.qualityPerMbps <= -0.05
    ) {
      profileRegressions.push(`quality/Mbps ${changes.qualityPerMbps}`);
    }
    for (const [field, threshold, label] of [
      ["publisherEncodeMeanMsPerFrame", 3, "publisher encode mean"],
      ["publisherEncodeP95MsPerFrame", 5, "publisher encode p95"],
      ["publisherEncodeMaximumMsPerFrame", 15, "publisher encode maximum"],
      ["receiverDecodeMeanMsPerFrame", 2, "worst receiver decode mean"],
      ["receiverDecodeP95MsPerFrame", 4, "worst receiver decode p95"],
      ["receiverDecodeMaximumMsPerFrame", 10, "worst receiver decode maximum"],
    ]) {
      if (changes[field] !== null && changes[field] >= threshold) {
        profileRegressions.push(`${label} +${changes[field]}ms/frame`);
      }
    }
    if (
      changes.publisherCpuQualityLimitationRatio !== null &&
      changes.publisherCpuQualityLimitationRatio >= 0.03
    ) {
      profileRegressions.push(
        `publisher CPU quality limitation +${changes.publisherCpuQualityLimitationRatio}`,
      );
    }
    for (const [field, threshold, label] of [
      ["publisherProcessCoreEquivalents", 0.25, "publisher process CPU"],
      [
        "primaryVisualProcessCoreEquivalents",
        0.5,
        "primary visual process CPU",
      ],
      [
        "passiveReceiverProcessCoreEquivalents",
        0.2,
        "passive receiver process CPU",
      ],
    ]) {
      if (changes[field] !== null && changes[field] >= threshold) {
        profileRegressions.push(`${label} +${changes[field]} cores`);
      }
    }
    if (
      changes.publisherAggregateBudgetUtilizationRatio !== null &&
      changes.publisherAggregateBudgetUtilizationRatio >= 0.05 &&
      !materialQualityGain
    ) {
      profileRegressions.push(
        `publisher aggregate budget utilization +${changes.publisherAggregateBudgetUtilizationRatio} without quality gain`,
      );
    }
    if (
      changes.receiverMinimumDecodedFps !== null &&
      changes.receiverMinimumDecodedFps <= -2
    ) {
      profileRegressions.push(
        `worst receiver decoded fps ${changes.receiverMinimumDecodedFps}`,
      );
    }
    if (
      changes.receiverMaximumFreezeRatio !== null &&
      changes.receiverMaximumFreezeRatio >= 0.01
    ) {
      profileRegressions.push(
        `worst receiver freeze ratio +${changes.receiverMaximumFreezeRatio}`,
      );
    }
    if (
      changes.receiverMaximumP95FrameGapMs !== null &&
      changes.receiverMaximumP95FrameGapMs >= 15
    ) {
      profileRegressions.push(
        `worst receiver p95 frame gap +${changes.receiverMaximumP95FrameGapMs}ms`,
      );
    }
    if (
      changes.receiverMaximumFrameGapMs !== null &&
      changes.receiverMaximumFrameGapMs >= 50
    ) {
      profileRegressions.push(
        `worst receiver maximum frame gap +${changes.receiverMaximumFrameGapMs}ms`,
      );
    }
    if (
      changes.receiverMaximumDroppedRatio !== null &&
      changes.receiverMaximumDroppedRatio >= 0.01
    ) {
      profileRegressions.push(
        `worst receiver dropped-frame ratio +${changes.receiverMaximumDroppedRatio}`,
      );
    }
    if (
      changes.receiverMaximumPacketLossRatio !== null &&
      changes.receiverMaximumPacketLossRatio >= 0.01
    ) {
      profileRegressions.push(
        `worst receiver packet-loss ratio +${changes.receiverMaximumPacketLossRatio}`,
      );
    }
    if (
      changes.receiverMaximumJitterBufferP95Ms !== null &&
      changes.receiverMaximumJitterBufferP95Ms >= 10
    ) {
      profileRegressions.push(
        `worst receiver jitter-buffer p95 +${changes.receiverMaximumJitterBufferP95Ms}ms`,
      );
    }
    if (
      changes.receiverMaximumCaptureToDisplayP95Ms !== null &&
      changes.receiverMaximumCaptureToDisplayP95Ms >= 30
    ) {
      profileRegressions.push(
        `worst receiver capture-to-display p95 +${changes.receiverMaximumCaptureToDisplayP95Ms}ms`,
      );
    }
    if (
      changes.receiverMaximumCaptureToDisplayMs !== null &&
      changes.receiverMaximumCaptureToDisplayMs >= 75
    ) {
      profileRegressions.push(
        `worst receiver capture-to-display maximum +${changes.receiverMaximumCaptureToDisplayMs}ms`,
      );
    }
    if (
      (changes.receiverMaximumBitrateBps ?? 0) >= 100_000 &&
      (changes.receiverMaximumBitrateRatio ?? 0) >= 0.1 &&
      !materialQualityGain
    ) {
      profileRegressions.push(
        `worst receiver bitrate +${round(changes.receiverMaximumBitrateBps / 1_000, 1)} kbps (+${round(changes.receiverMaximumBitrateRatio * 100, 1)}%) without quality gain`,
      );
    }
    if (materialBitrateIncrease && !materialQualityGain) {
      profileRegressions.push(
        `video bitrate +${round(changes.videoBitrateBps / 1_000, 1)} kbps (+${round(changes.videoBitrateRatio * 100, 1)}%) without quality gain`,
      );
    }
    if (changes.score !== null && changes.score >= 3) {
      profileImprovements.push(`score +${changes.score}`);
    }
    if (changes.visual !== null && changes.visual >= 3) {
      profileImprovements.push(`visual +${changes.visual}`);
    }
    if (changes.decodedFps !== null && changes.decodedFps >= 2) {
      profileImprovements.push(`decoded fps +${changes.decodedFps}`);
    }
    if (!baseline.passed && current.passed) {
      profileImprovements.push("failed baseline but passed current product gates");
    }
    if (
      changes.jitterBufferDelayMsPerFrame !== null &&
      changes.jitterBufferDelayMsPerFrame <= -10
    ) {
      profileImprovements.push(
        `jitter-buffer average ${changes.jitterBufferDelayMsPerFrame}ms`,
      );
    }
    if (
      changes.jitterBufferP95MsPerFrame !== null &&
      changes.jitterBufferP95MsPerFrame <= -10
    ) {
      profileImprovements.push(
        `jitter-buffer interval-average p95 ${changes.jitterBufferP95MsPerFrame}ms`,
      );
    }
    if (
      changes.captureToDisplayP95Ms !== null &&
      changes.captureToDisplayP95Ms <= -30
    ) {
      profileImprovements.push(
        `capture-to-display p95 ${changes.captureToDisplayP95Ms}ms`,
      );
    }
    if (
      changes.captureToDisplayMaximumMs !== null &&
      changes.captureToDisplayMaximumMs <= -75
    ) {
      profileImprovements.push(
        `capture-to-display maximum ${changes.captureToDisplayMaximumMs}ms`,
      );
    }
    if (
      changes.navigationToTargetMs !== null &&
      changes.navigationToTargetMs <= -1_000
    ) {
      profileImprovements.push(
        `navigation-to-target ${changes.navigationToTargetMs}ms`,
      );
    }
    if (
      changes.qualityPerMbps !== null &&
      changes.qualityPerMbps >= 0.05
    ) {
      profileImprovements.push(`quality/Mbps +${changes.qualityPerMbps}`);
    }
    for (const [field, threshold, label, unit] of [
      ["publisherEncodeP95MsPerFrame", -5, "publisher encode p95", "ms/frame"],
      ["receiverDecodeP95MsPerFrame", -4, "worst receiver decode p95", "ms/frame"],
      ["publisherProcessCoreEquivalents", -0.25, "publisher process CPU", "cores"],
      [
        "passiveReceiverProcessCoreEquivalents",
        -0.2,
        "passive receiver process CPU",
        "cores",
      ],
    ]) {
      if (changes[field] !== null && changes[field] <= threshold) {
        profileImprovements.push(`${label} ${changes[field]} ${unit}`);
      }
    }
    for (const regression of profileRegressions) {
      regressions.push(`${profileName}: ${regression}`);
    }
    for (const improvement of profileImprovements) {
      improvements.push(`${profileName}: ${improvement}`);
    }
    profiles.push({
      profile: profileName,
      codecScenario,
      baselinePassed: baseline.passed,
      currentPassed: current.passed,
      baselineRuns: baseline,
      currentRuns: current,
      changes,
      regressions: profileRegressions,
      improvements: profileImprovements,
    });
  }

  const comparableProfiles = profiles.filter(
    (profile) => profile.invalid !== true,
  ).length;
  return {
    validComparison: comparableProfiles > 0,
    comparableProfiles,
    regressed: regressions.length > 0,
    regressions,
    improvements,
    profiles,
    incompatibleComparison: false,
    incompatibleMeasurementContracts: false,
    incompatibleRuntimeParameters: false,
    runtimeParameterMismatches: [],
    incompatibilities: [],
    currentMeasurementContractId: currentContractId,
    baselineMeasurementContractId: baselineContractId,
  };
}
