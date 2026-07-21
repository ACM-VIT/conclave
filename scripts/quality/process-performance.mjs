import { createHash } from "node:crypto";

export const PROCESS_PERFORMANCE_VERSION = 2;
export const PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS = 500;
export const PROCESS_PERFORMANCE_MAXIMUM_TICK_LATENESS_MS = 50;
export const PROCESS_PERFORMANCE_MAXIMUM_CAPTURE_DURATION_MS = 250;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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

const cloneAndDeepFreeze = (value) => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndDeepFreeze(entry)));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndDeepFreeze(entry),
        ]),
      ),
    );
  }
  return value;
};

const nearestRank = (values, percentile) => {
  const usable = values
    .map(finite)
    .filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const rank = Math.max(1, Math.ceil(percentile * usable.length));
  return usable[Math.min(usable.length - 1, rank - 1)];
};

const normalizeProcessType = (value) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;

const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;

const memoryBucketGiB = (totalMemoryBytes) => {
  const bytes = finite(totalMemoryBytes);
  if (bytes === null || bytes <= 0) return null;
  const gib = bytes / 1024 ** 3;
  return 2 ** Math.max(0, Math.ceil(Math.log2(gib)));
};

const sanitizeGpuDevice = (device) => ({
  vendorId: finite(device?.vendorId),
  deviceId: finite(device?.deviceId),
  vendorString: nonempty(device?.vendorString),
  deviceString: nonempty(device?.deviceString),
  driverVendor: nonempty(device?.driverVendor),
  driverVersion: nonempty(device?.driverVersion),
});

const meaningfulGpuDevice = (device) =>
  (device.vendorId !== null &&
    device.deviceId !== null &&
    (device.vendorId !== 0 || device.deviceId !== 0)) ||
  (device.vendorString !== null && device.deviceString !== null);

export function normalizeProcessMeasurementWindow(value) {
  const id = nonempty(value?.id);
  const startedAtEpochMs = finite(value?.startedAtEpochMs);
  const endedAtEpochMs = finite(value?.endedAtEpochMs);
  const durationMs = finite(value?.durationMs);
  if (
    value?.version !== 1 ||
    !id ||
    startedAtEpochMs === null ||
    endedAtEpochMs === null ||
    durationMs === null ||
    !Number.isInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs % PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS !== 0 ||
    endedAtEpochMs <= startedAtEpochMs ||
    Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) > 1
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    id,
    startedAtEpochMs,
    endedAtEpochMs,
    durationMs,
  });
}

export function buildHardwareIdentity({
  browserVersion,
  systemInfo,
  platform,
  architecture,
  osRelease,
  logicalCpuCount,
  totalMemoryBytes,
} = {}) {
  const gpuDevices = (systemInfo?.gpu?.devices ?? [])
    .map(sanitizeGpuDevice)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const identity = canonicalize({
    version: 2,
    platform: nonempty(platform),
    architecture: nonempty(architecture),
    osRelease: nonempty(osRelease),
    logicalCpuCount:
      Number.isInteger(logicalCpuCount) && logicalCpuCount > 0
        ? logicalCpuCount
        : null,
    memoryBucketGiB: memoryBucketGiB(totalMemoryBytes),
    gpu: { devices: gpuDevices },
    chrome: {
      product: nonempty(browserVersion?.product),
      protocolVersion: nonempty(browserVersion?.protocolVersion),
      jsVersion: nonempty(browserVersion?.jsVersion),
    },
  });
  const missingFields = [];
  for (const field of [
    "platform",
    "architecture",
    "osRelease",
    "logicalCpuCount",
    "memoryBucketGiB",
  ]) {
    if (identity[field] == null) missingFields.push(field);
  }
  if (!identity.chrome.product) missingFields.push("chrome.product");
  if (!identity.chrome.protocolVersion) {
    missingFields.push("chrome.protocolVersion");
  }
  if (identity.gpu.devices.length === 0) {
    missingFields.push("gpu.devices");
  } else {
    identity.gpu.devices.forEach((device, index) => {
      if (!meaningfulGpuDevice(device)) {
        missingFields.push(`gpu.devices[${index}].identity`);
      }
    });
  }
  return {
    ...identity,
    complete: missingFields.length === 0,
    missingFields,
    hardwareIdentityId: createHash("sha256")
      .update(stableJson(identity))
      .digest("hex"),
  };
}

const normalizeProcessInfo = (processInfo) =>
  (Array.isArray(processInfo) ? processInfo : []).map((process) => ({
    id: finite(process?.id),
    type: normalizeProcessType(process?.type),
    cpuTimeSeconds: finite(process?.cpuTime),
  }));

export async function captureBrowserProcessSnapshot(
  browserCdp,
  {
    label,
    phase = "interval",
    measurementWindowId,
    expectedBrowserPid,
    hardwareIdentityId,
    now = Date.now,
  } = {},
) {
  const requestedAtEpochMs = now();
  const response = await browserCdp.send("SystemInfo.getProcessInfo");
  const completedAtEpochMs = now();
  return {
    version: PROCESS_PERFORMANCE_VERSION,
    label: nonempty(label),
    phase: nonempty(phase),
    measurementWindowId: nonempty(measurementWindowId),
    expectedBrowserPid: finite(expectedBrowserPid),
    hardwareIdentityId: nonempty(hardwareIdentityId),
    requestedAtEpochMs,
    completedAtEpochMs,
    requestDurationMs: round(completedAtEpochMs - requestedAtEpochMs, 3),
    processes: normalizeProcessInfo(response?.processInfo),
  };
}

export function startBrowserProcessObserver(
  browserCdp,
  {
    label,
    measurementWindow,
    expectedBrowserPid,
    hardwareIdentityId,
    observationIntervalMs = PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS,
    maximumTickLatenessMs =
      PROCESS_PERFORMANCE_MAXIMUM_TICK_LATENESS_MS,
    maximumCaptureDurationMs =
      PROCESS_PERFORMANCE_MAXIMUM_CAPTURE_DURATION_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const window = normalizeProcessMeasurementWindow(measurementWindow);
  if (!window) throw new TypeError("valid process measurementWindow is required");
  if (observationIntervalMs !== PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS) {
    throw new TypeError("process observation interval must be exactly 500ms");
  }
  if (
    !Number.isInteger(window.durationMs) ||
    window.durationMs % observationIntervalMs !== 0
  ) {
    throw new TypeError("process measurement duration must be divisible by 500ms");
  }
  if (
    !Number.isFinite(maximumTickLatenessMs) ||
    maximumTickLatenessMs < 0 ||
    !Number.isFinite(maximumCaptureDurationMs) ||
    maximumCaptureDurationMs <= 0
  ) {
    throw new TypeError("process observer timing limits are invalid");
  }
  const targets = Array.from(
    { length: window.durationMs / observationIntervalMs + 1 },
    (_, index) => ({
      index,
      phase:
        index === 0
          ? "boundary-start"
          : index === window.durationMs / observationIntervalMs
            ? "boundary-end"
            : "interval",
      scheduledAtEpochMs:
        window.startedAtEpochMs + index * observationIntervalMs,
    }),
  );
  const observations = [];
  let skippedTickCount = 0;
  let lateTickCount = 0;
  let overlapTickCount = 0;
  let slowCaptureCount = 0;
  let captureErrorCount = 0;
  let inFlight = null;
  let maximumConcurrentCaptures = 0;
  let concurrentCaptures = 0;
  let result = null;
  const invokedIndexes = new Set();
  const timers = new Set();
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  const sample = async (target, invokedAtEpochMs, tickLatenessMs) => {
    try {
      const snapshot = await captureBrowserProcessSnapshot(browserCdp, {
        label,
        phase: target.phase,
        measurementWindowId: window.id,
        expectedBrowserPid,
        hardwareIdentityId,
        now,
      });
      if (snapshot.requestDurationMs > maximumCaptureDurationMs) {
        slowCaptureCount += 1;
        skippedTickCount += 1;
      }
      observations.push({
        ...snapshot,
        targetIndex: target.index,
        scheduledAtEpochMs: target.scheduledAtEpochMs,
        invokedAtEpochMs,
        tickLatenessMs,
      });
    } catch (error) {
      captureErrorCount += 1;
      skippedTickCount += 1;
      const completedAtEpochMs = now();
      observations.push({
        version: PROCESS_PERFORMANCE_VERSION,
        label,
        phase: target.phase,
        measurementWindowId: window.id,
        expectedBrowserPid,
        hardwareIdentityId,
        targetIndex: target.index,
        scheduledAtEpochMs: target.scheduledAtEpochMs,
        invokedAtEpochMs,
        tickLatenessMs,
        requestedAtEpochMs: invokedAtEpochMs,
        completedAtEpochMs,
        requestDurationMs: round(completedAtEpochMs - invokedAtEpochMs, 3),
        captureError: error instanceof Error ? error.message : String(error),
        processes: [],
      });
    }
  };

  const invoke = (target) => {
    const invokedAtEpochMs = now();
    invokedIndexes.add(target.index);
    const tickLatenessMs = Math.max(
      0,
      invokedAtEpochMs - target.scheduledAtEpochMs,
    );
    if (tickLatenessMs > maximumTickLatenessMs) {
      lateTickCount += 1;
      skippedTickCount += 1;
    }
    if (inFlight) {
      overlapTickCount += 1;
      skippedTickCount += 1;
      return inFlight;
    }
    concurrentCaptures += 1;
    maximumConcurrentCaptures = Math.max(
      maximumConcurrentCaptures,
      concurrentCaptures,
    );
    const task = sample(target, invokedAtEpochMs, tickLatenessMs).finally(() => {
      concurrentCaptures = Math.max(0, concurrentCaptures - 1);
      if (inFlight === task) inFlight = null;
    });
    inFlight = task;
    return task;
  };

  const finish = () => {
    if (result) return;
    for (const target of targets) {
      if (!invokedIndexes.has(target.index)) skippedTickCount += 1;
    }
    const frozenObservations = cloneAndDeepFreeze(observations);
    result = cloneAndDeepFreeze({
      version: PROCESS_PERFORMANCE_VERSION,
      label,
      measurementWindow: window,
      measurementWindowId: window.id,
      observationIntervalMs,
      maximumTickLatenessMs,
      maximumCaptureDurationMs,
      scheduledObservationCount: targets.length,
      completedObservationCount: frozenObservations.length,
      skippedTickCount,
      lateTickCount,
      overlapTickCount,
      slowCaptureCount,
      captureErrorCount,
      maximumConcurrentCaptures,
      observations: frozenObservations,
    });
    resolveCompletion(result);
  };

  for (const target of targets) {
    let timer = null;
    timer = setTimer(() => {
      timers.delete(timer);
      const task = invoke(target);
      if (target.phase === "boundary-end") {
        for (const pendingTimer of timers) clearTimer(pendingTimer);
        timers.clear();
        void Promise.resolve(task).finally(finish);
      }
    }, Math.max(0, target.scheduledAtEpochMs - now()));
    timer?.unref?.();
    timers.add(timer);
  }

  return Object.freeze({
    measurementWindow: window,
    stop() {
      return completion;
    },
  });
}

const indexProcesses = (snapshot, failures, phase) => {
  const index = new Map();
  const pidTypes = new Map();
  if (!Array.isArray(snapshot?.processes) || snapshot.processes.length === 0) {
    failures.push(`${phase} process list is missing or empty`);
    return { index, pidTypes };
  }
  for (const process of snapshot.processes) {
    const id = finite(process?.id);
    const type = normalizeProcessType(process?.type);
    const cpuTimeSeconds = finite(process?.cpuTimeSeconds);
    if (
      id === null ||
      !Number.isInteger(id) ||
      id <= 0 ||
      !type ||
      cpuTimeSeconds === null ||
      cpuTimeSeconds < 0
    ) {
      failures.push(`${phase} process evidence contains an invalid entry`);
      continue;
    }
    const key = `${id}:${type}`;
    if (index.has(key)) {
      failures.push(`${phase} process evidence duplicates ${key}`);
      continue;
    }
    if (pidTypes.has(id) && pidTypes.get(id) !== type) {
      failures.push(`${phase} PID ${id} has mismatched process types`);
    }
    pidTypes.set(id, type);
    index.set(key, { id, type, cpuTimeSeconds });
  }
  return { index, pidTypes };
};

export function assessBrowserProcessPerformance({
  label,
  role,
  observations,
  measurementWindow,
  observationIntervalMs = PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS,
  scheduledObservationCount,
  completedObservationCount,
  skippedTickCount = 0,
  lateTickCount = 0,
  overlapTickCount = 0,
  slowCaptureCount = 0,
  captureErrorCount = 0,
  maximumConcurrentCaptures = 1,
  maximumCoreEquivalents,
  maximumP95CoreEquivalents = null,
  maximumIntervalCoreEquivalents = null,
  minimumIntervalMs = 350,
  maximumIntervalMs = 600,
  maximumBoundarySkewMs = 600,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  const window = normalizeProcessMeasurementWindow(measurementWindow);
  if (!window) harnessFailures.push("process measurement window is missing or invalid");
  if (!label) harnessFailures.push("process performance label is missing");
  if (
    !["publisher", "primary-visual-receiver", "passive-telemetry-receiver"].includes(
      role,
    )
  ) {
    harnessFailures.push("process performance role is missing or unsupported");
  }
  if (
    observationIntervalMs !== PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS ||
    !Number.isInteger(skippedTickCount) ||
    skippedTickCount !== 0 ||
    !Number.isInteger(lateTickCount) ||
    lateTickCount !== 0 ||
    !Number.isInteger(overlapTickCount) ||
    overlapTickCount !== 0 ||
    !Number.isInteger(slowCaptureCount) ||
    slowCaptureCount !== 0 ||
    !Number.isInteger(captureErrorCount) ||
    captureErrorCount !== 0 ||
    maximumConcurrentCaptures !== 1
  ) {
    harnessFailures.push("process observer cadence authority is missing or skipped");
  }
  const expectedObservationCount =
    window &&
    Number.isInteger(window.durationMs) &&
    window.durationMs % PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS === 0
      ? window.durationMs / PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS + 1
      : null;
  const list = (Array.isArray(observations) ? observations : [])
    .slice()
    .sort(
      (left, right) =>
        (finite(left?.scheduledAtEpochMs) ?? 0) -
        (finite(right?.scheduledAtEpochMs) ?? 0),
    );
  if (
    expectedObservationCount === null ||
    scheduledObservationCount !== expectedObservationCount ||
    completedObservationCount !== expectedObservationCount ||
    list.length !== expectedObservationCount
  ) {
    harnessFailures.push("continuous process observations are sparse or miscounted");
  }

  const expectedPid = finite(list[0]?.expectedBrowserPid);
  const hardwareIdentityId = nonempty(list[0]?.hardwareIdentityId);
  for (let index = 0; index < list.length; index += 1) {
    const snapshot = list[index];
    if (snapshot?.version !== PROCESS_PERFORMANCE_VERSION) {
      harnessFailures.push(`process observation ${index} is missing or legacy`);
    }
    if (nonempty(snapshot?.captureError)) {
      harnessFailures.push(
        `process observation ${index} capture failed: ${snapshot.captureError}`,
      );
    }
    if (snapshot?.label !== label) {
      harnessFailures.push(`process observation ${index} label is mismatched`);
    }
    if (!window || snapshot?.measurementWindowId !== window.id) {
      harnessFailures.push(`process observation ${index} belongs to another window`);
    }
    if (
      expectedPid === null ||
      !Number.isInteger(expectedPid) ||
      expectedPid <= 0 ||
      finite(snapshot?.expectedBrowserPid) !== expectedPid
    ) {
      harnessFailures.push("expected Chrome browser PID is missing or changed");
    }
    if (!hardwareIdentityId || snapshot?.hardwareIdentityId !== hardwareIdentityId) {
      harnessFailures.push("process observation hardware identity changed");
    }
    const expectedScheduledAt =
      window?.startedAtEpochMs +
      index * PROCESS_PERFORMANCE_OBSERVATION_INTERVAL_MS;
    const scheduledAt = finite(snapshot?.scheduledAtEpochMs);
    const requestedAt = finite(snapshot?.requestedAtEpochMs);
    const completedAt = finite(snapshot?.completedAtEpochMs);
    const requestDurationMs = finite(snapshot?.requestDurationMs);
    const expectedPhase =
      index === 0
        ? "boundary-start"
        : index === list.length - 1
          ? "boundary-end"
          : "interval";
    if (
      !window ||
      snapshot?.targetIndex !== index ||
      snapshot?.phase !== expectedPhase ||
      scheduledAt !== expectedScheduledAt ||
      requestedAt === null ||
      Math.abs(requestedAt - scheduledAt) >
        PROCESS_PERFORMANCE_MAXIMUM_TICK_LATENESS_MS ||
      completedAt === null ||
      completedAt < requestedAt ||
      requestDurationMs === null ||
      Math.abs(completedAt - requestedAt - requestDurationMs) > 1 ||
      requestDurationMs > PROCESS_PERFORMANCE_MAXIMUM_CAPTURE_DURATION_MS
    ) {
      harnessFailures.push(
        `process observation ${index} missed its exact absolute target`,
      );
    }
  }

  const evidence = list;
  if (window && evidence.length > 0) {
    const firstRequestedAt = finite(evidence[0]?.requestedAtEpochMs);
    const lastRequestedAt = finite(evidence.at(-1)?.requestedAtEpochMs);
    if (
      firstRequestedAt === null ||
      Math.abs(firstRequestedAt - window.startedAtEpochMs) >
        maximumBoundarySkewMs ||
      lastRequestedAt === null ||
      Math.abs(lastRequestedAt - window.endedAtEpochMs) > maximumBoundarySkewMs
    ) {
      harnessFailures.push("process observation envelope boundary skew is excessive");
    }
  }

  const indexed = evidence.map((snapshot, index) =>
    indexProcesses(snapshot, harnessFailures, `observation ${index}`),
  );
  if (expectedPid !== null) {
    indexed.forEach((entry, index) => {
      if (!entry.index.has(`${expectedPid}:browser`)) {
        harnessFailures.push(
          `process observation ${index} does not contain the exact Chrome browser PID`,
        );
      }
    });
  }

  const allProcessKeys = new Set(
    indexed.flatMap((entry) => Array.from(entry.index.keys())),
  );
  const persistentProcessKeys = new Set(
    Array.from(allProcessKeys).filter((key) =>
      indexed.every((entry) => entry.index.has(key)),
    ),
  );
  const processTypeByKey = new Map();
  for (const entry of indexed) {
    for (const [key, process] of entry.index) {
      processTypeByKey.set(key, process.type);
    }
  }
  const observedRendererCount = Array.from(allProcessKeys).filter(
    (key) => processTypeByKey.get(key) === "renderer",
  ).length;
  const persistentRendererCount = Array.from(persistentProcessKeys).filter(
    (key) => processTypeByKey.get(key) === "renderer",
  ).length;
  if (observedRendererCount > 0 && persistentRendererCount === 0) {
    harnessFailures.push(
      "no renderer process persisted across the full measurement window",
    );
  }

  const intervals = [];
  const lifecycleEvents = [];
  const totalCpuByType = {};
  let coveredDurationMs = 0;
  let totalCpuSeconds = 0;
  for (let index = 1; index < evidence.length; index += 1) {
    const previousSnapshot = evidence[index - 1];
    const currentSnapshot = evidence[index];
    const previousAt = finite(previousSnapshot?.completedAtEpochMs);
    const currentAt = finite(currentSnapshot?.completedAtEpochMs);
    const intervalMs =
      previousAt !== null && currentAt !== null && currentAt > previousAt
        ? currentAt - previousAt
        : null;
    if (
      intervalMs === null ||
      intervalMs < minimumIntervalMs ||
      intervalMs > maximumIntervalMs
    ) {
      harnessFailures.push(
        `process observation cadence ${round(intervalMs, 3) ?? "missing"}ms is outside ${minimumIntervalMs}-${maximumIntervalMs}ms`,
      );
    }
    if (intervalMs === null || intervalMs <= 0) continue;
    coveredDurationMs += intervalMs;

    const previous = indexed[index - 1]?.index ?? new Map();
    const current = indexed[index]?.index ?? new Map();
    const keys = new Set([...previous.keys(), ...current.keys()]);
    const cpuSecondsByType = {};
    const processDeltas = [];
    let intervalCpuSeconds = 0;
    for (const key of Array.from(keys).sort()) {
      const before = previous.get(key);
      const after = current.get(key);
      let cpuSeconds = 0;
      if (!before && after) {
        lifecycleEvents.push({
          type: "appeared",
          key,
          atEpochMs: currentAt,
          includedInCpuAuthority: false,
          observedCumulativeCpuSeconds: round(after.cpuTimeSeconds),
        });
        continue;
      } else if (before && !after) {
        lifecycleEvents.push({
          type: "disappeared",
          key,
          atEpochMs: currentAt,
          includedInCpuAuthority: false,
          lastObservedCumulativeCpuSeconds: round(before.cpuTimeSeconds),
        });
        continue;
      } else if (
        before &&
        after &&
        persistentProcessKeys.has(key)
      ) {
        cpuSeconds = after.cpuTimeSeconds - before.cpuTimeSeconds;
        if (cpuSeconds < 0) {
          harnessFailures.push(`CPU counter reset for ${key}`);
          continue;
        }
      } else {
        // A process that does not span the full window has no exact cumulative
        // baseline. Keep its lifecycle visible, but exclude it from the
        // full-window CPU authority instead of mixing an unknown partial
        // counter into the meeting-process total.
        continue;
      }
      const type = after?.type ?? before?.type ?? "unknown";
      intervalCpuSeconds += cpuSeconds;
      cpuSecondsByType[type] = (cpuSecondsByType[type] ?? 0) + cpuSeconds;
      processDeltas.push({ key, type, cpuSeconds: round(cpuSeconds) });
    }
    totalCpuSeconds += intervalCpuSeconds;
    for (const [type, cpuSeconds] of Object.entries(cpuSecondsByType)) {
      totalCpuByType[type] = (totalCpuByType[type] ?? 0) + cpuSeconds;
    }
    intervals.push({
      startedAtEpochMs: previousAt,
      endedAtEpochMs: currentAt,
      scheduledStartedAtEpochMs: previousSnapshot.scheduledAtEpochMs,
      scheduledEndedAtEpochMs: currentSnapshot.scheduledAtEpochMs,
      observationIntervalMs: round(intervalMs, 3),
      coveredDurationMs: round(intervalMs, 3),
      totalCpuSeconds: round(intervalCpuSeconds),
      coreEquivalents: round(intervalCpuSeconds / (intervalMs / 1_000)),
      cpuSecondsByType: Object.fromEntries(
        Object.entries(cpuSecondsByType).map(([type, value]) => [
          type,
          round(value),
        ]),
      ),
      processDeltas,
    });
  }

  const coverageRatio =
    window && window.durationMs > 0 ? coveredDurationMs / window.durationMs : null;
  if (coverageRatio === null || Math.abs(coverageRatio - 1) > 0.01) {
    harnessFailures.push(
      `process CPU window coverage ${round(coverageRatio, 6) ?? "missing"} is not exact`,
    );
  }
  const coreEquivalents =
    coveredDurationMs > 0
      ? totalCpuSeconds / (coveredDurationMs / 1_000)
      : null;
  const intervalCoreEquivalents = intervals.map(
    (interval) => interval.coreEquivalents,
  );
  const p95CoreEquivalents = nearestRank(intervalCoreEquivalents, 0.95);
  const maximumObservedCoreEquivalents =
    intervalCoreEquivalents.length > 0
      ? Math.max(...intervalCoreEquivalents)
      : null;
  const averageLimit = finite(maximumCoreEquivalents);
  const p95Limit =
    finite(maximumP95CoreEquivalents) ??
    (averageLimit === null ? null : averageLimit * 1.5);
  const intervalLimit =
    finite(maximumIntervalCoreEquivalents) ??
    (averageLimit === null ? null : averageLimit * 2);
  if (averageLimit === null || averageLimit <= 0) {
    harnessFailures.push("process CPU average gate is missing");
  } else if (coreEquivalents !== null && coreEquivalents > averageLimit) {
    productFailures.push(
      `${role} process CPU average ${round(coreEquivalents, 3)} cores exceeds ${averageLimit}`,
    );
  }
  if (p95Limit === null || p95Limit <= 0) {
    harnessFailures.push("process CPU p95 gate is missing");
  } else if (
    p95CoreEquivalents !== null &&
    p95CoreEquivalents > p95Limit
  ) {
    productFailures.push(
      `${role} process CPU p95 ${round(p95CoreEquivalents, 3)} cores exceeds ${round(p95Limit, 3)}`,
    );
  }
  if (intervalLimit === null || intervalLimit <= 0) {
    harnessFailures.push("process CPU interval-maximum gate is missing");
  } else if (
    maximumObservedCoreEquivalents !== null &&
    maximumObservedCoreEquivalents > intervalLimit
  ) {
    productFailures.push(
      `${role} process CPU maximum ${round(maximumObservedCoreEquivalents, 3)} cores exceeds ${round(intervalLimit, 3)}`,
    );
  }

  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  return {
    version: PROCESS_PERFORMANCE_VERSION,
    label,
    role,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    measurementWindow: window,
    measurementWindowId: window?.id ?? null,
    hardwareIdentityId,
    expectedBrowserPid: expectedPid,
    observationIntervalMs,
    observationCount: list.length,
    evidenceObservationCount: evidence.length,
    scheduledObservationCount,
    completedObservationCount,
    skippedTickCount,
    lateTickCount,
    overlapTickCount,
    slowCaptureCount,
    captureErrorCount,
    maximumConcurrentCaptures,
    processScope: "persistent-full-window",
    observedProcessCount: allProcessKeys.size,
    persistentProcessCount: persistentProcessKeys.size,
    persistentRendererCount,
    excludedTransientProcessCount:
      allProcessKeys.size - persistentProcessKeys.size,
    persistentProcessKeys: Array.from(persistentProcessKeys).sort(),
    coveredDurationMs: round(coveredDurationMs, 3),
    coverageRatio: round(coverageRatio, 6),
    totalCpuSeconds: round(totalCpuSeconds),
    coreEquivalents: round(coreEquivalents),
    p95CoreEquivalents: round(p95CoreEquivalents),
    maximumObservedCoreEquivalents: round(maximumObservedCoreEquivalents),
    maximumCoreEquivalents: averageLimit,
    maximumP95CoreEquivalents: round(p95Limit),
    maximumIntervalCoreEquivalents: round(intervalLimit),
    cpuSecondsByType: Object.fromEntries(
      Object.entries(totalCpuByType).map(([type, value]) => [type, round(value)]),
    ),
    lifecycleEvents,
    intervals,
    observations: list,
    snapshots: {
      start: evidence[0] ?? null,
      end: evidence.at(-1) ?? null,
    },
  };
}
