export const DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION = 13;
export const DYNAMIC_NETWORK_TRANSITION_ASSESSMENT_VERSION = 1;
export const DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS = 500;
export const DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE = 0.9;
export const DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS = 750;
export const DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_SKEW_MS = 250;
export const DYNAMIC_NETWORK_TRANSITION_MAXIMUM_FRAME_SAMPLE_GAP_MS = 250;
export const DYNAMIC_NETWORK_TRANSITION_MAXIMUM_VISUAL_SAMPLE_GAP_MS = 750;
export const DYNAMIC_NETWORK_TRANSITION_WINDOW_MS = 103_000;
export const DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS = 15_000;

export const DYNAMIC_NETWORK_TRANSITION_ENDPOINTS = Object.freeze([
  "publisher",
  "primaryReceiver",
  "controlReceiver",
]);

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
};

const stableJson = (value) => JSON.stringify(stableValue(value));

const clone = (value) => JSON.parse(JSON.stringify(value));

const prefixFailures = (target, prefix, failures) => {
  for (const failure of failures) target.push(`${prefix}: ${failure}`);
};

const assessmentEnvelope = ({
  harnessFailures = [],
  productFailures = [],
  ...details
} = {}) => {
  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  const valid = uniqueHarnessFailures.length === 0;
  return {
    version: DYNAMIC_NETWORK_TRANSITION_ASSESSMENT_VERSION,
    valid,
    passed: valid && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    ...details,
  };
};

const ENDPOINT_SET = new Set(DYNAMIC_NETWORK_TRANSITION_ENDPOINTS);

const requireEndpoint = (endpoint) => {
  if (!ENDPOINT_SET.has(endpoint)) {
    throw new RangeError(
      `dynamic-network endpoint must be one of ${DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.join(
        ", ",
      )}`,
    );
  }
  return endpoint;
};

const PRISTINE_NETWORK_PROFILE = deepFreeze({
  latencyMs: 0,
  downloadKbps: null,
  uploadKbps: null,
  packetLossPercent: 0,
  packetQueueLength: 0,
  packetReordering: false,
  connectionType: "wifi",
});

export const DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES = deepFreeze({
  publisher: {
    latencyMs: 140,
    downloadKbps: 10_000,
    uploadKbps: 220,
    packetLossPercent: 9,
    packetQueueLength: 16,
    packetReordering: true,
    connectionType: "cellular3g",
  },
  primaryReceiver: {
    latencyMs: 140,
    downloadKbps: 380,
    uploadKbps: 1_000,
    packetLossPercent: 9,
    packetQueueLength: 16,
    packetReordering: true,
    connectionType: "cellular3g",
  },
});

export const DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN = deepFreeze({
  phases: {
    pristine: { startOffsetMs: 0, endOffsetMs: 12_000 },
    downshift: { startOffsetMs: 12_000, endOffsetMs: 24_000 },
    poor: { startOffsetMs: 24_000, endOffsetMs: 36_000 },
    recovery: { startOffsetMs: 36_000, endOffsetMs: 91_000 },
    recovered: { startOffsetMs: 91_000, endOffsetMs: 103_000 },
  },
  mutations: {
    applyPrimaryReceiverPoorAtOffsetMs: 12_000,
    applyPublisherPoorAtOffsetMs: 24_000,
    clearPoorAtOffsetMs: 36_000,
  },
  milestones: {
    receiverIsolation: {
      deadlineOffsetMs: 24_000,
      requiredSustainedMs: 2_000,
    },
    downshift: {
      deadlineOffsetMs: 36_000,
      requiredSustainedMs: 2_000,
    },
    recoveryGood: {
      deadlineOffsetMs: 46_000,
      requiredSustainedMs: 3_000,
    },
    recoveryFull: {
      deadlineOffsetMs: 91_000,
      requiredSustainedMs: 3_000,
    },
  },
  worstCaseDurationMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
});

export const DYNAMIC_NETWORK_TRANSITION_LIMITS = deepFreeze({
  downshiftVisibleGapMs: 700,
  recoveryVisibleGapMs: 250,
  recoveredVisualScoreDelta: 2,
  recoveredDecodedFpsDelta: 2,
  recoveredCaptureToDisplayP95DeltaMs: 50,
  minimumUsefulPacketCount: 50,
  minimumHealthyBitrateBps: 1_000_000,
  maximumImpairedCeilingRatio: 1.2,
  minimumImpairedCeilingRatio: 0.15,
  minimumPublisherFanoutRatio: 0.6,
  maximumPublisherFanoutRatio: 1.35,
  minimumPristineVisualScore: 88,
  minimumPristineDecodedFps: 24,
  maximumPristineCaptureToDisplayP95Ms: 250,
});

const expectedTopology = deepFreeze({
  publisherCount: 1,
  receiverCount: 2,
  endpoints: DYNAMIC_NETWORK_TRANSITION_ENDPOINTS,
  primaryReceiver: "primaryReceiver",
  pristineControlReceiver: "controlReceiver",
});

export function buildDynamicNetworkTransitionPlan({
  windowId,
  startedAtEpochMs,
} = {}) {
  const normalizedWindowId =
    typeof windowId === "string" ? windowId.trim() : "";
  if (!normalizedWindowId) {
    throw new TypeError("dynamic-network transition windowId is required");
  }
  if (finite(startedAtEpochMs) === null || startedAtEpochMs < 0) {
    throw new TypeError(
      "dynamic-network transition startedAtEpochMs must be non-negative",
    );
  }
  const endedAtEpochMs =
    startedAtEpochMs + DYNAMIC_NETWORK_TRANSITION_WINDOW_MS;
  return deepFreeze({
    schemaVersion: DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
    topology: expectedTopology,
    measurementWindow: {
      version: 1,
      id: normalizedWindowId,
      startedAtEpochMs,
      endedAtEpochMs,
      durationMs: DYNAMIC_NETWORK_TRANSITION_WINDOW_MS,
      immutable: true,
    },
    sampler: {
      mode: "one-continuous-immutable-window",
      checkpointIntervalMs:
        DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS,
      minimumCoverage: DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE,
      maximumCheckpointGapMs:
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS,
    },
    phasePlan: DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN,
    endpointProfiles: {
      publisher: {
        pristine: PRISTINE_NETWORK_PROFILE,
        poor: DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES.publisher,
      },
      primaryReceiver: {
        pristine: PRISTINE_NETWORK_PROFILE,
        poor: DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES.primaryReceiver,
      },
      controlReceiver: {
        pristine: PRISTINE_NETWORK_PROFILE,
        poor: PRISTINE_NETWORK_PROFILE,
      },
    },
    transportRequirement: "udp",
  });
}

const isExactTransitionPlan = (plan) => {
  try {
    const expected = buildDynamicNetworkTransitionPlan({
      windowId: plan?.measurementWindow?.id,
      startedAtEpochMs: plan?.measurementWindow?.startedAtEpochMs,
    });
    return stableJson(plan) === stableJson(expected);
  } catch {
    return false;
  }
};

export function buildDynamicNetworkCheckpointTargets(plan) {
  if (!isExactTransitionPlan(plan)) {
    throw new TypeError("an exact schema-13 dynamic-network plan is required");
  }
  const targets = [];
  for (
    let scheduledOffsetMs = 0;
    scheduledOffsetMs <= DYNAMIC_NETWORK_TRANSITION_WINDOW_MS;
    scheduledOffsetMs += DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS
  ) {
    targets.push(
      Object.freeze({
        index: targets.length,
        windowId: plan.measurementWindow.id,
        scheduledOffsetMs,
        scheduledAtEpochMs:
          plan.measurementWindow.startedAtEpochMs + scheduledOffsetMs,
      }),
    );
  }
  return Object.freeze(targets);
}

const throughputBytesPerSecond = (kbps) =>
  Math.max(1, Math.round((kbps * 1_000) / 8));

const pristineOverride = deepFreeze({
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: "wifi",
});

const poorOverride = (profile) => ({
  offline: false,
  latency: profile.latencyMs,
  downloadThroughput: throughputBytesPerSecond(profile.downloadKbps),
  uploadThroughput: throughputBytesPerSecond(profile.uploadKbps),
  connectionType: profile.connectionType,
});

const poorRule = (profile) => ({
  urlPattern: "",
  offline: false,
  latency: profile.latencyMs,
  downloadThroughput: throughputBytesPerSecond(profile.downloadKbps),
  uploadThroughput: throughputBytesPerSecond(profile.uploadKbps),
  connectionType: profile.connectionType,
  packetLoss: profile.packetLossPercent,
  packetQueueLength: profile.packetQueueLength,
  packetReordering: profile.packetReordering,
});

export function buildDynamicNetworkCdpMutation({
  endpoint,
  targetId,
  sessionId,
  state,
  scheduledAtOffsetMs,
} = {}) {
  const normalizedEndpoint = requireEndpoint(endpoint);
  const normalizedTargetId =
    typeof targetId === "string" ? targetId.trim() : "";
  if (!normalizedTargetId) {
    throw new TypeError("dynamic-network CDP targetId is required");
  }
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    throw new TypeError("dynamic-network CDP sessionId is required");
  }
  if (state !== "pristine" && state !== "poor") {
    throw new RangeError("dynamic-network CDP state must be pristine or poor");
  }
  if (state === "poor" && normalizedEndpoint === "controlReceiver") {
    throw new RangeError("the control receiver must remain pristine");
  }
  if (
    !Number.isInteger(scheduledAtOffsetMs) ||
    scheduledAtOffsetMs < 0 ||
    scheduledAtOffsetMs > DYNAMIC_NETWORK_TRANSITION_WINDOW_MS
  ) {
    throw new RangeError("dynamic-network CDP mutation offset is invalid");
  }
  const profile =
    state === "poor"
      ? DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES[normalizedEndpoint]
      : null;
  const ruleParameters = {
    offline: false,
    matchedNetworkConditions: profile ? [poorRule(profile)] : [],
  };
  const overrideParameters = profile
    ? poorOverride(profile)
    : pristineOverride;
  return deepFreeze({
    version: 1,
    id: `${scheduledAtOffsetMs}:${normalizedEndpoint}:${normalizedTargetId}:${normalizedSessionId}:${state}`,
    endpoint: normalizedEndpoint,
    targetId: normalizedTargetId,
    sessionId: normalizedSessionId,
    state,
    scheduledAtOffsetMs,
    commands: [
      {
        method: "Network.emulateNetworkConditionsByRule",
        params: ruleParameters,
      },
      {
        method: "Network.overrideNetworkState",
        params: overrideParameters,
      },
    ],
  });
}

export function buildDynamicNetworkCdpSchedule(
  plan,
  { targetIds, sessionIds } = {},
) {
  if (!isExactTransitionPlan(plan)) {
    throw new TypeError("an exact schema-13 dynamic-network plan is required");
  }
  const normalizedTargetIds = Object.fromEntries(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => {
      const targetId =
        typeof targetIds?.[endpoint] === "string"
          ? targetIds[endpoint].trim()
          : "";
      if (!targetId) {
        throw new TypeError(`CDP targetId is required for ${endpoint}`);
      }
      return [endpoint, targetId];
    }),
  );
  if (new Set(Object.values(normalizedTargetIds)).size !== 3) {
    throw new TypeError("publisher and receiver CDP targetIds must be unique");
  }
  const normalizedSessionIds = Object.fromEntries(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => {
      const sessionId =
        typeof sessionIds?.[endpoint] === "string"
          ? sessionIds[endpoint].trim()
          : "";
      if (!sessionId) {
        throw new TypeError(`CDP sessionId is required for ${endpoint}`);
      }
      return [endpoint, sessionId];
    }),
  );
  if (new Set(Object.values(normalizedSessionIds)).size !== 3) {
    throw new TypeError("publisher and receiver CDP sessionIds must be unique");
  }
  const applyReceiverAt =
    plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs;
  const applyPublisherAt =
    plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs;
  const clearAt = plan.phasePlan.mutations.clearPoorAtOffsetMs;
  const stages = [
    {
      scheduledAtOffsetMs: 0,
      states: {
        publisher: "pristine",
        primaryReceiver: "pristine",
        controlReceiver: "pristine",
      },
    },
    {
      scheduledAtOffsetMs: applyReceiverAt,
      states: {
        publisher: "pristine",
        primaryReceiver: "poor",
        controlReceiver: "pristine",
      },
    },
    {
      scheduledAtOffsetMs: applyPublisherAt,
      states: {
        publisher: "poor",
        primaryReceiver: "poor",
        controlReceiver: "pristine",
      },
    },
    {
      scheduledAtOffsetMs: clearAt,
      states: {
        publisher: "pristine",
        primaryReceiver: "pristine",
        controlReceiver: "pristine",
      },
    },
  ];
  const mutations = stages.flatMap((stage) =>
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) =>
      buildDynamicNetworkCdpMutation({
        endpoint,
        targetId: normalizedTargetIds[endpoint],
        sessionId: normalizedSessionIds[endpoint],
        state: stage.states[endpoint],
        scheduledAtOffsetMs: stage.scheduledAtOffsetMs,
      }),
    ),
  );
  return deepFreeze({
    version: 1,
    windowId: plan.measurementWindow.id,
    setup: DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => ({
      version: 1,
      windowId: plan.measurementWindow.id,
      endpoint,
      targetId: normalizedTargetIds[endpoint],
      sessionId: normalizedSessionIds[endpoint],
      scheduledAtOffsetMs: 0,
      method: "Network.enable",
      params: {},
    })),
    mutations,
    deprecatedFallbackAllowed: false,
  });
}

const measurementOffsetAt = (
  measurementWindow,
  epochMs,
  { allowInitializationLead = false } = {},
) => {
  if (
    measurementWindow?.version !== 1 ||
    !nonEmptyString(measurementWindow?.id) ||
    finite(measurementWindow?.startedAtEpochMs) === null ||
    finite(measurementWindow?.endedAtEpochMs) === null ||
    finite(epochMs) === null ||
    epochMs <
      measurementWindow.startedAtEpochMs -
        (allowInitializationLead
          ? DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS
          : 0) ||
    epochMs > measurementWindow.endedAtEpochMs
  ) {
    throw new RangeError("CDP evidence is outside the immutable window");
  }
  return epochMs - measurementWindow.startedAtEpochMs;
};

const assertBoundCdpTarget = (cdp, targetId, sessionId) => {
  const normalizedTargetId =
    typeof targetId === "string" ? targetId.trim() : "";
  if (!normalizedTargetId) throw new TypeError("CDP targetId is required");
  if (!nonEmptyString(cdp?.targetId)) {
    throw new TypeError("CDP client target binding is required");
  }
  if (cdp.targetId.trim() !== normalizedTargetId) {
    throw new TypeError("CDP client target does not match the endpoint targetId");
  }
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) throw new TypeError("CDP sessionId is required");
  if (!nonEmptyString(cdp?.sessionId)) {
    throw new TypeError("CDP client session binding is required");
  }
  if (cdp.sessionId.trim() !== normalizedSessionId) {
    throw new TypeError(
      "CDP client session does not match the endpoint sessionId",
    );
  }
  return { targetId: normalizedTargetId, sessionId: normalizedSessionId };
};

export async function enableDynamicNetworkCdp(
  cdp,
  {
    endpoint,
    targetId,
    sessionId,
    measurementWindow,
    now = Date.now,
  } = {},
) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new TypeError("an open CDP client is required");
  }
  const normalizedEndpoint = requireEndpoint(endpoint);
  const binding = assertBoundCdpTarget(cdp, targetId, sessionId);
  await cdp.send("Network.enable", {});
  const enabledAtEpochMs = now();
  return deepFreeze({
    version: 1,
    windowId: measurementWindow.id,
    endpoint: normalizedEndpoint,
    ...binding,
    scheduledAtOffsetMs: 0,
    method: "Network.enable",
    params: {},
    enabledAtEpochMs,
    enabledAtOffsetMs: measurementOffsetAt(
      measurementWindow,
      enabledAtEpochMs,
      { allowInitializationLead: true },
    ),
    succeeded: true,
  });
}

/**
 * Apply one prevalidated mutation. Deliberately has no catch/fallback path:
 * absence of either modern CDP command invalidates the transition run.
 */
export async function applyDynamicNetworkCdpMutation(
  cdp,
  mutation,
  { measurementWindow, now = Date.now } = {},
) {
  if (!cdp || typeof cdp.send !== "function") {
    throw new TypeError("an open CDP client is required");
  }
  assertBoundCdpTarget(cdp, mutation?.targetId, mutation?.sessionId);
  const expected = buildDynamicNetworkCdpMutation({
    endpoint: mutation?.endpoint,
    targetId: mutation?.targetId,
    sessionId: mutation?.sessionId,
    state: mutation?.state,
    scheduledAtOffsetMs: mutation?.scheduledAtOffsetMs,
  });
  if (stableJson(mutation) !== stableJson(expected)) {
    throw new TypeError("dynamic-network CDP mutation was altered");
  }
  const commands = [];
  for (const command of expected.commands) {
    const result = await cdp.send(command.method, command.params);
    commands.push({
      ...clone(command),
      result: clone(result ?? {}),
      succeeded: true,
    });
  }
  const appliedAtEpochMs = now();
  return deepFreeze({
    ...clone(expected),
    appliedAtEpochMs,
    appliedAtOffsetMs: measurementOffsetAt(
      measurementWindow,
      appliedAtEpochMs,
      {
        allowInitializationLead: expected.scheduledAtOffsetMs === 0,
      },
    ),
    commands,
  });
}

const pristineHint = deepFreeze({
  effectiveType: "4g",
  saveData: false,
  downlinkMbps: 10,
  rttMs: 0,
  type: "wifi",
});

const poorHintForEndpoint = (endpoint) => {
  const profile = DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES[endpoint];
  return deepFreeze({
    effectiveType: "3g",
    saveData: true,
    downlinkMbps: profile.downloadKbps / 1_000,
    rttMs: profile.latencyMs,
    type: "cellular",
  });
};

export function dynamicNetworkHintForState(endpoint, state) {
  const normalizedEndpoint = requireEndpoint(endpoint);
  if (state === "pristine") return pristineHint;
  if (state !== "poor" || normalizedEndpoint === "controlReceiver") {
    throw new RangeError("invalid dynamic-network hint state");
  }
  return poorHintForEndpoint(normalizedEndpoint);
}

export function buildDynamicNetworkHintSchedule(plan) {
  if (!isExactTransitionPlan(plan)) {
    throw new TypeError("an exact schema-13 dynamic-network plan is required");
  }
  const clearAt = plan.phasePlan.mutations.clearPoorAtOffsetMs;
  const secondGenerationOffsets = {
    publisher: plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    primaryReceiver:
      plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
    controlReceiver:
      plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
  };
  return deepFreeze(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.flatMap((endpoint) =>
      [
        { generation: 1, state: "pristine", scheduledAtOffsetMs: 0 },
        {
          generation: 2,
          state: endpoint === "controlReceiver" ? "pristine" : "poor",
          scheduledAtOffsetMs: secondGenerationOffsets[endpoint],
        },
        {
          generation: 3,
          state: "pristine",
          scheduledAtOffsetMs: clearAt,
        },
      ].map((entry) => ({
        version: 1,
        windowId: plan.measurementWindow.id,
        windowStartedAtEpochMs: plan.measurementWindow.startedAtEpochMs,
        endpoint,
        ...entry,
        hint: dynamicNetworkHintForState(endpoint, entry.state),
      })),
    ),
  );
}

export function createDynamicNetworkHintLedger(
  endpoint,
  { measurementWindow, targetId, sessionId } = {},
) {
  if (
    measurementWindow?.version !== 1 ||
    !nonEmptyString(measurementWindow?.id) ||
    finite(measurementWindow?.startedAtEpochMs) === null ||
    finite(measurementWindow?.endedAtEpochMs) === null ||
    measurementWindow.endedAtEpochMs - measurementWindow.startedAtEpochMs !==
      DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    measurementWindow?.durationMs !== DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    measurementWindow?.immutable !== true
  ) {
    throw new TypeError("an exact immutable measurement window is required");
  }
  const normalizedTargetId =
    typeof targetId === "string" ? targetId.trim() : "";
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedTargetId || !normalizedSessionId) {
    throw new TypeError("network hints require CDP target/session binding");
  }
  return deepFreeze({
    version: 1,
    windowId: measurementWindow.id,
    measurementWindow: clone(measurementWindow),
    targetId: normalizedTargetId,
    sessionId: normalizedSessionId,
    endpoint: requireEndpoint(endpoint),
    mutable: true,
    installedKeys: ["connection", "mozConnection", "webkitConnection"],
    generation: 0,
    dispatchedChangeEventCount: 0,
    runtimeObservedChangeEventCount: 0,
    updates: [],
    applicationObserverId: null,
    applicationObservations: [],
  });
}

const expectedDynamicNetworkHintUpdate = (
  endpoint,
  generation,
  { windowId, windowStartedAtEpochMs, targetId, sessionId } = {},
) => {
  const normalizedEndpoint = requireEndpoint(endpoint);
  if (!Number.isInteger(generation) || generation < 1 || generation > 3) {
    throw new RangeError("network hint generation must be 1, 2, or 3");
  }
  if (
    !nonEmptyString(windowId) ||
    finite(windowStartedAtEpochMs) === null ||
    !nonEmptyString(targetId) ||
    !nonEmptyString(sessionId)
  ) {
    throw new TypeError("network hint window/target/session binding is required");
  }
  const scheduledAtOffsetMs =
    generation === 1
      ? 0
      : generation === 3
        ? 36_000
        : normalizedEndpoint === "publisher"
          ? 24_000
          : 12_000;
  const state =
    generation === 2 && normalizedEndpoint !== "controlReceiver"
      ? "poor"
      : "pristine";
  return {
    version: 1,
    windowId,
    windowStartedAtEpochMs,
    targetId,
    sessionId,
    endpoint: normalizedEndpoint,
    updateIndex: generation - 1,
    generation,
    state,
    scheduledAtOffsetMs,
    hint: dynamicNetworkHintForState(normalizedEndpoint, state),
  };
};

export function validateDynamicNetworkHintUpdate(update, { endpoint } = {}) {
  const normalizedEndpoint = requireEndpoint(endpoint ?? update?.endpoint);
  const updatedAtOffsetMs = finite(update?.updatedAtOffsetMs);
  const expected = expectedDynamicNetworkHintUpdate(
    normalizedEndpoint,
    update?.generation,
    {
      windowId: update?.windowId,
      windowStartedAtEpochMs: update?.windowStartedAtEpochMs,
      targetId: update?.targetId,
      sessionId: update?.sessionId,
    },
  );
  const updatedAtEpochMs = finite(update?.updatedAtEpochMs);
  if (
    updatedAtOffsetMs === null ||
    updatedAtEpochMs === null ||
    updatedAtEpochMs !==
      expected.windowStartedAtEpochMs + updatedAtOffsetMs ||
    (expected.generation === 1
      ? updatedAtOffsetMs <
          -DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS ||
        updatedAtOffsetMs >= 0
      : updatedAtOffsetMs < expected.scheduledAtOffsetMs ||
        updatedAtOffsetMs - expected.scheduledAtOffsetMs >
          DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS)
  ) {
    throw new RangeError("network hint update timing is invalid");
  }
  const exact = { ...expected, updatedAtEpochMs, updatedAtOffsetMs };
  if (stableJson(update) !== stableJson(exact)) {
    throw new TypeError("dynamic-network hint update was altered");
  }
  return deepFreeze(clone(exact));
}

const assertDynamicNetworkHintLedger = (ledger) => {
  const endpoint = requireEndpoint(ledger?.endpoint);
  if (
    ledger?.version !== 1 ||
    !nonEmptyString(ledger?.windowId) ||
    ledger?.measurementWindow?.id !== ledger.windowId ||
    ledger?.measurementWindow?.immutable !== true ||
    ledger?.measurementWindow?.durationMs !==
      DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    ledger.measurementWindow.endedAtEpochMs -
        ledger.measurementWindow.startedAtEpochMs !==
      DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    !nonEmptyString(ledger?.targetId) ||
    !nonEmptyString(ledger?.sessionId) ||
    ledger?.mutable !== true ||
    stableJson(ledger?.installedKeys) !==
      stableJson(["connection", "mozConnection", "webkitConnection"]) ||
    !Number.isInteger(ledger?.generation) ||
    ledger.generation < 0 ||
    ledger.generation > 3 ||
    ledger?.dispatchedChangeEventCount !== ledger.generation ||
    ledger?.runtimeObservedChangeEventCount !== ledger.generation ||
    !Array.isArray(ledger?.updates) ||
    ledger.updates.length !== ledger.generation ||
    !Array.isArray(ledger?.applicationObservations) ||
    ledger.applicationObservations.length > ledger.generation ||
    (ledger.applicationObservations.length > 0 &&
      !nonEmptyString(ledger?.applicationObserverId))
  ) {
    throw new TypeError("a valid dynamic-network hint ledger is required");
  }
  for (let index = 0; index < ledger.updates.length; index += 1) {
    try {
      validateDynamicNetworkHintUpdate(ledger.updates[index], { endpoint });
    } catch {
      throw new TypeError("dynamic-network hint ledger contains an altered update");
    }
  }
  for (
    let index = 0;
    index < ledger.applicationObservations.length;
    index += 1
  ) {
    const update = ledger.updates[index];
    const observation = ledger.applicationObservations[index];
    const expected = {
      version: 1,
      windowId: ledger.windowId,
      windowStartedAtEpochMs:
        ledger.measurementWindow.startedAtEpochMs,
      targetId: ledger.targetId,
      sessionId: ledger.sessionId,
      endpoint,
      observerId: ledger.applicationObserverId,
      generation: index + 1,
      state: update.state,
      hint: update.hint,
      observedAtEpochMs: observation?.observedAtEpochMs,
      observedAtOffsetMs: observation?.observedAtOffsetMs,
      runtimeReceipt: observation?.runtimeReceipt,
    };
    if (
      stableJson(observation) !== stableJson(expected) ||
      finite(observation?.observedAtEpochMs) === null ||
      finite(observation?.observedAtOffsetMs) === null ||
      observation.observedAtEpochMs !==
        ledger.measurementWindow.startedAtEpochMs +
          observation.observedAtOffsetMs ||
      observation.observedAtOffsetMs < update.updatedAtOffsetMs ||
      observation.observedAtOffsetMs - update.updatedAtOffsetMs >
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS ||
      (index > 0 &&
        observation.observedAtOffsetMs <=
          ledger.applicationObservations[index - 1].observedAtOffsetMs)
    ) {
      throw new TypeError(
        "dynamic-network hint ledger contains an altered application observation",
      );
    }
    try {
      validateDynamicNetworkHintRuntimeReceipt(
        ledger,
        index + 1,
        ledger.applicationObserverId,
        observation.runtimeReceipt,
      );
    } catch {
      throw new TypeError(
        "dynamic-network hint ledger contains an invalid runtime receipt",
      );
    }
  }
  return endpoint;
};

export function advanceDynamicNetworkHintLedger(
  ledger,
  {
    generation,
    state,
    scheduledAtOffsetMs,
    updatedAtEpochMs,
    updatedAtOffsetMs,
  } = {},
) {
  const endpoint = assertDynamicNetworkHintLedger(ledger);
  if (generation !== ledger.generation + 1) {
    throw new RangeError("network hint generation must increase by exactly one");
  }
  const update = validateDynamicNetworkHintUpdate({
    version: 1,
    windowId: ledger.windowId,
    windowStartedAtEpochMs: ledger.measurementWindow.startedAtEpochMs,
    targetId: ledger.targetId,
    sessionId: ledger.sessionId,
    endpoint,
    updateIndex: ledger.updates.length,
    generation,
    state,
    scheduledAtOffsetMs,
    updatedAtEpochMs,
    updatedAtOffsetMs,
    hint: dynamicNetworkHintForState(endpoint, state),
  });
  return deepFreeze({
    ...ledger,
    generation,
    dispatchedChangeEventCount: ledger.dispatchedChangeEventCount + 1,
    runtimeObservedChangeEventCount:
      ledger.runtimeObservedChangeEventCount + 1,
    updates: [...ledger.updates, update],
  });
}

const hintRuntimeName = "__conclaveQualityDynamicNetworkHint";

const productBrowserNetworkForHint = (hint) => ({
  supported: true,
  quality: hint?.saveData === true ? "poor" : "good",
  startupQuality: hint?.saveData === true ? "poor" : "good",
  emergency: false,
  effectiveType: hint?.effectiveType ?? null,
  saveData: hint?.saveData ?? null,
  downlinkMbps: hint?.downlinkMbps ?? null,
  rttMs: hint?.rttMs > 0 ? hint.rttMs : null,
});

const validateDynamicNetworkHintRuntimeReceipt = (
  ledger,
  generation,
  observerId,
  receipt,
) => {
  const update = ledger.updates[generation - 1];
  const productObservation = receipt?.productObservation;
  const productDebug = receipt?.productDebug;
  const observedHint = receipt?.observedConnection;
  const expectedHint = update?.hint;
  const expectedBrowserNetwork = productBrowserNetworkForHint(expectedHint);
  if (
    receipt?.version !== 1 ||
    receipt?.issuedBy !== hintRuntimeName ||
    receipt?.windowId !== ledger.windowId ||
    receipt?.windowStartedAtEpochMs !==
      ledger.measurementWindow.startedAtEpochMs ||
    receipt?.targetId !== ledger.targetId ||
    receipt?.sessionId !== ledger.sessionId ||
    receipt?.endpoint !== ledger.endpoint ||
    receipt?.receiptSequence !== generation ||
    receipt?.runtimeGeneration !== generation ||
    receipt?.runtimeDispatchedChangeEventCount !== generation ||
    receipt?.runtimeObservedChangeEventCount !== generation ||
    receipt?.runtimeUpdateIndex !== generation - 1 ||
    receipt?.runtimeUpdatedAtEpochMs !== update?.updatedAtEpochMs ||
    receipt?.runtimeUpdatedAtOffsetMs !== update?.updatedAtOffsetMs ||
    productObservation?.version !== 1 ||
    productObservation?.source !== "useConnectionQuality" ||
    finite(productObservation?.observedAtEpochMs) === null ||
    productObservation.observedAtEpochMs < update.updatedAtEpochMs ||
    stableJson(productObservation?.browserNetwork) !==
      stableJson(expectedBrowserNetwork) ||
    productDebug?.source !== "__conclaveGetMeetVideoDebug.network" ||
    productDebug?.observerId !== observerId ||
    finite(productDebug?.capturedAtEpochMs) === null ||
    productDebug.capturedAtEpochMs < productObservation.observedAtEpochMs ||
    !["good", "fair", "poor", "unknown"].includes(productDebug?.quality) ||
    !["good", "fair", "poor", "unknown"].includes(
      productDebug?.publishAdaptationQuality,
    ) ||
    !["good", "fair", "poor", "unknown"].includes(
      productDebug?.receiveAdaptationQuality,
    ) ||
    observedHint?.effectiveType !== expectedHint?.effectiveType ||
    observedHint?.saveData !== expectedHint?.saveData ||
    observedHint?.downlinkMbps !== expectedHint?.downlinkMbps ||
    observedHint?.rttMs !== expectedHint?.rttMs ||
    observedHint?.type !== expectedHint?.type ||
    finite(receipt?.observedAtEpochMs) === null ||
    finite(receipt?.observedAtOffsetMs) === null ||
    receipt.observedAtEpochMs !==
      ledger.measurementWindow.startedAtEpochMs +
        receipt.observedAtOffsetMs ||
    receipt.observedAtEpochMs < productDebug.capturedAtEpochMs ||
    receipt.observedAtOffsetMs - update.updatedAtOffsetMs >
      DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS
  ) {
    throw new TypeError(
      "application network-hint runtime receipt is missing, stale, or altered",
    );
  }
  return receipt;
};

export function recordDynamicNetworkHintApplication(
  ledger,
  { generation, observerId, runtimeReceipt } = {},
) {
  const endpoint = assertDynamicNetworkHintLedger(ledger);
  const nextGeneration = ledger.applicationObservations.length + 1;
  if (generation !== nextGeneration || generation > ledger.generation) {
    throw new RangeError(
      "application-observed hint generation must increase by exactly one",
    );
  }
  const normalizedObserverId =
    typeof observerId === "string" ? observerId.trim() : "";
  if (
    !normalizedObserverId ||
    (ledger.applicationObserverId !== null &&
      ledger.applicationObserverId !== normalizedObserverId)
  ) {
    throw new TypeError("a stable application network-hint observerId is required");
  }
  const receipt = validateDynamicNetworkHintRuntimeReceipt(
    ledger,
    generation,
    normalizedObserverId,
    runtimeReceipt,
  );
  const update = ledger.updates[generation - 1];
  const previous = ledger.applicationObservations.at(-1);
  if (
    previous &&
    receipt.observedAtOffsetMs <= previous.observedAtOffsetMs
  ) {
    throw new RangeError(
      "application network-hint observations must be strictly monotonic",
    );
  }
  const observation = deepFreeze({
    version: 1,
    windowId: ledger.windowId,
    windowStartedAtEpochMs: ledger.measurementWindow.startedAtEpochMs,
    targetId: ledger.targetId,
    sessionId: ledger.sessionId,
    endpoint,
    observerId: normalizedObserverId,
    generation,
    state: update.state,
    hint: clone(update.hint),
    observedAtEpochMs: receipt.observedAtEpochMs,
    observedAtOffsetMs: receipt.observedAtOffsetMs,
    runtimeReceipt: clone(receipt),
  });
  return deepFreeze({
    ...ledger,
    applicationObserverId: normalizedObserverId,
    applicationObservations: [
      ...ledger.applicationObservations,
      observation,
    ],
  });
}

export function buildDynamicNetworkHintBootstrapScript({
  endpoint,
  initialUpdate,
} = {}) {
  const normalizedEndpoint = requireEndpoint(endpoint);
  const validatedInitialUpdate = validateDynamicNetworkHintUpdate(
    initialUpdate,
    { endpoint: normalizedEndpoint },
  );
  if (validatedInitialUpdate.generation !== 1) {
    throw new TypeError("a pristine generation-1 network hint update is required");
  }
  const expectedUpdates = [1, 2, 3].map((generation) =>
    expectedDynamicNetworkHintUpdate(normalizedEndpoint, generation, {
      windowId: validatedInitialUpdate.windowId,
      windowStartedAtEpochMs:
        validatedInitialUpdate.windowStartedAtEpochMs,
      targetId: validatedInitialUpdate.targetId,
      sessionId: validatedInitialUpdate.sessionId,
    }),
  );
  const serializedUpdate = JSON.stringify(validatedInitialUpdate);
  return `(() => {
    const endpoint = ${JSON.stringify(normalizedEndpoint)};
    const expectedUpdates = Object.freeze(${JSON.stringify(expectedUpdates)});
    const priorConnections = new Set(
      ["connection", "mozConnection", "webkitConnection"]
        .map((key) => {
          try { return navigator[key]; } catch { return null; }
        })
        .filter(Boolean),
    );
    const listeners = new Set();
    const state = {
      version: 1,
      windowId: ${JSON.stringify(validatedInitialUpdate.windowId)},
      windowStartedAtEpochMs: ${validatedInitialUpdate.windowStartedAtEpochMs},
      targetId: ${JSON.stringify(validatedInitialUpdate.targetId)},
      sessionId: ${JSON.stringify(validatedInitialUpdate.sessionId)},
      endpoint,
      mutable: true,
      installedKeys: [],
      generation: 0,
      dispatchedChangeEventCount: 0,
      runtimeObservedChangeEventCount: 0,
      current: null,
      ledger: [],
      issuedProductObservationGenerations: new Set(),
    };
    const connection = {
      get effectiveType() { return state.current?.hint?.effectiveType ?? "4g"; },
      get saveData() { return state.current?.hint?.saveData ?? false; },
      get downlink() { return state.current?.hint?.downlinkMbps ?? 10; },
      get rtt() { return state.current?.hint?.rttMs ?? 0; },
      get type() { return state.current?.hint?.type ?? "wifi"; },
      addEventListener(type, listener) {
        if (type === "change" && listener) listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "change") listeners.delete(listener);
      },
    };
    const update = (entry) => {
      const expected = expectedUpdates[state.generation];
      if (!entry || !expected || entry.endpoint !== endpoint) throw new Error("network hint endpoint mismatch");
      if (!Number.isInteger(entry.generation) || entry.generation !== state.generation + 1) {
        throw new Error("network hint generation is not monotonic");
      }
      const exactKeys = ["endpoint", "generation", "hint", "scheduledAtOffsetMs", "sessionId", "state", "targetId", "updateIndex", "updatedAtEpochMs", "updatedAtOffsetMs", "version", "windowId", "windowStartedAtEpochMs"];
      if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(exactKeys)) {
        throw new Error("network hint update shape was altered");
      }
      if (entry.version !== expected.version || entry.windowId !== expected.windowId ||
          entry.windowStartedAtEpochMs !== expected.windowStartedAtEpochMs ||
          entry.targetId !== expected.targetId || entry.sessionId !== expected.sessionId ||
          entry.updateIndex !== expected.updateIndex ||
          entry.generation !== expected.generation || entry.state !== expected.state ||
          entry.scheduledAtOffsetMs !== expected.scheduledAtOffsetMs ||
          JSON.stringify(entry.hint) !== JSON.stringify(expected.hint) ||
          !Number.isFinite(entry.updatedAtEpochMs) ||
          !Number.isFinite(entry.updatedAtOffsetMs) ||
          entry.updatedAtEpochMs !== state.windowStartedAtEpochMs + entry.updatedAtOffsetMs ||
          (expected.generation === 1
            ? entry.updatedAtOffsetMs < -${DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS} || entry.updatedAtOffsetMs >= 0
            : entry.updatedAtOffsetMs < expected.scheduledAtOffsetMs ||
              entry.updatedAtOffsetMs - expected.scheduledAtOffsetMs > ${DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS})) {
        throw new Error("network hint update did not match the exact transition schedule");
      }
      const previous = state.ledger.at(-1);
      if (previous && entry.updatedAtOffsetMs <= previous.updatedAtOffsetMs) {
        throw new Error("network hint update time is not monotonic");
      }
      const immutableEntry = Object.freeze({
        ...entry,
        hint: Object.freeze({ ...entry.hint }),
      });
      state.generation = immutableEntry.generation;
      state.current = immutableEntry;
      state.ledger.push(immutableEntry);
      const event = new Event("change");
      state.dispatchedChangeEventCount += 1;
      for (const listener of listeners) {
        if (typeof listener === "function") listener.call(connection, event);
        else listener?.handleEvent?.(event);
      }
      for (const priorConnection of priorConnections) {
        if (priorConnection === connection) continue;
        try {
          priorConnection.dispatchEvent?.(new Event("change"));
        } catch {}
      }
      return {
        version: state.version,
        windowId: state.windowId,
        windowStartedAtEpochMs: state.windowStartedAtEpochMs,
        targetId: state.targetId,
        sessionId: state.sessionId,
        endpoint: state.endpoint,
        mutable: state.mutable,
        installedKeys: state.installedKeys.slice(),
        generation: state.generation,
        dispatchedChangeEventCount: state.dispatchedChangeEventCount,
        runtimeObservedChangeEventCount: state.runtimeObservedChangeEventCount,
        current: state.current,
        ledger: state.ledger.slice(),
      };
    };
    const observeProductDebug = (observerId) => {
      if (typeof observerId !== "string" || observerId.trim().length === 0) {
        throw new Error("product network-policy observer id is missing");
      }
      if (state.issuedProductObservationGenerations.has(state.generation)) {
        throw new Error("product network-policy observation was reused");
      }
      const current = state.current;
      const debug = globalThis.__conclaveGetMeetVideoDebug?.();
      const network = debug?.network;
      const productObservation = network?.browserNetworkObservation;
      const expectedBrowserNetwork = {
        supported: true,
        quality: current?.hint?.saveData === true ? "poor" : "good",
        startupQuality: current?.hint?.saveData === true ? "poor" : "good",
        emergency: false,
        effectiveType: current?.hint?.effectiveType ?? null,
        saveData: current?.hint?.saveData ?? null,
        downlinkMbps: current?.hint?.downlinkMbps ?? null,
        rttMs: current?.hint?.rttMs > 0 ? current.hint.rttMs : null,
      };
      const observedConnection = {
        effectiveType: connection.effectiveType,
        saveData: connection.saveData,
        downlinkMbps: connection.downlink,
        rttMs: connection.rtt,
        type: connection.type,
      };
      if (!current || !debug || !network ||
          productObservation?.version !== 1 ||
          productObservation?.source !== "useConnectionQuality" ||
          !Number.isFinite(productObservation?.observedAtEpochMs) ||
          productObservation.observedAtEpochMs < current.updatedAtEpochMs ||
          JSON.stringify(productObservation.browserNetwork) !== JSON.stringify(expectedBrowserNetwork) ||
          JSON.stringify(observedConnection) !== JSON.stringify(current.hint)) {
        return null;
      }
      const observedAtEpochMs = Date.now();
      const observedAtOffsetMs = observedAtEpochMs - state.windowStartedAtEpochMs;
      if (observedAtEpochMs < debug.timestamp ||
          observedAtOffsetMs - current.updatedAtOffsetMs > ${DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS}) {
        throw new Error("application network-policy runtime receipt is late");
      }
      state.issuedProductObservationGenerations.add(state.generation);
      return Object.freeze({
        version: 1,
        issuedBy: ${JSON.stringify(hintRuntimeName)},
        windowId: state.windowId,
        windowStartedAtEpochMs: state.windowStartedAtEpochMs,
        targetId: state.targetId,
        sessionId: state.sessionId,
        endpoint,
        receiptSequence: state.generation,
        runtimeGeneration: state.generation,
        runtimeDispatchedChangeEventCount: state.dispatchedChangeEventCount,
        runtimeObservedChangeEventCount: state.runtimeObservedChangeEventCount,
        runtimeUpdateIndex: current.updateIndex,
        runtimeUpdatedAtEpochMs: current.updatedAtEpochMs,
        runtimeUpdatedAtOffsetMs: current.updatedAtOffsetMs,
        productObservation: Object.freeze({
          ...productObservation,
          browserNetwork: Object.freeze({ ...productObservation.browserNetwork }),
        }),
        productDebug: Object.freeze({
          source: "__conclaveGetMeetVideoDebug.network",
          observerId: observerId.trim(),
          capturedAtEpochMs: debug.timestamp,
          quality: network.quality,
          publishAdaptationQuality: network.publishAdaptationQuality,
          receiveAdaptationQuality: network.receiveAdaptationQuality,
        }),
        observedConnection: Object.freeze(observedConnection),
        observedAtEpochMs,
        observedAtOffsetMs,
      });
    };
    listeners.add(() => {
      state.runtimeObservedChangeEventCount += 1;
    });
    for (const key of ["connection", "mozConnection", "webkitConnection"]) {
      try {
        Object.defineProperty(navigator, key, {
          configurable: true,
          get: () => connection,
        });
        if (navigator[key] === connection) state.installedKeys.push(key);
      } catch {}
    }
    if (state.installedKeys.length !== 3) {
      throw new Error("mutable Network Information hints could not be installed");
    }
    const api = Object.freeze({
      connection,
      update,
      observeProductDebug,
      snapshot: () => ({
        version: state.version,
        windowId: state.windowId,
        windowStartedAtEpochMs: state.windowStartedAtEpochMs,
        targetId: state.targetId,
        sessionId: state.sessionId,
        endpoint: state.endpoint,
        mutable: state.mutable,
        installedKeys: state.installedKeys.slice(),
        generation: state.generation,
        dispatchedChangeEventCount: state.dispatchedChangeEventCount,
        runtimeObservedChangeEventCount: state.runtimeObservedChangeEventCount,
        current: state.current,
        ledger: state.ledger.slice(),
      }),
    });
    Object.defineProperty(globalThis, ${JSON.stringify(hintRuntimeName)}, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: api,
    });
    return api.update(${serializedUpdate});
  })();`;
}

export function buildDynamicNetworkHintUpdateExpression(update) {
  const validated = validateDynamicNetworkHintUpdate(update);
  return `globalThis[${JSON.stringify(hintRuntimeName)}].update(${JSON.stringify(
    validated,
  )})`;
}

export function buildDynamicNetworkHintApplicationObservationExpression({
  observerId,
} = {}) {
  const normalizedObserverId =
    typeof observerId === "string" ? observerId.trim() : "";
  if (!normalizedObserverId) {
    throw new TypeError("an application network-policy observer id is required");
  }
  return `(() => {
    const receipt = globalThis[${JSON.stringify(
      hintRuntimeName,
    )}].observeProductDebug(${JSON.stringify(normalizedObserverId)});
    return receipt ? { ok: true, receipt } : { ok: false, reason: "product-network-policy-not-observed" };
  })()`;
}

const snapshotSchemaFailures = (checkpoint) => {
  const failures = [];
  const snapshots = checkpoint?.endpointSnapshots;
  if (!snapshots || typeof snapshots !== "object") {
    return ["endpoint snapshots are missing"];
  }
  const keys = Object.keys(snapshots).sort();
  if (
    stableJson(keys) !==
    stableJson([...DYNAMIC_NETWORK_TRANSITION_ENDPOINTS].sort())
  ) {
    failures.push("endpoint snapshot roles are incomplete or unexpected");
  }
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const snapshot = snapshots[endpoint];
    if (!snapshot || snapshot.version !== 1) {
      failures.push(`${endpoint} checkpoint schema is missing`);
      continue;
    }
    if (
      !Number.isInteger(snapshot.hintGeneration) ||
      snapshot.hintGeneration < 1 ||
      (snapshot.hintState !== "pristine" && snapshot.hintState !== "poor") ||
      !nonEmptyString(snapshot.connectionQuality) ||
      typeof snapshot.mediaSurvived !== "boolean" ||
      typeof snapshot.adaptationUpdateInFlight !== "boolean" ||
      !nonEmptyString(snapshot.producerId)
    ) {
      failures.push(`${endpoint} checkpoint authority is malformed`);
    }
    const path = snapshot.mediaPathAuthority;
    const expectedPathSource =
      endpoint === "publisher"
        ? "fixed-publisher-sender-binding"
        : "fixed-receiver-media-path-binding";
    if (
      path?.version !== 1 ||
      path?.source !== expectedPathSource ||
      path?.matched !== true ||
      !Array.isArray(path?.reasons) ||
      path.reasons.length !== 0 ||
      !nonEmptyString(path?.connectionId) ||
      path?.producerId !== snapshot.producerId ||
      !Array.isArray(path?.rtpStatIds) ||
      path.rtpStatIds.length === 0 ||
      path.rtpStatIds.some((id) => !nonEmptyString(id)) ||
      new Set(path.rtpStatIds).size !== path.rtpStatIds.length ||
      !Array.isArray(path?.rtpSsrcs) ||
      path.rtpSsrcs.length !== path.rtpStatIds.length ||
      path.rtpSsrcs.some((ssrc) => !nonEmptyString(ssrc)) ||
      new Set(path.rtpSsrcs).size !== path.rtpSsrcs.length ||
      (endpoint === "publisher"
        ? !nonEmptyString(path?.senderId) ||
          !nonEmptyString(path?.trackId) ||
          path?.consumerId !== null
        : path?.senderId !== null ||
          path?.trackId !== null ||
          !nonEmptyString(path?.consumerId))
    ) {
      failures.push(`${endpoint} fixed media-path authority is malformed`);
    }
    if (endpoint === "publisher") {
      const senderConfiguration = snapshot.senderEncodingConfiguration;
      const senderEncodings = senderConfiguration?.encodings;
      if (
        !nonEmptyString(snapshot.publishQuality) ||
        !["good", "fair", "poor", "emergency"].includes(
          snapshot.networkProfile,
        ) ||
        finite(snapshot.captureWidth) === null ||
        snapshot.captureWidth < 0 ||
        finite(snapshot.captureHeight) === null ||
        snapshot.captureHeight < 0 ||
        finite(snapshot.captureFps) === null ||
        snapshot.captureFps < 0 ||
        typeof snapshot.fullLadder !== "boolean" ||
        senderConfiguration?.version !== 1 ||
        !nonEmptyString(senderConfiguration?.degradationPreference) ||
        !Array.isArray(senderEncodings) ||
        senderEncodings.length === 0 ||
        senderEncodings.some(
          (encoding) =>
            typeof encoding?.active !== "boolean" ||
            finite(encoding?.maxBitrate) === null ||
            encoding.maxBitrate <= 0 ||
            finite(encoding?.maxFramerate) === null ||
            encoding.maxFramerate <= 0 ||
            finite(encoding?.scaleResolutionDownBy) === null ||
            encoding.scaleResolutionDownBy < 1 ||
            !nonEmptyString(encoding?.scalabilityMode),
        )
      ) {
        failures.push("publisher capture checkpoint is malformed");
      }
      continue;
    }
    if (
      !Number.isInteger(snapshot.spatialLayer) ||
      snapshot.spatialLayer < 0 ||
      !Number.isInteger(snapshot.temporalLayer) ||
      snapshot.temporalLayer < 0 ||
      !Number.isInteger(snapshot.maximumSpatialLayer) ||
      snapshot.maximumSpatialLayer < snapshot.spatialLayer ||
      !Number.isInteger(snapshot.maximumTemporalLayer) ||
      snapshot.maximumTemporalLayer < snapshot.temporalLayer ||
      typeof snapshot.atTopLayer !== "boolean"
    ) {
      failures.push(`${endpoint} receive-layer checkpoint is malformed`);
    }
  }
  return failures;
};

export function assessDynamicNetworkCheckpointAuthority({ plan, sampler } = {}) {
  const failures = [];
  if (!isExactTransitionPlan(plan)) {
    failures.push("measurement plan is missing or is not exact schema 13");
    return assessmentEnvelope({
      harnessFailures: failures,
      coverageRatio: 0,
      maximumCheckpointGapMs: null,
      checkpoints: [],
    });
  }
  if (
    sampler?.version !== 1 ||
    !nonEmptyString(sampler?.instanceId) ||
    sampler?.windowId !== plan.measurementWindow.id ||
    sampler?.startCount !== 1 ||
    sampler?.stopCount !== 1 ||
    sampler?.restartCount !== 0 ||
    sampler?.windowMutationCount !== 0 ||
    sampler?.startOffsetMs !== 0 ||
    sampler?.stopOffsetMs !== DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
    stableJson(sampler?.measurementWindow) !==
      stableJson(plan.measurementWindow)
  ) {
    failures.push("sampler is not one continuous immutable measurement window");
  }
  if (!Array.isArray(sampler?.checkpoints)) {
    failures.push("continuous sampler checkpoints are missing");
    return assessmentEnvelope({
      harnessFailures: failures,
      coverageRatio: 0,
      maximumCheckpointGapMs: null,
      checkpoints: [],
    });
  }

  const expectedTargets = buildDynamicNetworkCheckpointTargets(plan);
  const expectedOffsets = new Set(
    expectedTargets.map((target) => target.scheduledOffsetMs),
  );
  const observedOffsets = new Set();
  const validCheckpoints = [];
  const mediaPathSignatures = Object.fromEntries(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => [endpoint, new Set()]),
  );
  let previousScheduledOffsetMs = -1;
  let previousCapturedOffsetMs = -1;
  for (const checkpoint of sampler.checkpoints) {
    const checkpointFailures = [];
    if (
      checkpoint?.schemaVersion !==
        DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION ||
      checkpoint?.windowId !== plan.measurementWindow.id ||
      checkpoint?.samplerInstanceId !== sampler.instanceId
    ) {
      checkpointFailures.push("checkpoint window/sampler authority mismatch");
    }
    const scheduledOffsetMs = finite(checkpoint?.scheduledOffsetMs);
    const capturedOffsetMs = finite(checkpoint?.capturedOffsetMs);
    if (
      scheduledOffsetMs === null ||
      !expectedOffsets.has(scheduledOffsetMs) ||
      !Number.isInteger(checkpoint?.index) ||
      checkpoint.index !==
        scheduledOffsetMs /
          DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS ||
      observedOffsets.has(scheduledOffsetMs)
    ) {
      checkpointFailures.push("checkpoint target is invalid or duplicated");
    }
    if (
      capturedOffsetMs === null ||
      capturedOffsetMs < 0 ||
      capturedOffsetMs > DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
      scheduledOffsetMs === null ||
      Math.abs(capturedOffsetMs - scheduledOffsetMs) >
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_SKEW_MS
    ) {
      checkpointFailures.push("checkpoint capture skew is invalid");
    }
    if (
      scheduledOffsetMs !== null &&
      (scheduledOffsetMs <= previousScheduledOffsetMs ||
        capturedOffsetMs <= previousCapturedOffsetMs)
    ) {
      checkpointFailures.push("checkpoint order is not monotonic");
    }
    checkpointFailures.push(...snapshotSchemaFailures(checkpoint));
    if (checkpointFailures.length === 0) {
      observedOffsets.add(scheduledOffsetMs);
      validCheckpoints.push(checkpoint);
      for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
        const path = checkpoint.endpointSnapshots[endpoint].mediaPathAuthority;
        mediaPathSignatures[endpoint].add(
          stableJson({
            source: path.source,
            connectionId: path.connectionId,
            senderId: path.senderId,
            // replaceTrack changes the source-track generation while retaining
            // this exact producer, sender, RTP stat, and SSRC path.
            ...(endpoint === "publisher" ? {} : { trackId: path.trackId }),
            consumerId: path.consumerId,
            producerId: path.producerId,
            rtpStatIds: path.rtpStatIds,
            rtpSsrcs: path.rtpSsrcs,
          }),
        );
      }
    } else {
      failures.push(
        `checkpoint ${checkpoint?.index ?? "missing"}: ${checkpointFailures.join(
          "; ",
        )}`,
      );
    }
    if (scheduledOffsetMs !== null) {
      previousScheduledOffsetMs = scheduledOffsetMs;
    }
    if (capturedOffsetMs !== null) previousCapturedOffsetMs = capturedOffsetMs;
  }

  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    if (mediaPathSignatures[endpoint].size !== 1) {
      failures.push(
        `${endpoint} fixed media-path identity changed during the measurement window`,
      );
    }
  }

  const coverageRatio = validCheckpoints.length / expectedTargets.length;
  if (coverageRatio < DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE) {
    failures.push(
      `checkpoint coverage ${round(coverageRatio)} is below ${DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE}`,
    );
  }
  const capturedOffsets = validCheckpoints
    .map((checkpoint) => checkpoint.capturedOffsetMs)
    .sort((left, right) => left - right);
  const gaps = [];
  if (capturedOffsets.length > 0) {
    gaps.push(capturedOffsets[0]);
    for (let index = 1; index < capturedOffsets.length; index += 1) {
      gaps.push(capturedOffsets[index] - capturedOffsets[index - 1]);
    }
    gaps.push(
      DYNAMIC_NETWORK_TRANSITION_WINDOW_MS - capturedOffsets.at(-1),
    );
  }
  const maximumCheckpointGapMs = gaps.length > 0 ? Math.max(...gaps) : null;
  if (
    maximumCheckpointGapMs === null ||
    maximumCheckpointGapMs >
      DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS
  ) {
    failures.push(
      `maximum checkpoint gap ${maximumCheckpointGapMs ?? "missing"}ms exceeds ${DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS}ms`,
    );
  }
  return assessmentEnvelope({
    harnessFailures: failures,
    coverageRatio: round(coverageRatio, 6),
    maximumCheckpointGapMs,
    expectedCheckpointCount: expectedTargets.length,
    observedCheckpointCount: validCheckpoints.length,
    checkpoints: validCheckpoints,
  });
}

export function findSustainedCheckpointProof(
  checkpoints,
  predicate,
  {
    notBeforeOffsetMs,
    deadlineOffsetMs,
    requiredSustainedMs,
    maximumGapMs = DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS,
  } = {},
) {
  if (!Array.isArray(checkpoints) || typeof predicate !== "function") {
    throw new TypeError("checkpoints and a predicate are required");
  }
  if (
    finite(notBeforeOffsetMs) === null ||
    finite(deadlineOffsetMs) === null ||
    deadlineOffsetMs <= notBeforeOffsetMs ||
    finite(requiredSustainedMs) === null ||
    requiredSustainedMs <= 0
  ) {
    throw new RangeError("sustained checkpoint proof timing is invalid");
  }
  const eligible = checkpoints
    .filter(
      (checkpoint) =>
        finite(checkpoint?.capturedOffsetMs) !== null &&
        checkpoint.capturedOffsetMs >= notBeforeOffsetMs &&
        checkpoint.capturedOffsetMs <= deadlineOffsetMs,
    )
    .sort((left, right) => left.capturedOffsetMs - right.capturedOffsetMs);
  let start = null;
  let last = null;
  let sampleCount = 0;
  for (const checkpoint of eligible) {
    const offset = checkpoint.capturedOffsetMs;
    const gap = last === null ? 0 : offset - last;
    const matches = predicate(checkpoint) === true;
    if (gap > maximumGapMs || !matches) {
      start = null;
      last = null;
      sampleCount = 0;
      if (!matches) continue;
    }
    if (start === null) start = offset;
    last = offset;
    sampleCount += 1;
    if (last - start >= requiredSustainedMs) {
      return {
        passed: true,
        startOffsetMs: start,
        endOffsetMs: last,
        sustainedMs: last - start,
        sampleCount,
      };
    }
  }
  return {
    passed: false,
    startOffsetMs: start,
    endOffsetMs: last,
    sustainedMs:
      start === null || last === null ? 0 : Math.max(0, last - start),
    sampleCount,
  };
}

export function resolveAuthorityRelativeDeadline({
  authorityAtOffsetMs,
  scheduledAtOffsetMs,
  plannedDeadlineOffsetMs,
} = {}) {
  if (
    finite(authorityAtOffsetMs) === null ||
    finite(scheduledAtOffsetMs) === null ||
    finite(plannedDeadlineOffsetMs) === null ||
    authorityAtOffsetMs < scheduledAtOffsetMs ||
    plannedDeadlineOffsetMs <= scheduledAtOffsetMs
  ) {
    throw new RangeError("authority-relative deadline timing is invalid");
  }
  return (
    authorityAtOffsetMs +
    (plannedDeadlineOffsetMs - scheduledAtOffsetMs)
  );
}

const hasHint = (snapshot, generation, state) =>
  snapshot?.hintGeneration === generation && snapshot?.hintState === state;

const controlHasPristineNetworkPath = (snapshot, generation) =>
  hasHint(snapshot, generation, "pristine") &&
  snapshot?.mediaSurvived === true &&
  snapshot?.adaptationUpdateInFlight === false;

const controlIsGood = (snapshot, generation) =>
  controlHasPristineNetworkPath(snapshot, generation) &&
  snapshot?.connectionQuality === "good";

const controlIsGoodAndTop = (snapshot, generation) =>
  controlIsGood(snapshot, generation) &&
  snapshot?.atTopLayer === true &&
  snapshot?.maximumSpatialLayer >= 1 &&
  snapshot?.spatialLayer === snapshot?.maximumSpatialLayer &&
  snapshot?.temporalLayer === snapshot?.maximumTemporalLayer;

const publisherHasContinuousVp9PoorCap = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encoding = configuration?.encodings?.[0];
  return (
    publisher?.codecIdentity?.mimeType === "video/vp9" &&
    publisher?.codecIdentity?.scalabilityMode === "L2T1" &&
    configuration?.degradationPreference === "maintain-resolution" &&
    configuration?.encodings?.length === 1 &&
    encoding?.active === true &&
    encoding?.maxBitrate > 0 &&
    encoding.maxBitrate <= 160_000 &&
    encoding?.maxFramerate > 0 &&
    encoding.maxFramerate <= 12 &&
    encoding?.scaleResolutionDownBy === 1 &&
    encoding?.scalabilityMode === "L2T1"
  );
};

const publisherHasStableVp8PoorCaps = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encodings = configuration?.encodings;
  const maximumBitrates = [80_000, 25_000, 15_000];
  // Live VP8 transitions are bitrate-only when the sender started healthy;
  // constrained-start senders may retain lower cadence caps.
  const maximumFramerates = [12, 20, 30];
  const scales = [4, 2, 1];
  return (
    publisher?.codecIdentity?.mimeType === "video/vp8" &&
    publisher?.codecIdentity?.scalabilityMode === "L1T1" &&
    publisher?.networkProfile === "poor" &&
    configuration?.degradationPreference === "maintain-framerate" &&
    Array.isArray(encodings) &&
    encodings.length === 3 &&
    encodings.every(
      (encoding, index) =>
        encoding?.active === true &&
        encoding?.maxBitrate > 0 &&
        encoding.maxBitrate <= maximumBitrates[index] &&
        encoding?.maxFramerate > 0 &&
        encoding.maxFramerate <= maximumFramerates[index] &&
        encoding?.scaleResolutionDownBy === scales[index] &&
        encoding?.scalabilityMode === "L1T1",
    )
  );
};

const publisherHasStableVp8TransportPoorBudget = (publisher) => {
  const configuration = publisher?.senderEncodingConfiguration;
  const encodings = configuration?.encodings;
  const bitrates = [80_000, 220_000, 1_650_000];
  const framerates = [12, 20, 30];
  const scales = [4, 2, 1];
  const constrainedProfile = publisher?.networkProfile;
  const constrainedTransportProfile =
    publisher?.producerTransportNetworkProfile;
  return (
    publisher?.codecIdentity?.mimeType === "video/vp8" &&
    publisher?.codecIdentity?.scalabilityMode === "L1T1" &&
    (constrainedProfile === "poor" || constrainedProfile === "emergency") &&
    publisher?.networkProfileAuthority === "producer-transport" &&
    nonEmptyString(publisher?.producerTransportId) &&
    constrainedTransportProfile === constrainedProfile &&
    publisher?.producerTransportMaxIncomingBitrateBps > 0 &&
    publisher.producerTransportMaxIncomingBitrateBps <= 180_000 &&
    configuration?.degradationPreference === "maintain-framerate" &&
    Array.isArray(encodings) &&
    encodings.length === 3 &&
    encodings.every(
      (encoding, index) =>
        encoding?.active === true &&
        encoding?.maxBitrate === bitrates[index] &&
        encoding?.maxFramerate === framerates[index] &&
        encoding?.scaleResolutionDownBy === scales[index] &&
        encoding?.scalabilityMode === "L1T1",
    )
  );
};

const receiverIsolationCheckpointPassed = (checkpoint) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  const primary = checkpoint?.endpointSnapshots?.primaryReceiver;
  const control = checkpoint?.endpointSnapshots?.controlReceiver;
  return (
    hasHint(publisher, 1, "pristine") &&
    publisher?.connectionQuality === "good" &&
    publisher?.publishQuality === "standard" &&
    publisher?.networkProfile === "good" &&
    publisher?.fullLadder === true &&
    publisher?.mediaSurvived === true &&
    publisher?.adaptationUpdateInFlight === false &&
    hasHint(primary, 2, "poor") &&
    primary?.connectionQuality === "poor" &&
    primary?.spatialLayer === 0 &&
    primary?.temporalLayer === 0 &&
    primary?.mediaSurvived === true &&
    primary?.adaptationUpdateInFlight === false &&
    controlIsGoodAndTop(control, 2)
  );
};

export const dynamicNetworkDownshiftCheckpointPassed = (checkpoint) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  const primary = checkpoint?.endpointSnapshots?.primaryReceiver;
  const control = checkpoint?.endpointSnapshots?.controlReceiver;
  return (
    hasHint(publisher, 2, "poor") &&
    hasHint(primary, 2, "poor") &&
    hasHint(control, 2, "pristine") &&
    ((publisher?.publishQuality === "low" &&
      ((
        // Chromium rounds the nominal 426x240 16:9 target to 427x240.
        publisher?.encodedWidth <= 427 &&
        publisher?.encodedWidth > 0 &&
        publisher?.encodedHeight <= 240 &&
        publisher?.encodedHeight > 0
      ) || publisherHasContinuousVp9PoorCap(publisher))) ||
      (publisher?.publishQuality === "standard" &&
        publisher?.fullLadder === true &&
        (publisherHasStableVp8PoorCaps(publisher) ||
          publisherHasStableVp8TransportPoorBudget(publisher)))) &&
    publisher?.mediaSurvived === true &&
    publisher?.adaptationUpdateInFlight === false &&
    primary?.spatialLayer === 0 &&
    primary?.temporalLayer === 0 &&
    primary?.mediaSurvived === true &&
    primary?.adaptationUpdateInFlight === false &&
    controlHasPristineNetworkPath(control, 2)
  );
};

const receiverHasBoundedRecoveryProof = (snapshot, generation) =>
  hasHint(snapshot, generation, "pristine") &&
  snapshot?.mediaSurvived === true &&
  snapshot?.adaptationUpdateInFlight === false &&
  snapshot?.browserAllowsFairWebcamLayerRecovery === true &&
  snapshot?.receiveRecoveryProbePhase === "active" &&
  snapshot?.receiveRecoveryProbeActive === true &&
  snapshot?.consumerScoreQuality === "good" &&
  snapshot?.networkPolicyEvidence?.browserNetwork?.quality === "good" &&
  snapshot?.networkPolicyEvidence?.browserNetwork?.saveData !== true &&
  snapshot?.maximumSpatialLayer >= 1 &&
  // This is the early recovery-controller proof: the bounded probe must be
  // actively requesting an enhancement layer under independent good-network
  // evidence. The later recoveryFull milestone separately proves that the SFU
  // actually delivered and sustained the top layer.
  snapshot?.requestedSpatialLayer >= 1;

const receiverHasGoodRecovery = (snapshot, generation) =>
  (hasHint(snapshot, generation, "pristine") &&
    snapshot?.connectionQuality === "good" &&
    snapshot?.mediaSurvived === true &&
    snapshot?.adaptationUpdateInFlight === false) ||
  receiverHasBoundedRecoveryProof(snapshot, generation);

export const dynamicNetworkRecoveryGoodCheckpointPassed = (checkpoint) => {
  const snapshots = checkpoint?.endpointSnapshots;
  return (
    hasHint(snapshots?.publisher, 3, "pristine") &&
    hasHint(snapshots?.primaryReceiver, 3, "pristine") &&
    hasHint(snapshots?.controlReceiver, 3, "pristine") &&
    snapshots?.publisher?.connectionQuality === "good" &&
    snapshots?.publisher?.mediaSurvived === true &&
    snapshots?.publisher?.adaptationUpdateInFlight === false &&
    receiverHasGoodRecovery(snapshots?.primaryReceiver, 3) &&
    receiverHasGoodRecovery(snapshots?.controlReceiver, 3)
  );
};

export const dynamicNetworkRecoveryFullCheckpointPassed = (checkpoint) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  const primary = checkpoint?.endpointSnapshots?.primaryReceiver;
  const control = checkpoint?.endpointSnapshots?.controlReceiver;
  return (
    dynamicNetworkRecoveryGoodCheckpointPassed(checkpoint) &&
    publisher?.publishQuality === "standard" &&
    publisher?.networkProfile === "good" &&
    publisher?.encodedWidth >= 960 &&
    publisher?.encodedHeight >= 540 &&
    publisher?.fullLadder === true &&
    primary?.connectionQuality === "good" &&
    primary?.atTopLayer === true &&
    primary?.maximumSpatialLayer >= 1 &&
    primary?.spatialLayer === primary?.maximumSpatialLayer &&
    primary?.temporalLayer === primary?.maximumTemporalLayer &&
    controlIsGoodAndTop(control, 3)
  );
};

const phaseCheckpointCoverage = (
  checkpoints,
  { startOffsetMs, endOffsetMs, includeEnd = false, predicate },
) => {
  const expectedCount =
    Math.floor(
      (endOffsetMs - startOffsetMs) /
        DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS,
    ) + (includeEnd ? 1 : 0);
  const phaseCheckpoints = checkpoints.filter((checkpoint) => {
    const offset = checkpoint.scheduledOffsetMs;
    return (
      offset >= startOffsetMs &&
      (includeEnd ? offset <= endOffsetMs : offset < endOffsetMs)
    );
  });
  const qualifying = phaseCheckpoints.filter(predicate);
  return {
    expectedCount,
    observedCount: phaseCheckpoints.length,
    qualifyingCount: qualifying.length,
    qualifyingCoverageRatio:
      expectedCount > 0
        ? Math.min(1, qualifying.length / expectedCount)
        : 0,
  };
};

const expectedHintStateAtSteadyPhase = (phase, endpoint) => {
  if (phase === "poor" && endpoint !== "controlReceiver") {
    return { generation: 2, state: "poor" };
  }
  return {
    generation: phase === "pristine" ? 1 : phase === "poor" ? 2 : 3,
    state: "pristine",
  };
};

const assessHintLedgers = (
  plan,
  networkHints,
  checkpoints,
  cdpAuthority,
) => {
  const failures = [];
  const expectedUpdates = buildDynamicNetworkHintSchedule(plan);
  const generationAuthorityOffsets = { 1: [], 2: [], 3: [] };
  const endpointGenerationAuthorityOffsets = Object.fromEntries(
    DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map((endpoint) => [
      endpoint,
      { 1: [], 2: [], 3: [] },
    ]),
  );
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const ledger = networkHints?.[endpoint];
    const expected = expectedUpdates.filter(
      (update) => update.endpoint === endpoint,
    );
    if (
      ledger?.version !== 1 ||
      ledger?.windowId !== plan.measurementWindow.id ||
      stableJson(ledger?.measurementWindow) !==
        stableJson(plan.measurementWindow) ||
      ledger?.targetId !== cdpAuthority?.targetIds?.[endpoint] ||
      ledger?.sessionId !== cdpAuthority?.sessionIds?.[endpoint] ||
      ledger?.endpoint !== endpoint ||
      ledger?.mutable !== true ||
      stableJson(ledger?.installedKeys) !==
        stableJson(["connection", "mozConnection", "webkitConnection"]) ||
      ledger?.generation !== expected.length ||
      ledger?.dispatchedChangeEventCount !== expected.length ||
      ledger?.runtimeObservedChangeEventCount !== expected.length ||
      !Array.isArray(ledger?.updates) ||
      ledger.updates.length !== expected.length ||
      !nonEmptyString(ledger?.applicationObserverId) ||
      !Array.isArray(ledger?.applicationObservations) ||
      ledger.applicationObservations.length !== expected.length
    ) {
      failures.push(`${endpoint} mutable network hint ledger is incomplete`);
      continue;
    }
    let previousUpdatedAtOffsetMs = -Infinity;
    for (let index = 0; index < expected.length; index += 1) {
      const observed = ledger.updates[index];
      const planned = expected[index];
      if (
        observed?.version !== 1 ||
        observed?.windowId !== plan.measurementWindow.id ||
        observed?.windowStartedAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs ||
        observed?.targetId !== ledger.targetId ||
        observed?.sessionId !== ledger.sessionId ||
        observed?.endpoint !== endpoint ||
        observed?.updateIndex !== index ||
        observed?.generation !== index + 1 ||
        observed?.state !== planned.state ||
        observed?.scheduledAtOffsetMs !== planned.scheduledAtOffsetMs ||
        finite(observed?.updatedAtOffsetMs) === null ||
        (planned.generation === 1
          ? observed.updatedAtOffsetMs <
              -DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS ||
            observed.updatedAtOffsetMs >= 0
          : observed.updatedAtOffsetMs < planned.scheduledAtOffsetMs ||
            observed.updatedAtOffsetMs - planned.scheduledAtOffsetMs >
              DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS) ||
        observed.updatedAtOffsetMs < previousUpdatedAtOffsetMs ||
        stableJson(observed?.hint) !== stableJson(planned.hint)
        || finite(observed?.updatedAtEpochMs) === null
        || observed.updatedAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs +
            observed.updatedAtOffsetMs
      ) {
        failures.push(
          `${endpoint} network hint update ${index} is not exact and monotonic`,
        );
      }
      if (finite(observed?.updatedAtOffsetMs) !== null) {
        previousUpdatedAtOffsetMs = observed.updatedAtOffsetMs;
      }
      const observation = ledger.applicationObservations[index];
      let runtimeReceiptValid = true;
      try {
        validateDynamicNetworkHintRuntimeReceipt(
          ledger,
          planned.generation,
          ledger.applicationObserverId,
          observation?.runtimeReceipt,
        );
      } catch {
        runtimeReceiptValid = false;
      }
      if (
        !runtimeReceiptValid ||
        observation?.version !== 1 ||
        observation?.windowId !== plan.measurementWindow.id ||
        observation?.windowStartedAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs ||
        observation?.targetId !== ledger.targetId ||
        observation?.sessionId !== ledger.sessionId ||
        observation?.endpoint !== endpoint ||
        observation?.observerId !== ledger.applicationObserverId ||
        observation?.generation !== planned.generation ||
        observation?.state !== planned.state ||
        stableJson(observation?.hint) !== stableJson(planned.hint) ||
        finite(observation?.observedAtEpochMs) === null ||
        finite(observation?.observedAtOffsetMs) === null ||
        observation.observedAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs +
            observation.observedAtOffsetMs ||
        finite(observed?.updatedAtOffsetMs) === null ||
        observation.observedAtOffsetMs < observed.updatedAtOffsetMs ||
        observation.observedAtOffsetMs - observed.updatedAtOffsetMs >
          DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS ||
        (index > 0 &&
          observation.observedAtOffsetMs <=
            ledger.applicationObservations[index - 1]?.observedAtOffsetMs) ||
        (planned.generation === 1 &&
          (observation.observedAtOffsetMs <
            -DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS ||
            observation.observedAtOffsetMs >= 0))
      ) {
        failures.push(
          `${endpoint} application network-hint observation ${index} is missing or stale`,
        );
      } else {
        generationAuthorityOffsets[planned.generation].push(
          observed.updatedAtOffsetMs,
          observation.observedAtOffsetMs,
        );
        endpointGenerationAuthorityOffsets[endpoint][planned.generation].push(
          observed.updatedAtOffsetMs,
          observation.observedAtOffsetMs,
        );
      }
    }
  }

  const steadyPhases = [
    {
      name: "pristine",
      ...plan.phasePlan.phases.pristine,
      includeEnd: false,
    },
    {
      name: "poor",
      ...plan.phasePlan.phases.poor,
      includeEnd: false,
    },
    {
      name: "recovered",
      ...plan.phasePlan.phases.recovered,
      includeEnd: true,
    },
  ];
  for (const phase of steadyPhases) {
    const coverage = phaseCheckpointCoverage(checkpoints, {
      ...phase,
      predicate: (checkpoint) =>
        DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.every((endpoint) => {
          const expected = expectedHintStateAtSteadyPhase(
            phase.name,
            endpoint,
          );
          const snapshot = checkpoint.endpointSnapshots?.[endpoint];
          return (
            snapshot?.hintGeneration === expected.generation &&
            snapshot?.hintState === expected.state
          );
        }),
    });
    if (
      coverage.qualifyingCoverageRatio <
      DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE
    ) {
      failures.push(
        `${phase.name} checkpoint network-hint coverage ${round(
          coverage.qualifyingCoverageRatio,
        )} is below ${DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE}`,
      );
    }
  }
  const authorityOffset = (generation) => {
    const values = generationAuthorityOffsets[generation];
    return values.length === DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.length * 2
      ? Math.max(...values)
      : null;
  };
  const endpointAuthorityOffset = (endpoint, generation) => {
    const values = endpointGenerationAuthorityOffsets[endpoint][generation];
    return values.length === 2 ? Math.max(...values) : null;
  };
  return assessmentEnvelope({
    harnessFailures: failures,
    generationAuthorityOffsets: {
      pristine: authorityOffset(1),
      poor: authorityOffset(2),
      recovered: authorityOffset(3),
    },
    receiverApplyAtOffsetMs: Math.max(
      endpointAuthorityOffset("primaryReceiver", 2) ?? 0,
      endpointAuthorityOffset("controlReceiver", 2) ?? 0,
    ),
    publisherApplyAtOffsetMs: endpointAuthorityOffset("publisher", 2),
    applyAtOffsetMs: authorityOffset(2),
    clearAtOffsetMs: authorityOffset(3),
  });
};

const assessCdpAuthority = (plan, cdp) => {
  const failures = [];
  const ruleReceipts = [];
  if (
    cdp?.version !== 1 ||
    cdp?.windowId !== plan.measurementWindow.id ||
    cdp?.deprecatedFallbackAllowed !== false ||
    !Array.isArray(cdp?.setup) ||
    !Array.isArray(cdp?.mutations)
  ) {
    return assessmentEnvelope({
      harnessFailures: ["modern CDP mutation ledger is missing or stale"],
      applyAtOffsetMs: null,
      clearAtOffsetMs: null,
    });
  }
  const allMethods = [
    ...cdp.setup.map((entry) => entry?.method),
    ...cdp.mutations.flatMap((mutation) =>
      Array.isArray(mutation?.commands)
        ? mutation.commands.map((command) => command?.method)
        : [],
    ),
  ];
  if (allMethods.includes("Network.emulateNetworkConditions")) {
    failures.push("deprecated Network.emulateNetworkConditions fallback used");
  }
  const targetIds = {};
  const sessionIds = {};
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const setup = cdp.setup.find((entry) => entry?.endpoint === endpoint);
    if (
      !nonEmptyString(setup?.targetId) ||
      !nonEmptyString(setup?.sessionId)
    ) {
      failures.push(`${endpoint} CDP target/session binding is missing`);
      continue;
    }
    targetIds[endpoint] = setup.targetId.trim();
    sessionIds[endpoint] = setup.sessionId.trim();
  }
  if (
    Object.keys(targetIds).length !== 3 ||
    new Set(Object.values(targetIds)).size !== 3 ||
    Object.keys(sessionIds).length !== 3 ||
    new Set(Object.values(sessionIds)).size !== 3
  ) {
    failures.push("CDP target/session bindings must be complete and unique");
  }
  let expected = null;
  try {
    expected = buildDynamicNetworkCdpSchedule(plan, {
      targetIds,
      sessionIds,
    });
  } catch {
    failures.push("CDP target/session binding schedule could not be verified");
  }
  if (!expected) {
    return assessmentEnvelope({
      harnessFailures: failures,
      applyAtOffsetMs: null,
      clearAtOffsetMs: null,
    });
  }
  if (cdp.setup.length !== expected.setup.length) {
    failures.push("Network.enable setup coverage is incomplete");
  } else {
    for (let index = 0; index < expected.setup.length; index += 1) {
      const observed = cdp.setup[index];
      const planned = expected.setup[index];
      if (
        observed?.version !== 1 ||
        observed?.windowId !== plan.measurementWindow.id ||
        observed?.endpoint !== planned.endpoint ||
        observed?.targetId !== planned.targetId ||
        observed?.sessionId !== planned.sessionId ||
        observed?.scheduledAtOffsetMs !== 0 ||
        observed?.method !== "Network.enable" ||
        stableJson(observed?.params) !== stableJson({}) ||
        finite(observed?.enabledAtOffsetMs) === null ||
        observed.enabledAtOffsetMs <
          -DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS ||
        observed.enabledAtOffsetMs >= 0 ||
        observed?.enabledAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs +
            observed.enabledAtOffsetMs ||
        observed?.succeeded !== true
      ) {
        failures.push(`CDP setup ${index} is not an acknowledged Network.enable`);
      }
    }
  }
  const stageAppliedOffsets = new Map([
    [0, []],
    [plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs, []],
    [plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs, []],
    [plan.phasePlan.mutations.clearPoorAtOffsetMs, []],
  ]);
  if (cdp.mutations.length !== expected.mutations.length) {
    failures.push("CDP mutation coverage is incomplete");
  } else {
    for (let index = 0; index < expected.mutations.length; index += 1) {
      const observed = cdp.mutations[index];
      const planned = expected.mutations[index];
      if (
        observed?.version !== 1 ||
        observed?.id !== planned.id ||
        observed?.endpoint !== planned.endpoint ||
        observed?.targetId !== planned.targetId ||
        observed?.sessionId !== planned.sessionId ||
        observed?.state !== planned.state ||
        observed?.scheduledAtOffsetMs !== planned.scheduledAtOffsetMs ||
        finite(observed?.appliedAtOffsetMs) === null ||
        (planned.scheduledAtOffsetMs === 0
          ? observed.appliedAtOffsetMs <
              -DYNAMIC_NETWORK_TRANSITION_INITIALIZATION_LEAD_MS ||
            observed.appliedAtOffsetMs >= 0
          : observed.appliedAtOffsetMs < planned.scheduledAtOffsetMs ||
            observed.appliedAtOffsetMs - planned.scheduledAtOffsetMs >
              DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS) ||
        observed?.appliedAtEpochMs !==
          plan.measurementWindow.startedAtEpochMs +
            observed.appliedAtOffsetMs ||
        (planned.scheduledAtOffsetMs === 0 &&
          observed.appliedAtEpochMs <
            cdp.setup.find(
              (entry) => entry?.endpoint === planned.endpoint,
            )?.enabledAtEpochMs) ||
        !Array.isArray(observed?.commands) ||
        observed.commands.length !== planned.commands.length
      ) {
        failures.push(`CDP mutation ${planned.id} is malformed or late`);
        continue;
      }
      for (
        let commandIndex = 0;
        commandIndex < planned.commands.length;
        commandIndex += 1
      ) {
        const observedCommand = observed.commands[commandIndex];
        const plannedCommand = planned.commands[commandIndex];
        if (
          observedCommand?.method !== plannedCommand.method ||
          stableJson(observedCommand?.params) !==
            stableJson(plannedCommand.params) ||
          observedCommand?.succeeded !== true
        ) {
          failures.push(
            `CDP mutation ${planned.id} command ${commandIndex} was not exactly acknowledged`,
          );
          continue;
        }
        if (
          plannedCommand.method ===
          "Network.emulateNetworkConditionsByRule"
        ) {
          const expectedRuleCount =
            plannedCommand.params.matchedNetworkConditions.length;
          const ruleIds = observedCommand?.result?.ruleIds;
          if (
            !Array.isArray(ruleIds) ||
            ruleIds.length !== expectedRuleCount ||
            ruleIds.some((ruleId) => !nonEmptyString(ruleId)) ||
            new Set(ruleIds).size !== ruleIds.length
          ) {
            failures.push(
              `CDP mutation ${planned.id} did not return ${expectedRuleCount} installed rule id(s)`,
            );
          } else {
            ruleReceipts.push({
              mutationId: planned.id,
              endpoint: planned.endpoint,
              state: planned.state,
              scheduledAtOffsetMs: planned.scheduledAtOffsetMs,
              ruleIds: [...ruleIds],
            });
          }
        } else if (
          plannedCommand.method === "Network.overrideNetworkState" &&
          stableJson(observedCommand?.result) !== stableJson({})
        ) {
          failures.push(
            `CDP mutation ${planned.id} network-state override receipt is malformed`,
          );
        }
      }
      if (
        planned.endpoint === "controlReceiver" &&
        observed.state !== "pristine"
      ) {
        failures.push("control receiver was impaired");
      }
      stageAppliedOffsets
        .get(planned.scheduledAtOffsetMs)
        ?.push(observed.appliedAtOffsetMs);
    }
  }
  const stageAuthorityOffset = (scheduledAtOffsetMs) => {
    const values = stageAppliedOffsets.get(scheduledAtOffsetMs) ?? [];
    return values.length === DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.length
      ? Math.max(...values)
      : null;
  };
  return assessmentEnvelope({
    harnessFailures: failures,
    targetIds,
    sessionIds,
    ruleReceipts,
    pristineAtOffsetMs: stageAuthorityOffset(0),
    receiverApplyAtOffsetMs: stageAuthorityOffset(
      plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
    ),
    publisherApplyAtOffsetMs: stageAuthorityOffset(
      plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    ),
    applyAtOffsetMs: stageAuthorityOffset(
      plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    ),
    clearAtOffsetMs: stageAuthorityOffset(
      plan.phasePlan.mutations.clearPoorAtOffsetMs,
    ),
  });
};

const realizationPhaseCheckpointCount = (stage, range) =>
  (range.endOffsetMs - range.startOffsetMs) /
    DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS +
  (stage === "recovered" ? 1 : 0);

const realizationCheckpointOffsets = (stage, range) => {
  const offsets = [];
  for (
    let offset = range.startOffsetMs;
    stage === "recovered"
      ? offset <= range.endOffsetMs
      : offset < range.endOffsetMs;
    offset += DYNAMIC_NETWORK_TRANSITION_CHECKPOINT_INTERVAL_MS
  ) {
    offsets.push(offset);
  }
  return offsets;
};

const selectedCandidatePairIsUsable = (state) =>
  state === "succeeded" || state === "in-progress";

const deriveRealizationSample = (
  sample,
  { endpoint, stage, windowId, startCheckpoint, endCheckpoint },
) => {
  const expectedStartedAtEpochMs = finite(
    startCheckpoint?.endpointSnapshots?.[endpoint]?.transportEvidence
      ?.capturedAtEpochMs,
  );
  const expectedEndedAtEpochMs = finite(
    endCheckpoint?.endpointSnapshots?.[endpoint]?.transportEvidence
      ?.capturedAtEpochMs,
  );
  const durationMs =
    expectedStartedAtEpochMs !== null && expectedEndedAtEpochMs !== null
      ? expectedEndedAtEpochMs - expectedStartedAtEpochMs
      : null;
  if (
    !sample ||
    sample.version !== 1 ||
    sample.windowId !== windowId ||
    sample.phase !== stage ||
    sample.endpoint !== endpoint ||
    sample.transport?.version !== 1 ||
    !nonEmptyString(sample.transport?.id) ||
    sample.transport?.state !== "connected" ||
    !nonEmptyString(sample.transport?.selectedCandidatePairId) ||
    sample.candidatePair?.version !== 1 ||
    !nonEmptyString(sample.candidatePair?.id) ||
    !nonEmptyString(sample.candidatePair?.transportId) ||
    !nonEmptyString(sample.candidatePair?.localCandidateId) ||
    !nonEmptyString(sample.candidatePair?.remoteCandidateId) ||
    sample.candidatePair?.selected !== true ||
    // Chromium can transiently expose the already-selected pair as
    // `in-progress` while it runs a connectivity check, even though DTLS is
    // connected and media counters continue on the same UDP path. Treat that
    // state as usable; path identity, selection, transport state, and strictly
    // advancing counters remain the causal authority for this proof.
    !selectedCandidatePairIsUsable(sample.candidatePair?.state) ||
    sample.transport.id !== sample.candidatePair.transportId ||
    sample.transport.selectedCandidatePairId !== sample.candidatePair.id ||
    sample.localCandidate?.version !== 1 ||
    sample.localCandidate?.id !== sample.candidatePair.localCandidateId ||
    sample.localCandidate?.transportId !== sample.candidatePair.transportId ||
    String(sample.localCandidate?.protocol).toLowerCase() !== "udp" ||
    !nonEmptyString(sample.localCandidate?.candidateType) ||
    sample.remoteCandidate?.version !== 1 ||
    sample.remoteCandidate?.id !== sample.candidatePair.remoteCandidateId ||
    sample.remoteCandidate?.transportId !== sample.candidatePair.transportId ||
    String(sample.remoteCandidate?.protocol).toLowerCase() !== "udp" ||
    !nonEmptyString(sample.remoteCandidate?.candidateType) ||
    finite(sample.rttMs) === null ||
    sample.rttMs < 0 ||
    !Number.isInteger(sample.packetsStart) ||
    sample.packetsStart < 0 ||
    !Number.isInteger(sample.packetsEnd) ||
    sample.packetsEnd < sample.packetsStart ||
    !Number.isInteger(sample.lostPacketsStart) ||
    sample.lostPacketsStart < 0 ||
    !Number.isInteger(sample.lostPacketsEnd) ||
    sample.lostPacketsEnd < sample.lostPacketsStart ||
    !Number.isInteger(sample.bytesStart) ||
    sample.bytesStart < 0 ||
    !Number.isInteger(sample.bytesEnd) ||
    sample.bytesEnd < sample.bytesStart ||
    finite(sample.sampleStartedAtEpochMs) === null ||
    sample.sampleStartedAtEpochMs !== expectedStartedAtEpochMs ||
    finite(sample.sampleEndedAtEpochMs) === null ||
    sample.sampleEndedAtEpochMs !== expectedEndedAtEpochMs ||
    durationMs === null ||
    durationMs <= 0 ||
    sample.sampleDurationMs !== durationMs ||
    !Number.isInteger(sample.packetCount) ||
    finite(sample.lossRatio) === null ||
    finite(sample.bitrateBps) === null
  ) {
    return null;
  }
  const packetCount = sample.packetsEnd - sample.packetsStart;
  const lostPacketCount =
    sample.lostPacketsEnd - sample.lostPacketsStart;
  const byteCount = sample.bytesEnd - sample.bytesStart;
  const lossRatio = packetCount > 0 ? lostPacketCount / packetCount : null;
  const bitrateBps = (byteCount * 8 * 1_000) / durationMs;
  if (
    packetCount <= 0 ||
    sample.packetCount !== packetCount ||
    lossRatio === null ||
    Math.abs(sample.lossRatio - lossRatio) > 0.000001 ||
    Math.abs(sample.bitrateBps - bitrateBps) > 0.5
  ) {
    return null;
  }
  return {
    candidatePairId: sample.candidatePair.id,
    transportId: sample.candidatePair.transportId,
    localCandidateId: sample.candidatePair.localCandidateId,
    remoteCandidateId: sample.candidatePair.remoteCandidateId,
    rttMs: sample.rttMs,
    packetCount,
    lostPacketCount,
    byteCount,
    lossRatio,
    bitrateBps,
  };
};

export function assessDynamicNetworkRealization(
  realization,
  {
    plan = null,
    checkpoints = null,
    cdpAuthority = null,
    hintAuthority = null,
  } = {},
) {
  const harnessFailures = [];
  const stages = [
    "baseline",
    "receiverLimited",
    "publisherLimited",
    "recovered",
  ];
  const windowId = realization?.windowId;
  if (
    realization?.version !== 2 ||
    !nonEmptyString(windowId) ||
    !isExactTransitionPlan(plan) ||
    windowId !== plan?.measurementWindow?.id ||
    !nonEmptyString(realization?.samplerInstanceId) ||
    !Array.isArray(checkpoints)
  ) {
    harnessFailures.push("UDP realization window binding is missing or stale");
  }
  const checkpointByOffset = new Map(
    Array.isArray(checkpoints)
      ? checkpoints.map((checkpoint) => [
          checkpoint?.scheduledOffsetMs,
          checkpoint,
        ])
      : [],
  );
  const expectedRanges = {
    baseline: DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.pristine,
    receiverLimited:
      DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.downshift,
    publisherLimited: DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.poor,
    recovered: DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.recovered,
  };
  const counterBaselineIds = [];
  const derived = {};
  const expectedCounterAuthority = {
    baseline: 0,
    receiverLimited: Math.max(
      DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.downshift.startOffsetMs,
      finite(cdpAuthority?.receiverApplyAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.downshift.startOffsetMs,
      finite(hintAuthority?.receiverApplyAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.downshift.startOffsetMs,
    ),
    publisherLimited: Math.max(
      DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.poor.startOffsetMs,
      finite(cdpAuthority?.publisherApplyAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.poor.startOffsetMs,
      finite(hintAuthority?.publisherApplyAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.poor.startOffsetMs,
    ),
    recovered: Math.max(
      DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.recovered.startOffsetMs,
      finite(cdpAuthority?.clearAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations.clearPoorAtOffsetMs,
      finite(hintAuthority?.clearAtOffsetMs) ??
        DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations.clearPoorAtOffsetMs,
    ),
  };
  const firstCheckpointStrictlyAfter = (offsetMs) =>
    Array.isArray(checkpoints)
      ? checkpoints.find(
          (checkpoint) => checkpoint?.scheduledOffsetMs > offsetMs,
        ) ?? null
      : null;
  const lastCheckpointStrictlyBefore = (offsetMs) =>
    Array.isArray(checkpoints)
      ? checkpoints
          .filter((checkpoint) => checkpoint?.scheduledOffsetMs < offsetMs)
          .at(-1) ?? null
      : null;
  for (const stage of stages) {
    const stageEvidence = realization?.[stage];
    const expectedRange = expectedRanges[stage];
    const expectedCheckpointCount = realizationPhaseCheckpointCount(
      stage,
      expectedRange,
    );
    const expectedOffsets = realizationCheckpointOffsets(stage, expectedRange);
    const bindings = Array.isArray(stageEvidence?.checkpointBindings)
      ? stageEvidence.checkpointBindings
      : [];
    const computedCoverageRatio =
      bindings.length / expectedCheckpointCount;
    const counterStartCheckpoint =
      stage === "baseline"
        ? checkpointByOffset.get(500) ?? null
        : firstCheckpointStrictlyAfter(expectedCounterAuthority[stage]);
    const counterEndCheckpoint = lastCheckpointStrictlyBefore(
      stage === "baseline"
        ? DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations
            .applyPrimaryReceiverPoorAtOffsetMs
        : stage === "receiverLimited"
          ? DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations
              .applyPublisherPoorAtOffsetMs
          : stage === "publisherLimited"
            ? DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations.clearPoorAtOffsetMs
            : DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.phases.recovered
                .endOffsetMs,
    );
    const seenBindingOffsets = new Set();
    let previousBindingOffset = -Infinity;
    for (const binding of bindings) {
      const checkpoint = checkpointByOffset.get(binding?.scheduledOffsetMs);
      if (
        binding?.version !== 1 ||
        binding?.windowId !== windowId ||
        binding?.samplerInstanceId !== realization?.samplerInstanceId ||
        !expectedOffsets.includes(binding?.scheduledOffsetMs) ||
        seenBindingOffsets.has(binding?.scheduledOffsetMs) ||
        binding?.scheduledOffsetMs <= previousBindingOffset ||
        !checkpoint ||
        binding?.checkpointIndex !== checkpoint.index ||
        binding?.checkpointId !==
          `${windowId}:${realization.samplerInstanceId}:${checkpoint.index}` ||
        binding?.capturedOffsetMs !== checkpoint.capturedOffsetMs ||
        checkpoint?.windowId !== windowId ||
        checkpoint?.samplerInstanceId !== realization.samplerInstanceId
      ) {
        harnessFailures.push(
          `${stage} UDP realization checkpoint binding is missing or stale`,
        );
      }
      if (finite(binding?.scheduledOffsetMs) !== null) {
        seenBindingOffsets.add(binding.scheduledOffsetMs);
        previousBindingOffset = binding.scheduledOffsetMs;
      }
    }
    if (
      stageEvidence?.version !== 1 ||
      stageEvidence?.windowId !== windowId ||
      stageEvidence?.phase !== stage ||
      stageEvidence?.startOffsetMs !== expectedRange.startOffsetMs ||
      stageEvidence?.endOffsetMs !== expectedRange.endOffsetMs ||
      !nonEmptyString(stageEvidence?.counterBaselineId) ||
      stageEvidence?.counterResetDetected !== false ||
      stageEvidence?.requiredAuthorityOffsetMs !==
        expectedCounterAuthority[stage] ||
      stageEvidence?.counterStartCheckpointId !==
        `${windowId}:${realization?.samplerInstanceId}:${counterStartCheckpoint?.index}` ||
      stageEvidence?.counterEndCheckpointId !==
        `${windowId}:${realization?.samplerInstanceId}:${counterEndCheckpoint?.index}` ||
      stageEvidence?.counterStartScheduledOffsetMs !==
        counterStartCheckpoint?.scheduledOffsetMs ||
      stageEvidence?.counterEndScheduledOffsetMs !==
        counterEndCheckpoint?.scheduledOffsetMs ||
      stageEvidence?.counterStartCapturedOffsetMs !==
        counterStartCheckpoint?.capturedOffsetMs ||
      stageEvidence?.counterEndCapturedOffsetMs !==
        counterEndCheckpoint?.capturedOffsetMs ||
      finite(stageEvidence?.counterStartScheduledOffsetMs) === null ||
      finite(stageEvidence?.counterEndScheduledOffsetMs) === null ||
      stageEvidence.counterStartScheduledOffsetMs >=
        stageEvidence.counterEndScheduledOffsetMs ||
      stageEvidence?.expectedCheckpointCount !== expectedCheckpointCount ||
      !Number.isInteger(stageEvidence?.checkpointCount) ||
      stageEvidence.checkpointCount !== bindings.length ||
      stageEvidence.checkpointCount < 0 ||
      stageEvidence.checkpointCount > expectedCheckpointCount ||
      finite(stageEvidence?.checkpointCoverageRatio) === null ||
      Math.abs(
        stageEvidence.checkpointCoverageRatio - computedCoverageRatio,
      ) > 0.000001 ||
      computedCoverageRatio <
        DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE ||
      computedCoverageRatio > 1
    ) {
      harnessFailures.push(
        `${stage} UDP realization phase/counter authority is malformed`,
      );
    }
    if (nonEmptyString(stageEvidence?.counterBaselineId)) {
      counterBaselineIds.push(stageEvidence.counterBaselineId);
    }
    derived[stage] = {};
    for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
      const sample = stageEvidence?.[endpoint];
      const sampleDerived = deriveRealizationSample(sample, {
        endpoint,
        stage,
        windowId,
        startCheckpoint: counterStartCheckpoint,
        endCheckpoint: counterEndCheckpoint,
      });
      if (!sampleDerived) {
        harnessFailures.push(
          `${stage}/${endpoint} UDP candidate-pair counters are missing, reset, or inconsistent`,
        );
      } else {
        derived[stage][endpoint] = sampleDerived;
      }
    }
  }
  if (
    counterBaselineIds.length !== stages.length ||
    new Set(counterBaselineIds).size !== stages.length
  ) {
    harnessFailures.push(
      "phase-specific UDP counter baselines are missing or reused",
    );
  }
  for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
    const pathBindings = stages
      .map((stage) => {
        const sample = derived[stage]?.[endpoint];
        return sample
          ? stableJson({
              candidatePairId: sample.candidatePairId,
              transportId: sample.transportId,
              localCandidateId: sample.localCandidateId,
              remoteCandidateId: sample.remoteCandidateId,
            })
          : null;
      })
      .filter(Boolean);
    if (
      pathBindings.length !== stages.length ||
      new Set(pathBindings).size !== 1
    ) {
      harnessFailures.push(
        `${endpoint} selected UDP candidate/transport path changed across phases`,
      );
    }
    for (let stageIndex = 1; stageIndex < stages.length; stageIndex += 1) {
      const previous = realization?.[stages[stageIndex - 1]]?.[endpoint];
      const current = realization?.[stages[stageIndex]]?.[endpoint];
      if (
        !previous ||
        !current ||
        current.packetsStart < previous.packetsEnd ||
        current.lostPacketsStart < previous.lostPacketsEnd ||
        current.bytesStart < previous.bytesEnd
      ) {
        harnessFailures.push(
          `${endpoint} UDP counters reset or rewound between phases`,
        );
      }
    }
  }
  for (const field of [
    "candidatePairId",
    "transportId",
    "localCandidateId",
    "remoteCandidateId",
  ]) {
    // RTCStats IDs are scoped to one endpoint/peer connection; Chrome commonly
    // uses values such as T01 independently in every browser process.
    const endpointPathIds = DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.map(
      (endpoint) => {
        const id = derived.baseline?.[endpoint]?.[field];
        return nonEmptyString(id) ? stableJson({ endpoint, id }) : null;
      },
    ).filter(Boolean);
    if (
      endpointPathIds.length !== DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.length ||
      new Set(endpointPathIds).size !==
        DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.length
    ) {
      harnessFailures.push(
        `endpoint-scoped UDP ${field} bindings are missing or ambiguous`,
      );
    }
  }
  if (harnessFailures.length > 0) {
    return assessmentEnvelope({
      harnessFailures,
      derived,
    });
  }

  const requireUsefulPackets = (stage, endpoint) => {
    const sample = realization[stage][endpoint];
    if (
      sample.packetCount <
      DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumUsefulPacketCount
    ) {
      harnessFailures.push(
        `${stage}/${endpoint} packet count ${sample.packetCount} is below 50`,
      );
    }
  };
  const requireHealthyBitrate = (stage, endpoint) => {
    const bitrateBps = realization[stage][endpoint].bitrateBps;
    if (
      bitrateBps <=
      DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumHealthyBitrateBps
    ) {
      harnessFailures.push(
        `${stage}/${endpoint} bitrate ${bitrateBps} is not above 1Mbps`,
      );
    }
  };
  const requireShapedCeiling = (stage, endpoint, ceilingBps) => {
    const bitrateBps = realization[stage][endpoint].bitrateBps;
    const ratio = bitrateBps / ceilingBps;
    if (
      ratio <
        DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumImpairedCeilingRatio ||
      ratio >
        DYNAMIC_NETWORK_TRANSITION_LIMITS.maximumImpairedCeilingRatio
    ) {
      harnessFailures.push(
        `${stage}/${endpoint} bitrate-to-configured-ceiling ratio ${round(ratio)} is outside 0.15-1.2`,
      );
    }
  };

  for (const stage of stages) {
    for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
      requireUsefulPackets(stage, endpoint);
    }
  }
  for (const stage of ["baseline", "recovered"]) {
    for (const endpoint of DYNAMIC_NETWORK_TRANSITION_ENDPOINTS) {
      requireHealthyBitrate(stage, endpoint);
    }
  }

  // From 12-24s only the primary receiver is bandwidth-limited. This proves
  // that the 380kbps download rule affected exactly that endpoint while the
  // publisher and control receiver retained useful pristine throughput.
  requireHealthyBitrate("receiverLimited", "publisher");
  requireHealthyBitrate("receiverLimited", "controlReceiver");
  requireShapedCeiling(
    "receiverLimited",
    "primaryReceiver",
    DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES.primaryReceiver.downloadKbps *
      1_000,
  );

  // From 24-36s the publisher's 220kbps upload ceiling source-limits both
  // downstream receivers. Chromium's outbound-rtp bytesSent counter is taken
  // before the CDP upload queue and can therefore describe attempted encoder
  // traffic rather than traffic delivered through that queue. Prove the
  // source ceiling from both receivers' fixed UDP paths instead. Their mutual
  // ratio proves that the independently shaped primary receiver and pristine
  // control receiver saw the same source-limited fanout.
  const publisherUploadCeilingBps =
    DYNAMIC_NETWORK_TRANSITION_POOR_PROFILES.publisher.uploadKbps * 1_000;
  for (const endpoint of ["primaryReceiver", "controlReceiver"]) {
    requireShapedCeiling(
      "publisherLimited",
      endpoint,
      publisherUploadCeilingBps,
    );
  }
  const publisherLimitedPrimaryBitrate =
    realization.publisherLimited.primaryReceiver.bitrateBps;
  const publisherLimitedControlBitrate =
    realization.publisherLimited.controlReceiver.bitrateBps;
  const receiverFanoutRatio =
    publisherLimitedPrimaryBitrate / publisherLimitedControlBitrate;
  if (
    receiverFanoutRatio <
      DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumPublisherFanoutRatio ||
    receiverFanoutRatio >
      DYNAMIC_NETWORK_TRANSITION_LIMITS.maximumPublisherFanoutRatio
  ) {
    harnessFailures.push(
      `publisherLimited receiver-fanout bitrate ratio ${round(receiverFanoutRatio)} is outside 0.6-1.35`,
    );
  }

  return assessmentEnvelope({
    harnessFailures,
    derived,
    diagnostics: {
      rtcRttAndLossCountersAreAuthoritativeForCdpShaping: false,
      publisherOutboundRtpBytesRepresentAttemptedPreNetworkTraffic: true,
      shapingAuthority:
        "acknowledged-CDP-rule-receipts-plus-fixed-downstream-UDP-path-byte-throughput",
    },
  });
}

const codecHardwareMetadataIsValid = (identity) =>
  (nonEmptyString(identity?.implementation) &&
    typeof identity?.powerEfficient === "boolean") ||
  (identity?.implementation === null && identity?.powerEfficient === null);

const codecIdentityIsValid = (identity) =>
  identity &&
  ["video/vp8", "video/vp9"].includes(
    String(identity.mimeType).trim().toLowerCase(),
  ) &&
  Number.isInteger(identity.payloadType) &&
  identity.payloadType >= 96 &&
  identity.payloadType <= 127 &&
  identity.clockRate === 90_000 &&
  typeof identity.fmtp === "string" &&
  nonEmptyString(identity.scalabilityMode) &&
  codecHardwareMetadataIsValid(identity);

const checkpointPublisherAdaptationSignature = (checkpoint) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  return {
    producerId: publisher?.producerId ?? null,
    publishQuality: publisher?.publishQuality ?? null,
    networkProfile: publisher?.networkProfile ?? null,
    networkProfileAuthority: publisher?.networkProfileAuthority ?? null,
    producerTransportId: publisher?.producerTransportId ?? null,
    producerTransportNetworkProfile:
      publisher?.producerTransportNetworkProfile ?? null,
    producerTransportMaxIncomingBitrateBps:
      publisher?.producerTransportMaxIncomingBitrateBps ?? null,
    captureWidth: publisher?.captureWidth ?? null,
    captureHeight: publisher?.captureHeight ?? null,
    captureFps: publisher?.captureFps ?? null,
    encodedWidth: publisher?.encodedWidth ?? null,
    encodedHeight: publisher?.encodedHeight ?? null,
    encodedFps: publisher?.encodedFps ?? null,
    fullLadder: publisher?.fullLadder ?? null,
    senderEncodingConfiguration:
      publisher?.senderEncodingConfiguration ?? null,
  };
};

const checkpointPublisherMatchesAdaptationTarget = (checkpoint, direction) => {
  const publisher = checkpoint?.endpointSnapshots?.publisher;
  return direction === "down"
    ? ((publisher?.publishQuality === "low" &&
        ((publisher?.encodedWidth > 0 &&
          publisher.encodedWidth <= 427 &&
          publisher?.encodedHeight > 0 &&
          publisher.encodedHeight <= 240) ||
          publisherHasContinuousVp9PoorCap(publisher)) &&
        publisher?.fullLadder === false) ||
        (publisher?.publishQuality === "standard" &&
          publisher?.fullLadder === true &&
          (publisherHasStableVp8PoorCaps(publisher) ||
            publisherHasStableVp8TransportPoorBudget(publisher))))
    : publisher?.publishQuality === "standard" &&
        publisher?.networkProfile === "good" &&
        publisher?.encodedWidth >= 960 &&
        publisher?.encodedHeight >= 540 &&
        publisher?.fullLadder === true;
};

export function assessDynamicNetworkCodecContinuity({
  codec,
  continuity,
  plan,
  checkpoints,
  cdpAuthority,
  transitionProofs,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  const identities = codec?.phaseIdentities;
  const lineage = codec?.producerLineage;
  const phaseIdentities = [
    identities?.pristine,
    identities?.poor,
    identities?.recovered,
  ];
  const windowId = plan?.measurementWindow?.id;
  if (
    !isExactTransitionPlan(plan) ||
    codec?.version !== 1 ||
    codec?.windowId !== windowId
  ) {
    harnessFailures.push("codec evidence window binding is missing or stale");
  }
  if (!phaseIdentities.every(codecIdentityIsValid)) {
    harnessFailures.push("phase codec identity evidence is missing or malformed");
  }
  if (
    !lineage ||
    lineage?.version !== 1 ||
    lineage?.windowId !== windowId ||
    !nonEmptyString(lineage.lineageId) ||
    !nonEmptyString(lineage.pristineProducerId) ||
    !nonEmptyString(lineage.poorProducerId) ||
    !nonEmptyString(lineage.recoveredProducerId) ||
    !Array.isArray(lineage.transitions)
  ) {
    harnessFailures.push("producer-lineage evidence is missing or malformed");
  }
  if (
    continuity?.version !== 1 ||
    continuity?.windowId !== windowId
  ) {
    harnessFailures.push("visible-gap evidence window binding is missing or stale");
  }
  const visibility = continuity?.frameVisibility;
  const deriveVisibleGap = (name, declaredGap) => {
    const observation = visibility?.[name];
    const event = observation?.adaptationEvent;
    const proof =
      name === "downshift"
        ? transitionProofs?.downshift
        : transitionProofs?.recoveryFull;
    if (proof?.passed !== true) return null;
    const lastVisibleFrameAtOffsetMs = finite(
      observation?.lastVisibleFrameAtOffsetMs,
    );
    const firstVisibleFrameAtOffsetMs = finite(
      observation?.firstVisibleFrameAtOffsetMs,
    );
    const derivedGap =
      lastVisibleFrameAtOffsetMs !== null &&
      firstVisibleFrameAtOffsetMs !== null
        ? firstVisibleFrameAtOffsetMs - lastVisibleFrameAtOffsetMs
        : null;
    const expectedTransitionRange =
      name === "downshift"
        ? {
            startOffsetMs:
              DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations
                .applyPublisherPoorAtOffsetMs,
            endOffsetMs:
              DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.milestones.downshift
                .deadlineOffsetMs,
          }
        : {
            startOffsetMs:
              DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.mutations
                .clearPoorAtOffsetMs,
            endOffsetMs:
              DYNAMIC_NETWORK_TRANSITION_PHASE_PLAN.milestones.recoveryFull
                .deadlineOffsetMs,
          };
    const eventStartOffsetMs = finite(event?.startOffsetMs);
    const eventEndOffsetMs = finite(event?.endOffsetMs);
    const adaptationIntervalFrameOffsets = Array.isArray(
      observation?.adaptationIntervalFrameOffsets,
    )
      ? observation.adaptationIntervalFrameOffsets.map(finite)
      : null;
    const frameOffsetsAreStrictlyIncreasing =
      adaptationIntervalFrameOffsets !== null &&
      adaptationIntervalFrameOffsets.length >= 2 &&
      adaptationIntervalFrameOffsets.every(
        (offset, index) =>
          offset !== null &&
          offset >= 0 &&
          offset <= DYNAMIC_NETWORK_TRANSITION_WINDOW_MS &&
          (index === 0 ||
            offset > adaptationIntervalFrameOffsets[index - 1]),
      );
    const overlappingFrameGaps =
      frameOffsetsAreStrictlyIncreasing &&
      eventStartOffsetMs !== null &&
      eventEndOffsetMs !== null
        ? adaptationIntervalFrameOffsets
            .slice(1)
            .map((offset, index) => ({
              last: adaptationIntervalFrameOffsets[index],
              first: offset,
              gap: offset - adaptationIntervalFrameOffsets[index],
            }))
            .filter(
              ({ last, first }) =>
                last <= eventEndOffsetMs && first >= eventStartOffsetMs,
            )
        : [];
    const maximumOverlappingFrameGap = overlappingFrameGaps.reduce(
      (maximum, candidate) =>
        !maximum || candidate.gap > maximum.gap ? candidate : maximum,
      null,
    );
    const visibleFrameCountWithinAdaptationInterval =
      frameOffsetsAreStrictlyIncreasing &&
      eventStartOffsetMs !== null &&
      eventEndOffsetMs !== null
        ? adaptationIntervalFrameOffsets.filter(
            (offset) =>
              offset >= eventStartOffsetMs && offset <= eventEndOffsetMs,
          ).length
        : null;
    const previousCheckpoint = Array.isArray(checkpoints)
      ? checkpoints.find(
          (checkpoint) => checkpoint?.index === event?.previousCheckpointIndex,
        )
      : null;
    const observedCheckpoint = Array.isArray(checkpoints)
      ? checkpoints.find(
          (checkpoint) => checkpoint?.index === event?.observedCheckpointIndex,
        )
      : null;
    const cdpAuthorityOffsetMs =
      name === "downshift"
        ? finite(cdpAuthority?.publisherApplyAtOffsetMs)
        : finite(cdpAuthority?.clearAtOffsetMs);
    if (
      observation?.version !== 1 ||
      observation?.windowId !== windowId ||
      observation?.endpoint !== "primaryReceiver" ||
      observation?.targetId !==
        cdpAuthority?.targetIds?.primaryReceiver ||
      observation?.sessionId !==
        cdpAuthority?.sessionIds?.primaryReceiver ||
      !nonEmptyString(observation?.samplerInstanceId) ||
      !Array.isArray(checkpoints) ||
      !checkpoints.every(
        (checkpoint) =>
          checkpoint?.samplerInstanceId === observation.samplerInstanceId,
      ) ||
      !nonEmptyString(observation?.fromProducerId) ||
      !nonEmptyString(observation?.toProducerId) ||
      event?.version !== 1 ||
      event?.direction !== (name === "downshift" ? "down" : "up") ||
      !Number.isInteger(event?.previousCheckpointIndex) ||
      !Number.isInteger(event?.observedCheckpointIndex) ||
      event.observedCheckpointIndex !== event.previousCheckpointIndex + 1 ||
      eventStartOffsetMs === null ||
      eventEndOffsetMs === null ||
      eventEndOffsetMs <= eventStartOffsetMs ||
      eventEndOffsetMs - eventStartOffsetMs >
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS ||
      previousCheckpoint?.capturedOffsetMs !== eventStartOffsetMs ||
      observedCheckpoint?.capturedOffsetMs !== eventEndOffsetMs ||
      stableJson(event?.fromSignature) !==
        stableJson(checkpointPublisherAdaptationSignature(previousCheckpoint)) ||
      stableJson(event?.toSignature) !==
        stableJson(checkpointPublisherAdaptationSignature(observedCheckpoint)) ||
      stableJson(event?.fromSignature) === stableJson(event?.toSignature) ||
      event?.changed !== true ||
      checkpointPublisherMatchesAdaptationTarget(
        previousCheckpoint,
        event.direction,
      ) ||
      !checkpointPublisherMatchesAdaptationTarget(
        observedCheckpoint,
        event.direction,
      ) ||
      observation?.adaptationProofStartOffsetMs !== proof.startOffsetMs ||
      observation?.adaptationProofEndOffsetMs !== proof.endOffsetMs ||
      eventEndOffsetMs > proof.startOffsetMs ||
      cdpAuthorityOffsetMs === null ||
      eventEndOffsetMs < cdpAuthorityOffsetMs ||
      eventStartOffsetMs <
        expectedTransitionRange.startOffsetMs -
          DYNAMIC_NETWORK_TRANSITION_MAXIMUM_CHECKPOINT_GAP_MS ||
      eventEndOffsetMs > expectedTransitionRange.endOffsetMs ||
      !nonEmptyString(observation?.observerId) ||
      observation?.timestampSource !== "requestVideoFrameCallback" ||
      finite(observation?.maximumObservationIntervalMs) === null ||
      observation.maximumObservationIntervalMs <= 0 ||
      observation.maximumObservationIntervalMs > 50 ||
      !frameOffsetsAreStrictlyIncreasing ||
      adaptationIntervalFrameOffsets[0] > eventStartOffsetMs ||
      adaptationIntervalFrameOffsets.at(-1) < eventEndOffsetMs ||
      maximumOverlappingFrameGap === null ||
      observation?.visibleFrameCountWithinAdaptationInterval !==
        visibleFrameCountWithinAdaptationInterval ||
      lastVisibleFrameAtOffsetMs === null ||
      firstVisibleFrameAtOffsetMs === null ||
      lastVisibleFrameAtOffsetMs < 0 ||
      firstVisibleFrameAtOffsetMs > DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
      lastVisibleFrameAtOffsetMs > eventEndOffsetMs ||
      firstVisibleFrameAtOffsetMs < eventStartOffsetMs ||
      firstVisibleFrameAtOffsetMs < expectedTransitionRange.startOffsetMs ||
      firstVisibleFrameAtOffsetMs > expectedTransitionRange.endOffsetMs ||
      derivedGap === null ||
      derivedGap < 0 ||
      maximumOverlappingFrameGap.last !== lastVisibleFrameAtOffsetMs ||
      maximumOverlappingFrameGap.first !== firstVisibleFrameAtOffsetMs ||
      maximumOverlappingFrameGap.gap !== derivedGap ||
      finite(observation?.visibleGapMs) === null ||
      observation.visibleGapMs !== derivedGap ||
      declaredGap !== derivedGap
    ) {
      harnessFailures.push(
        `${name} visibility/adaptation event is not causally bound to exact checkpoints and high-resolution frame timestamps`,
      );
      return null;
    }
    return derivedGap;
  };
  if (
    visibility?.version !== 1 ||
    visibility?.windowId !== windowId
  ) {
    harnessFailures.push("frame-visibility evidence window binding is missing");
  }
  const downGap = deriveVisibleGap(
    "downshift",
    finite(continuity?.downshiftVisibleGapMs),
  );
  const upGap = deriveVisibleGap(
    "recovery",
    finite(continuity?.recoveryVisibleGapMs),
  );
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    harnessFailures.push("codec lineage checkpoints are missing");
  }
  if (
    Array.isArray(lineage?.transitions) &&
    lineage.transitions.some(
      (transition) =>
        transition?.version !== 1 ||
        transition?.windowId !== windowId ||
        transition?.lineageId !== lineage.lineageId ||
        !nonEmptyString(transition?.fromProducerId) ||
        !nonEmptyString(transition?.toProducerId) ||
        finite(transition?.atOffsetMs) === null ||
        transition.atOffsetMs < 0 ||
        transition.atOffsetMs > DYNAMIC_NETWORK_TRANSITION_WINDOW_MS ||
        finite(transition?.eventIntervalStartOffsetMs) === null ||
        finite(transition?.eventIntervalEndOffsetMs) === null ||
        transition.eventIntervalStartOffsetMs >=
          transition.eventIntervalEndOffsetMs ||
        transition.atOffsetMs !== transition.eventIntervalEndOffsetMs ||
        finite(transition?.visibleGapMs) === null ||
        transition.visibleGapMs < 0,
    )
  ) {
    harnessFailures.push("producer-lineage transition window evidence is malformed");
  }
  if (harnessFailures.length > 0) {
    return assessmentEnvelope({ harnessFailures, productFailures });
  }

  const normalizedIdentities = phaseIdentities.map((identity) => ({
    ...identity,
    mimeType: identity.mimeType.trim().toLowerCase(),
  }));
  const stableCodecIdentity = (identity) => ({
    mimeType: identity.mimeType,
    payloadType: identity.payloadType,
    clockRate: identity.clockRate,
    fmtp: identity.fmtp,
    implementation: identity.implementation,
    powerEfficient: identity.powerEfficient,
  });
  if (
    !normalizedIdentities.every(
      (identity) =>
        stableJson(stableCodecIdentity(identity)) ===
        stableJson(stableCodecIdentity(normalizedIdentities[0])),
    )
  ) {
    productFailures.push("codec transport identity changed across network phases");
  }
  if (
    downGap > DYNAMIC_NETWORK_TRANSITION_LIMITS.downshiftVisibleGapMs
  ) {
    productFailures.push(
      `downshift visible gap ${downGap}ms exceeds 700ms`,
    );
  }
  if (upGap > DYNAMIC_NETWORK_TRANSITION_LIMITS.recoveryVisibleGapMs) {
    productFailures.push(`recovery visible gap ${upGap}ms exceeds 250ms`);
  }
  for (const [label, event] of [
    ["downshift", visibility?.downshift?.adaptationEvent],
    ["recovery", visibility?.recovery?.adaptationEvent],
  ]) {
    if (event?.toSignature?.networkProfileAuthority !== "producer-transport") {
      continue;
    }
    if (
      stableJson(event?.fromSignature?.senderEncodingConfiguration) !==
      stableJson(event?.toSignature?.senderEncodingConfiguration)
    ) {
      productFailures.push(
        `${label} producer-transport adaptation mutated live sender parameters`,
      );
    }
  }

  const mimeType = normalizedIdentities[0].mimeType;
  const transitions = lineage.transitions;
  const fmtpProfileId = (fmtp) => {
    const entry = String(fmtp ?? "")
      .split(";")
      .map((part) => part.trim().split("=", 2))
      .find(([key]) => key?.trim().toLowerCase() === "profile-id");
    return entry ? entry[1]?.trim().toLowerCase() ?? "" : "0";
  };
  const vp8FmtpIsCompatible = (fmtp) => {
    const value = String(fmtp ?? "").trim();
    if (value === "") return true;
    const allowedKeys = new Set([
      "x-google-start-bitrate",
      "x-google-min-bitrate",
      "x-google-max-bitrate",
    ]);
    return value.split(";").every((part) => {
      const [rawKey, rawValue, ...extra] = part.split("=");
      const key = rawKey?.trim().toLowerCase();
      const parameterValue = rawValue?.trim();
      return (
        extra.length === 0 &&
        allowedKeys.has(key) &&
        /^\d+$/.test(parameterValue ?? "")
      );
    });
  };
  const vp9ScalabilityModes = ["L2T1", "L2T1", "L2T1"];
  if (mimeType === "video/vp9") {
    if (
      normalizedIdentities.some(
        (identity, index) =>
          fmtpProfileId(identity.fmtp) !== "0" ||
          identity.scalabilityMode !== vp9ScalabilityModes[index],
      )
    ) {
      productFailures.push(
        "VP9 profile-0 must preserve the continuous L2T1 ladder across adaptation",
      );
    }
  } else if (
    mimeType !== "video/vp8" ||
    normalizedIdentities.some(
      (identity) =>
        !vp8FmtpIsCompatible(identity.fmtp) ||
        identity.scalabilityMode !== "L1T1",
    )
  ) {
    productFailures.push("VP8 L1T1 codec identity is required");
  }
  if (
    lineage.pristineProducerId !== lineage.poorProducerId ||
    lineage.poorProducerId !== lineage.recoveredProducerId ||
    transitions.length !== 0
  ) {
    productFailures.push(
      `${mimeType === "video/vp9" ? "VP9" : "VP8"} producer/codec identity did not remain unchanged`,
    );
  }
  const downVisibility = visibility.downshift;
  const recoveryVisibility = visibility.recovery;
  if (
    downVisibility.fromProducerId !== lineage.pristineProducerId ||
    downVisibility.toProducerId !== lineage.pristineProducerId ||
    recoveryVisibility.fromProducerId !== lineage.pristineProducerId ||
    recoveryVisibility.toProducerId !== lineage.pristineProducerId
  ) {
    harnessFailures.push(
      "frame-visibility evidence is detached from the primary producer transition",
    );
  }
  const canBindLineage = transitions.length === 0;
  if (!canBindLineage) {
    harnessFailures.push(
      "checkpoint producer IDs cannot be bound to an exact codec lineage",
    );
  } else {
    for (const checkpoint of checkpoints) {
      const offset = finite(checkpoint?.capturedOffsetMs);
      let expectedProducerId = lineage.pristineProducerId;
      if (
        checkpoint?.windowId !== windowId ||
        offset === null ||
        !DYNAMIC_NETWORK_TRANSITION_ENDPOINTS.every(
          (endpoint) =>
            checkpoint?.endpointSnapshots?.[endpoint]?.producerId ===
            expectedProducerId,
        )
      ) {
        harnessFailures.push(
          `checkpoint ${checkpoint?.index ?? "missing"} producer IDs are detached from codec lineage`,
        );
      }
    }
  }
  return assessmentEnvelope({
    harnessFailures,
    productFailures,
    mimeType,
  });
}

const assessRecoveredPhaseMetrics = (
  phaseMetrics,
  plan,
  checkpoints,
  cdpAuthority,
  sourceTimeline,
) => {
  const harnessFailures = [];
  const productFailures = [];
  const pristinePhase = phaseMetrics?.pristine;
  const recoveredPhase = phaseMetrics?.recovered;
  const baseline = pristinePhase?.primaryReceiver;
  const recovered = recoveredPhase?.primaryReceiver;
  const samplerInstanceIds = new Set(
    Array.isArray(checkpoints)
      ? checkpoints.map((checkpoint) => checkpoint?.samplerInstanceId)
      : [],
  );
  const sourceFrameKeys = new Set();
  const sourceFrameEpochByKey = new Map();
  const sourceGenerations = new Set();
  if (
    sourceTimeline?.version !== 1 ||
    sourceTimeline?.windowId !== plan?.measurementWindow?.id ||
    finite(sourceTimeline?.resetAtEpochMs) === null ||
    sourceTimeline.resetAtEpochMs > plan?.measurementWindow?.startedAtEpochMs ||
    !Array.isArray(sourceTimeline?.sources) ||
    sourceTimeline.sources.length === 0
  ) {
    harnessFailures.push("camera source-generation timeline is missing or stale");
  } else {
    for (const source of sourceTimeline.sources) {
      if (
        source?.version !== 1 ||
        !Number.isInteger(source?.sourceGeneration) ||
        source.sourceGeneration < 1 ||
        sourceGenerations.has(source.sourceGeneration) ||
        !nonEmptyString(source?.timestampMode) ||
        typeof source?.manualFrames !== "boolean" ||
        source?.requestFrameFailureCount !== 0 ||
        !Array.isArray(source?.frames) ||
        source.frames.length === 0
      ) {
        harnessFailures.push("camera source-generation entry is malformed");
        continue;
      }
      sourceGenerations.add(source.sourceGeneration);
      for (const frame of source.frames) {
        const key = `${source.sourceGeneration}:${frame?.sourceSequence}`;
        if (
          frame?.sourceGeneration !== source.sourceGeneration ||
          !Number.isInteger(frame?.sourceSequence) ||
          frame.sourceSequence < 0 ||
          finite(frame?.availableAtEpochMs) === null ||
          sourceFrameKeys.has(key)
        ) {
          harnessFailures.push("camera source frame lineage is malformed");
          continue;
        }
        sourceFrameKeys.add(key);
        sourceFrameEpochByKey.set(key, frame.availableAtEpochMs);
      }
    }
  }
  for (const [label, observed, expected] of [
    ["pristine", pristinePhase, plan?.phasePlan?.phases?.pristine],
    ["recovered", recoveredPhase, plan?.phasePlan?.phases?.recovered],
  ]) {
    if (
      observed?.version !== 1 ||
      observed?.windowId !== plan?.measurementWindow?.id ||
      observed?.phase !== label ||
      observed?.startOffsetMs !== expected?.startOffsetMs ||
      observed?.endOffsetMs !== expected?.endOffsetMs ||
      observed?.targetId !== cdpAuthority?.targetIds?.primaryReceiver ||
      observed?.sessionId !== cdpAuthority?.sessionIds?.primaryReceiver ||
      observed?.metricImplementationVersion !== 1 ||
      observed?.metricImplementation !==
        "conclave-dynamic-video-quality-v1" ||
      observed?.measurementSource !==
        "primary-receiver-rvfc-and-visual-worker" ||
      !nonEmptyString(observed?.visualObserverId) ||
      !nonEmptyString(observed?.presentationObserverId) ||
      finite(observed?.visualSampleIntervalMs) === null ||
      observed.visualSampleIntervalMs <= 0 ||
      observed.visualSampleIntervalMs > 500 ||
      !nonEmptyString(observed?.samplerInstanceId) ||
      samplerInstanceIds.size !== 1 ||
      !samplerInstanceIds.has(observed.samplerInstanceId) ||
      !Array.isArray(observed?.checkpointBindings) ||
      !Array.isArray(observed?.visualMetricSamples) ||
      !Array.isArray(observed?.presentationSamples) ||
      Object.hasOwn(observed, "frameSamples")
    ) {
      harnessFailures.push(`${label} visual phase binding is missing or stale`);
      continue;
    }
    const expectedOffsets = realizationCheckpointOffsets(
      label === "pristine" ? "baseline" : "recovered",
      expected,
    );
    const uniqueOffsets = new Set();
    for (const binding of observed.checkpointBindings) {
      const checkpoint = checkpoints.find(
        (candidate) =>
          candidate.scheduledOffsetMs === binding?.scheduledOffsetMs,
      );
      if (
        binding?.version !== 1 ||
        binding?.windowId !== plan.measurementWindow.id ||
        binding?.samplerInstanceId !== observed.samplerInstanceId ||
        !expectedOffsets.includes(binding?.scheduledOffsetMs) ||
        uniqueOffsets.has(binding?.scheduledOffsetMs) ||
        !checkpoint ||
        binding?.checkpointIndex !== checkpoint.index ||
        binding?.capturedOffsetMs !== checkpoint.capturedOffsetMs
      ) {
        harnessFailures.push(
          `${label} visual checkpoint provenance is missing or stale`,
        );
      }
      uniqueOffsets.add(binding?.scheduledOffsetMs);
    }
    if (
      observed.checkpointBindings.length / expectedOffsets.length <
      DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE
    ) {
      harnessFailures.push(`${label} visual checkpoint coverage is below 0.9`);
    }
    const expectedVisualSampleCount =
      (expected.endOffsetMs - expected.startOffsetMs) /
      observed.visualSampleIntervalMs;
    if (
      observed.visualMetricSamples.length <
        Math.floor(expectedVisualSampleCount * 0.75) ||
      observed.visualMetricSamples.length >
        Math.ceil(expectedVisualSampleCount) + 2 ||
      observed.visualMetricSamples.length * 2 >=
        observed.presentationSamples.length
    ) {
      harnessFailures.push(
        `${label} visual-worker samples are not an independent sparse cadence from rVFC presentations`,
      );
    }
    const visualIds = new Set();
    const visualSourceSequences = new Set();
    let previousVisualOffsetMs = -Infinity;
    let visualScoreTotal = 0;
    const visualSampleGaps = [];
    for (const sample of observed.visualMetricSamples) {
      const capturedAtOffsetMs = finite(sample?.capturedAtOffsetMs);
      if (
        sample?.version !== 1 ||
        !nonEmptyString(sample?.id) ||
        visualIds.has(sample?.id) ||
        sample?.windowId !== plan.measurementWindow.id ||
        sample?.sourceMeasurementWindowId !== plan.measurementWindow.id ||
        sample?.endpoint !== "primaryReceiver" ||
        sample?.targetId !== observed.targetId ||
        sample?.sessionId !== observed.sessionId ||
        sample?.observerId !== observed.visualObserverId ||
        sample?.metricSource !== "dedicated-visual-worker" ||
        !Number.isInteger(sample?.sourceSequence) ||
        sample.sourceSequence < 0 ||
        !Number.isInteger(sample?.sourceGeneration) ||
        !sourceFrameKeys.has(
          `${sample.sourceGeneration}:${sample.sourceSequence}`,
        ) ||
        visualSourceSequences.has(
          `${sample.sourceGeneration}:${sample.sourceSequence}`,
        ) ||
        capturedAtOffsetMs === null ||
        capturedAtOffsetMs <= previousVisualOffsetMs ||
        capturedAtOffsetMs < expected.startOffsetMs ||
        capturedAtOffsetMs >= expected.endOffsetMs ||
        finite(sample?.visualScore) === null ||
        sample.visualScore < 0 ||
        sample.visualScore > 100 ||
        Object.hasOwn(sample, "captureToDisplayMs") ||
        Object.hasOwn(sample, "decoded")
      ) {
        harnessFailures.push(
          `${label} raw visual-worker metric sample is missing or malformed`,
        );
        continue;
      }
      visualSampleGaps.push(
        previousVisualOffsetMs === -Infinity
          ? capturedAtOffsetMs - expected.startOffsetMs
          : capturedAtOffsetMs - previousVisualOffsetMs,
      );
      visualIds.add(sample.id);
      visualSourceSequences.add(
        `${sample.sourceGeneration}:${sample.sourceSequence}`,
      );
      previousVisualOffsetMs = capturedAtOffsetMs;
      visualScoreTotal += sample.visualScore;
    }
    if (previousVisualOffsetMs !== -Infinity) {
      visualSampleGaps.push(expected.endOffsetMs - previousVisualOffsetMs);
    }
    const maximumVisualSampleGapMs =
      visualSampleGaps.length > 0 ? Math.max(...visualSampleGaps) : null;
    if (
      maximumVisualSampleGapMs === null ||
      maximumVisualSampleGapMs >
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_VISUAL_SAMPLE_GAP_MS
    ) {
      harnessFailures.push(
        `${label} raw visual-worker temporal coverage has maximum gap ${
          maximumVisualSampleGapMs ?? "missing"
        }ms`,
      );
    }

    const presentationIds = new Set();
    let previousPresentationOffsetMs = -Infinity;
    const captureToDisplaySamples = [];
    const presentationSampleGaps = [];
    for (const sample of observed.presentationSamples) {
      const capturedAtOffsetMs = finite(sample?.capturedAtOffsetMs);
      const sourceFrameKey = `${sample?.sourceGeneration}:${sample?.sourceSequence}`;
      const sourceAvailableAtEpochMs = sourceFrameEpochByKey.get(sourceFrameKey);
      if (
        sample?.version !== 1 ||
        !nonEmptyString(sample?.id) ||
        presentationIds.has(sample?.id) ||
        sample?.windowId !== plan.measurementWindow.id ||
        sample?.sourceMeasurementWindowId !== plan.measurementWindow.id ||
        sample?.endpoint !== "primaryReceiver" ||
        sample?.targetId !== observed.targetId ||
        sample?.sessionId !== observed.sessionId ||
        sample?.observerId !== observed.presentationObserverId ||
        sample?.timestampSource !== "requestVideoFrameCallback" ||
        !Number.isInteger(sample?.sourceSequence) ||
        sample.sourceSequence < 0 ||
        !Number.isInteger(sample?.sourceGeneration) ||
        !sourceFrameKeys.has(
          `${sample.sourceGeneration}:${sample.sourceSequence}`,
        ) ||
        capturedAtOffsetMs === null ||
        capturedAtOffsetMs <= previousPresentationOffsetMs ||
        capturedAtOffsetMs < expected.startOffsetMs ||
        capturedAtOffsetMs >= expected.endOffsetMs ||
        finite(sample?.presentedAtEpochMs) === null ||
        Math.abs(
          sample.presentedAtEpochMs -
            (plan.measurementWindow.startedAtEpochMs + capturedAtOffsetMs),
        ) > 0.001 ||
        Object.hasOwn(sample, "decoded") ||
        Object.hasOwn(sample, "visualScore") ||
        finite(sample?.captureToDisplayMs) === null ||
        sample.captureToDisplayMs < 0 ||
        finite(sourceAvailableAtEpochMs) === null ||
        Math.abs(
          sample.captureToDisplayMs -
            (sample.presentedAtEpochMs - sourceAvailableAtEpochMs),
        ) > 0.001
      ) {
        harnessFailures.push(
          `${label} raw rVFC presentation sample is missing or malformed`,
        );
        continue;
      }
      presentationSampleGaps.push(
        previousPresentationOffsetMs === -Infinity
          ? capturedAtOffsetMs - expected.startOffsetMs
          : capturedAtOffsetMs - previousPresentationOffsetMs,
      );
      presentationIds.add(sample.id);
      previousPresentationOffsetMs = capturedAtOffsetMs;
      captureToDisplaySamples.push(sample.captureToDisplayMs);
    }
    if (previousPresentationOffsetMs !== -Infinity) {
      presentationSampleGaps.push(
        expected.endOffsetMs - previousPresentationOffsetMs,
      );
    }
    const maximumPresentationSampleGapMs =
      presentationSampleGaps.length > 0
        ? Math.max(...presentationSampleGaps)
        : null;
    if (
      maximumPresentationSampleGapMs === null ||
      maximumPresentationSampleGapMs >
        DYNAMIC_NETWORK_TRANSITION_MAXIMUM_FRAME_SAMPLE_GAP_MS
    ) {
      harnessFailures.push(
        `${label} raw rVFC temporal coverage has maximum gap ${
          maximumPresentationSampleGapMs ?? "missing"
        }ms`,
      );
    }
    const metrics = observed.primaryReceiver;
    const sortedLatency = [...captureToDisplaySamples].sort(
      (left, right) => left - right,
    );
    const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
    const derivedVisualScore =
      observed.visualMetricSamples.length > 0
        ? visualScoreTotal / observed.visualMetricSamples.length
        : null;
    const decodedFrameCount = observed.presentationSamples.length;
    const derivedDecodedFps =
      decodedFrameCount /
      ((expected.endOffsetMs - expected.startOffsetMs) / 1_000);
    const derivedCaptureToDisplayP95Ms = sortedLatency[p95Index] ?? null;
    if (
      observed.visualMetricSamples.length === 0 ||
      observed.presentationSamples.length === 0 ||
      metrics?.visualSampleCount !== observed.visualMetricSamples.length ||
      metrics?.decodedFrameCount !== decodedFrameCount ||
      metrics?.latencySampleCount !== captureToDisplaySamples.length ||
      derivedVisualScore === null ||
      Math.abs(metrics?.visualScore - derivedVisualScore) > 0.000001 ||
      Math.abs(metrics?.decodedFps - derivedDecodedFps) > 0.000001 ||
      derivedCaptureToDisplayP95Ms === null ||
      Math.abs(
        metrics?.captureToDisplayP95Ms -
          derivedCaptureToDisplayP95Ms,
      ) > 0.000001
    ) {
      harnessFailures.push(
        `${label} aggregates are not derived from separate raw visual and rVFC samples`,
      );
    }
  }
  for (const [label, metrics] of [
    ["pristine", baseline],
    ["recovered", recovered],
  ]) {
    if (
      finite(metrics?.visualScore) === null ||
      metrics.visualScore < 0 ||
      metrics.visualScore > 100 ||
      finite(metrics?.decodedFps) === null ||
      metrics.decodedFps < 0 ||
      metrics.decodedFps > 120 ||
      finite(metrics?.captureToDisplayP95Ms) === null
      || metrics.captureToDisplayP95Ms < 0 ||
      !Number.isInteger(metrics?.visualSampleCount) ||
      metrics.visualSampleCount <= 0 ||
      !Number.isInteger(metrics?.decodedFrameCount) ||
      metrics.decodedFrameCount <= 0 ||
      !Number.isInteger(metrics?.latencySampleCount) ||
      metrics.latencySampleCount <= 0
    ) {
      harnessFailures.push(`${label} primary visual baseline is missing`);
    }
  }
  if (harnessFailures.length > 0) {
    return assessmentEnvelope({ harnessFailures, productFailures });
  }
  if (
    baseline.visualScore <
    DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumPristineVisualScore
  ) {
    productFailures.push(
      `pristine visual score ${baseline.visualScore} is below 88`,
    );
  }
  if (
    baseline.decodedFps <
    DYNAMIC_NETWORK_TRANSITION_LIMITS.minimumPristineDecodedFps
  ) {
    productFailures.push(
      `pristine decoded FPS ${baseline.decodedFps} is below 24`,
    );
  }
  if (
    baseline.captureToDisplayP95Ms >
    DYNAMIC_NETWORK_TRANSITION_LIMITS.maximumPristineCaptureToDisplayP95Ms
  ) {
    productFailures.push(
      `pristine capture-to-display p95 ${baseline.captureToDisplayP95Ms}ms exceeds 250ms`,
    );
  }
  if (
    recovered.visualScore <
    baseline.visualScore -
      DYNAMIC_NETWORK_TRANSITION_LIMITS.recoveredVisualScoreDelta
  ) {
    productFailures.push(
      `recovered visual score ${recovered.visualScore} is more than 2 below baseline ${baseline.visualScore}`,
    );
  }
  if (
    recovered.decodedFps <
    baseline.decodedFps -
      DYNAMIC_NETWORK_TRANSITION_LIMITS.recoveredDecodedFpsDelta
  ) {
    productFailures.push(
      `recovered decoded FPS ${recovered.decodedFps} is more than 2 below baseline ${baseline.decodedFps}`,
    );
  }
  if (
    recovered.captureToDisplayP95Ms >
    baseline.captureToDisplayP95Ms +
      DYNAMIC_NETWORK_TRANSITION_LIMITS.recoveredCaptureToDisplayP95DeltaMs
  ) {
    productFailures.push(
      `recovered capture-to-display p95 ${recovered.captureToDisplayP95Ms}ms is more than 50ms above baseline ${baseline.captureToDisplayP95Ms}ms`,
    );
  }
  return assessmentEnvelope({ harnessFailures, productFailures });
};

const findAuthorityBoundProof = (
  checkpoints,
  predicate,
  { notBeforeOffsetMs, deadlineOffsetMs, requiredSustainedMs },
) => {
  if (
    finite(notBeforeOffsetMs) === null ||
    notBeforeOffsetMs >= deadlineOffsetMs
  ) {
    return {
      passed: false,
      authorityAtOffsetMs: notBeforeOffsetMs,
      deadlineAtOffsetMs: deadlineOffsetMs,
      startOffsetMs: null,
      endOffsetMs: null,
      sustainedMs: 0,
      sampleCount: 0,
    };
  }
  return {
    authorityAtOffsetMs: notBeforeOffsetMs,
    deadlineAtOffsetMs: deadlineOffsetMs,
    ...findSustainedCheckpointProof(checkpoints, predicate, {
      notBeforeOffsetMs,
      deadlineOffsetMs,
      requiredSustainedMs,
    }),
  };
};

export function assessDynamicNetworkTransition(evidence) {
  const harnessFailures = [];
  const productFailures = [];
  if (!Array.isArray(evidence?.controllerFailures)) {
    harnessFailures.push("dynamic-network controller failure ledger is missing");
  } else {
    for (const failure of evidence.controllerFailures) {
      harnessFailures.push(`dynamic-network controller: ${String(failure)}`);
    }
  }
  if (
    evidence?.schemaVersion !== DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
  ) {
    harnessFailures.push(
      `dynamic-network transition schema is ${
        evidence?.schemaVersion ?? "missing"
      }; expected ${DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION}`,
    );
  }
  const plan = evidence?.plan;
  if (!isExactTransitionPlan(plan)) {
    harnessFailures.push("dynamic-network transition plan is missing or altered");
  }
  if (stableJson(evidence?.topology) !== stableJson(expectedTopology)) {
    harnessFailures.push(
      "dynamic-network topology must be one publisher plus primary/control receivers",
    );
  }
  if (!isExactTransitionPlan(plan)) {
    return assessmentEnvelope({
      harnessFailures,
      productFailures,
      checkpointAuthority: null,
      phases: null,
      transitionDurationsMs: null,
      continuity: null,
    });
  }

  const checkpointAuthority = assessDynamicNetworkCheckpointAuthority({
    plan,
    sampler: evidence?.sampler,
  });
  prefixFailures(
    harnessFailures,
    "continuous sampler",
    checkpointAuthority.failures,
  );
  const cdpAuthority = assessCdpAuthority(plan, evidence?.cdp);
  prefixFailures(harnessFailures, "CDP", cdpAuthority.failures);
  const hintAuthority = assessHintLedgers(
    plan,
    evidence?.networkHints,
    checkpointAuthority.checkpoints,
    cdpAuthority,
  );
  prefixFailures(harnessFailures, "network hints", hintAuthority.failures);

  const checkpoints = checkpointAuthority.checkpoints;
  const receiverApplyAuthorityAtOffsetMs = Math.max(
    plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
    finite(cdpAuthority.receiverApplyAtOffsetMs) ??
      plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
    finite(hintAuthority.receiverApplyAtOffsetMs) ??
      plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
  );
  const publisherApplyAuthorityAtOffsetMs = Math.max(
    plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    finite(cdpAuthority.publisherApplyAtOffsetMs) ??
      plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    finite(hintAuthority.publisherApplyAtOffsetMs) ??
      plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
  );
  const clearAuthorityAtOffsetMs = Math.max(
    plan.phasePlan.mutations.clearPoorAtOffsetMs,
    finite(cdpAuthority.clearAtOffsetMs) ??
      plan.phasePlan.mutations.clearPoorAtOffsetMs,
    finite(hintAuthority.clearAtOffsetMs) ??
      plan.phasePlan.mutations.clearPoorAtOffsetMs,
  );
  const receiverIsolationDeadlineAtOffsetMs =
    resolveAuthorityRelativeDeadline({
      authorityAtOffsetMs: receiverApplyAuthorityAtOffsetMs,
      scheduledAtOffsetMs:
        plan.phasePlan.mutations.applyPrimaryReceiverPoorAtOffsetMs,
      plannedDeadlineOffsetMs:
        plan.phasePlan.milestones.receiverIsolation.deadlineOffsetMs,
    });
  const downshiftDeadlineAtOffsetMs = resolveAuthorityRelativeDeadline({
    authorityAtOffsetMs: publisherApplyAuthorityAtOffsetMs,
    scheduledAtOffsetMs:
      plan.phasePlan.mutations.applyPublisherPoorAtOffsetMs,
    plannedDeadlineOffsetMs:
      plan.phasePlan.milestones.downshift.deadlineOffsetMs,
  });
  const recoveryGoodDeadlineAtOffsetMs = resolveAuthorityRelativeDeadline({
    authorityAtOffsetMs: clearAuthorityAtOffsetMs,
    scheduledAtOffsetMs: plan.phasePlan.mutations.clearPoorAtOffsetMs,
    plannedDeadlineOffsetMs:
      plan.phasePlan.milestones.recoveryGood.deadlineOffsetMs,
  });
  const recoveryFullDeadlineAtOffsetMs = resolveAuthorityRelativeDeadline({
    authorityAtOffsetMs: clearAuthorityAtOffsetMs,
    scheduledAtOffsetMs: plan.phasePlan.mutations.clearPoorAtOffsetMs,
    plannedDeadlineOffsetMs:
      plan.phasePlan.milestones.recoveryFull.deadlineOffsetMs,
  });
  const receiverIsolation = findAuthorityBoundProof(
    checkpoints,
    receiverIsolationCheckpointPassed,
    {
      notBeforeOffsetMs: receiverApplyAuthorityAtOffsetMs,
      deadlineOffsetMs: receiverIsolationDeadlineAtOffsetMs,
      requiredSustainedMs:
        plan.phasePlan.milestones.receiverIsolation.requiredSustainedMs,
    },
  );
  const downshift = findAuthorityBoundProof(
    checkpoints,
    dynamicNetworkDownshiftCheckpointPassed,
    {
      notBeforeOffsetMs: publisherApplyAuthorityAtOffsetMs,
      deadlineOffsetMs: downshiftDeadlineAtOffsetMs,
      requiredSustainedMs:
        plan.phasePlan.milestones.downshift.requiredSustainedMs,
    },
  );
  const recoveryGood = findAuthorityBoundProof(
    checkpoints,
    dynamicNetworkRecoveryGoodCheckpointPassed,
    {
      notBeforeOffsetMs: clearAuthorityAtOffsetMs,
      deadlineOffsetMs: recoveryGoodDeadlineAtOffsetMs,
      requiredSustainedMs:
        plan.phasePlan.milestones.recoveryGood.requiredSustainedMs,
    },
  );
  const recoveryFull = findAuthorityBoundProof(
    checkpoints,
    dynamicNetworkRecoveryFullCheckpointPassed,
    {
      notBeforeOffsetMs: clearAuthorityAtOffsetMs,
      deadlineOffsetMs: recoveryFullDeadlineAtOffsetMs,
      requiredSustainedMs:
        plan.phasePlan.milestones.recoveryFull.requiredSustainedMs,
    },
  );
  if (!receiverIsolation.passed) {
    productFailures.push(
      "primary receiver did not downshift for 2s while publisher/control remained pristine and full-ladder",
    );
  }
  if (!downshift.passed) {
    productFailures.push(
      "publisher/primary downshift and pristine control were not sustained for 2s by 12s after apply",
    );
  }
  if (!recoveryGood.passed) {
    productFailures.push(
      "publisher/receivers did not sustain good recovery for 3s by 10s after clear",
    );
  }
  if (!recoveryFull.passed) {
    productFailures.push(
      "standard 960x540@24 full-ladder/top-layer recovery was not sustained for 3s by 55s after clear",
    );
  }

  const poorCoverage = phaseCheckpointCoverage(checkpoints, {
    ...plan.phasePlan.phases.poor,
    predicate: dynamicNetworkDownshiftCheckpointPassed,
  });
  if (
    poorCoverage.qualifyingCoverageRatio <
    DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE
  ) {
    productFailures.push(
      `poor 12s phase qualifying coverage ${round(
        poorCoverage.qualifyingCoverageRatio,
      )} is below 0.9`,
    );
  }
  const recoveredCoverage = phaseCheckpointCoverage(checkpoints, {
    ...plan.phasePlan.phases.recovered,
    includeEnd: true,
    predicate: dynamicNetworkRecoveryFullCheckpointPassed,
  });
  if (
    recoveredCoverage.qualifyingCoverageRatio <
    DYNAMIC_NETWORK_TRANSITION_MINIMUM_COVERAGE
  ) {
    productFailures.push(
      `recovered 12s phase qualifying coverage ${round(
        recoveredCoverage.qualifyingCoverageRatio,
      )} is below 0.9`,
    );
  }

  const recoveredMetrics = assessRecoveredPhaseMetrics(
    evidence?.phaseMetrics,
    plan,
    checkpoints,
    cdpAuthority,
    evidence?.sourceTimeline,
  );
  prefixFailures(
    harnessFailures,
    "phase metrics",
    recoveredMetrics.harnessFailures,
  );
  prefixFailures(
    productFailures,
    "phase metrics",
    recoveredMetrics.productFailures,
  );
  const realization = assessDynamicNetworkRealization(
    evidence?.networkRealization,
    { plan, checkpoints, cdpAuthority, hintAuthority },
  );
  prefixFailures(
    harnessFailures,
    "network realization",
    realization.harnessFailures,
  );
  prefixFailures(
    productFailures,
    "network realization",
    realization.productFailures,
  );
  const codecContinuity = assessDynamicNetworkCodecContinuity({
    codec: evidence?.codec,
    continuity: evidence?.continuity,
    plan,
    checkpoints,
    cdpAuthority,
    transitionProofs: {
      receiverIsolation,
      downshift,
      recoveryGood,
      recoveryFull,
    },
  });
  prefixFailures(
    harnessFailures,
    "codec continuity",
    codecContinuity.harnessFailures,
  );
  prefixFailures(
    productFailures,
    "codec continuity",
    codecContinuity.productFailures,
  );

  return assessmentEnvelope({
    harnessFailures,
    productFailures,
    checkpointAuthority,
    transitionProofs: {
      receiverIsolation,
      downshift,
      recoveryGood,
      recoveryFull,
    },
    phaseCoverage: {
      poor: poorCoverage,
      recovered: recoveredCoverage,
    },
    cdpAuthority,
    hintAuthority,
    phaseMetrics: recoveredMetrics,
    networkRealization: realization,
    codecContinuity,
    phases: plan.phasePlan.phases,
    transitionDurationsMs: {
      downshift:
        downshift.passed
          ? downshift.endOffsetMs - publisherApplyAuthorityAtOffsetMs
          : null,
      receiverIsolation:
        receiverIsolation.passed
          ? receiverIsolation.endOffsetMs - receiverApplyAuthorityAtOffsetMs
          : null,
      recoveryGood:
        recoveryGood.passed
          ? recoveryGood.endOffsetMs - clearAuthorityAtOffsetMs
          : null,
      recoveryFull:
        recoveryFull.passed
          ? recoveryFull.endOffsetMs - clearAuthorityAtOffsetMs
          : null,
    },
    continuity: evidence?.continuity ?? null,
  });
}
