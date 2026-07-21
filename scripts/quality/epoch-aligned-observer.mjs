export const ALIGNED_OBSERVATION_INTERVAL_MS = 500;
export const ALIGNED_TERMINAL_LEAD_MS = 50;
export const MAXIMUM_ALIGNED_TICK_LATENESS_MS = 50;
export const MAXIMUM_ALIGNED_SAMPLE_DURATION_MS = 250;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeWindow = (value) => {
  const id = typeof value?.id === "string" ? value.id.trim() : "";
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
    durationMs % ALIGNED_OBSERVATION_INTERVAL_MS !== 0 ||
    endedAtEpochMs <= startedAtEpochMs ||
    Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) > 1
  ) {
    throw new TypeError("a valid version 1 measurement window is required");
  }
  return Object.freeze({
    version: 1,
    id,
    startedAtEpochMs,
    endedAtEpochMs,
    durationMs,
    ...(value?.immutable === true ? { immutable: true } : {}),
  });
};

/**
 * Build absolute codec-observation targets. The last regular 500 ms tick is
 * replaced by an in-window terminal capture so asynchronous stats collection
 * can complete without pretending a post-window completion happened at end.
 */
export function buildAlignedWindowObservationTargets({
  measurementWindow,
  observationIntervalMs = 500,
  terminalLeadMs = 50,
} = {}) {
  const id =
    typeof measurementWindow?.id === "string"
      ? measurementWindow.id.trim()
      : "";
  const startedAtEpochMs = measurementWindow?.startedAtEpochMs;
  const endedAtEpochMs = measurementWindow?.endedAtEpochMs;
  const durationMs = measurementWindow?.durationMs;
  if (observationIntervalMs !== 500) {
    throw new RangeError("aligned observation interval must be exactly 500ms");
  }
  if (
    measurementWindow?.version !== 1 ||
    !id ||
    !Number.isFinite(startedAtEpochMs) ||
    !Number.isFinite(endedAtEpochMs) ||
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs % observationIntervalMs !== 0 ||
    endedAtEpochMs <= startedAtEpochMs ||
    Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) > 1
  ) {
    throw new TypeError("a valid version 1 measurement window is required");
  }
  const window = {
    version: 1,
    id,
    startedAtEpochMs,
    endedAtEpochMs,
    durationMs,
  };
  if (
    !Number.isInteger(terminalLeadMs) ||
    terminalLeadMs < 0 ||
    terminalLeadMs >= 100
  ) {
    throw new RangeError("terminal lead must be an integer from 0 through 99ms");
  }
  const terminalAtEpochMs = window.endedAtEpochMs - terminalLeadMs;
  const targets = [];
  for (
    let scheduledAtEpochMs = window.startedAtEpochMs;
    scheduledAtEpochMs < terminalAtEpochMs;
    scheduledAtEpochMs += observationIntervalMs
  ) {
    targets.push({
      index: targets.length,
      phase: targets.length === 0 ? "start" : "interval",
      scheduledAtEpochMs,
    });
  }
  if (targets.length === 0) {
    throw new RangeError("measurement window is too short for aligned evidence");
  }
  const previousTarget = targets.at(-1).scheduledAtEpochMs;
  const terminalIntervalMs = terminalAtEpochMs - previousTarget;
  if (terminalIntervalMs < 400 || terminalIntervalMs > 600) {
    throw new RangeError(
      `terminal aligned observation interval ${terminalIntervalMs}ms is outside 400-600ms`,
    );
  }
  targets.push({
    index: targets.length,
    phase: "terminal",
    scheduledAtEpochMs: terminalAtEpochMs,
  });
  return Object.freeze(targets.map((target) => Object.freeze(target)));
}

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

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

/**
 * Arm an absolute-epoch observer without collecting pre-window evidence.
 * Timers are all scheduled from immutable epoch targets, so callback duration
 * cannot drift later targets. A tick is skipped rather than overlapped.
 */
export function startEpochAlignedObserver({
  measurementWindow,
  observe,
  observationIntervalMs = ALIGNED_OBSERVATION_INTERVAL_MS,
  terminalLeadMs = ALIGNED_TERMINAL_LEAD_MS,
  maximumTickLatenessMs = MAXIMUM_ALIGNED_TICK_LATENESS_MS,
  maximumSampleDurationMs = MAXIMUM_ALIGNED_SAMPLE_DURATION_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const window = normalizeWindow(measurementWindow);
  if (typeof observe !== "function") {
    throw new TypeError("aligned observer requires an observe callback");
  }
  if (
    !Number.isFinite(maximumTickLatenessMs) ||
    maximumTickLatenessMs < 0 ||
    !Number.isFinite(maximumSampleDurationMs) ||
    maximumSampleDurationMs <= 0
  ) {
    throw new RangeError("aligned observer timing limits are invalid");
  }
  const targets = buildAlignedWindowObservationTargets({
    measurementWindow: window,
    observationIntervalMs,
    terminalLeadMs,
  });
  const armedAtEpochMs = now();
  const observations = [];
  const tickRecords = [];
  const schedulerErrors = [];
  const invokedIndexes = new Set();
  const timers = new Set();
  let inFlight = null;
  let observerStartedAtEpochMs = null;
  let observerStoppedAtEpochMs = null;
  let skippedTickCount = 0;
  let lateTickCount = 0;
  let overlapTickCount = 0;
  let slowSampleCount = 0;
  let captureErrorCount = 0;
  let outOfWindowCaptureCount = 0;
  let maximumConcurrentSamples = 0;
  let concurrentSamples = 0;
  let result = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });

  const schedule = (targetEpochMs, callback) => {
    let timer = null;
    timer = setTimer(() => {
      timers.delete(timer);
      callback();
    }, Math.max(0, targetEpochMs - now()));
    timer?.unref?.();
    timers.add(timer);
  };

  const finish = () => {
    if (result) return;
    const frozenObservations = cloneAndDeepFreeze(observations);
    const frozenTickRecords = cloneAndDeepFreeze(tickRecords);
    const frozenSchedulerErrors = cloneAndDeepFreeze(schedulerErrors);
    result = Object.freeze({
      version: 1,
      measurementWindow: window,
      measurementWindowId: window.id,
      observationIntervalMs,
      terminalLeadMs,
      armedAtEpochMs,
      observerStartedAtEpochMs,
      observerStoppedAtEpochMs,
      firstTickSkewMs:
        observerStartedAtEpochMs === null
          ? null
          : observerStartedAtEpochMs - window.startedAtEpochMs,
      terminalBoundarySkewMs:
        observerStoppedAtEpochMs === null
          ? null
          : observerStoppedAtEpochMs - window.endedAtEpochMs,
      skippedTickCount,
      lateTickCount,
      overlapTickCount,
      slowSampleCount,
      captureErrorCount,
      outOfWindowCaptureCount,
      maximumConcurrentSamples,
      scheduledObservationCount: targets.length,
      completedObservationCount: observations.length,
      observations: frozenObservations,
      tickRecords: frozenTickRecords,
      schedulerErrors: frozenSchedulerErrors,
    });
    resolveCompletion(result);
  };

  const invoke = (target) => {
    const invokedAtEpochMs = now();
    invokedIndexes.add(target.index);
    if (target.index === 0) observerStartedAtEpochMs = invokedAtEpochMs;
    const tickLatenessMs = Math.max(
      0,
      invokedAtEpochMs - target.scheduledAtEpochMs,
    );
    const tickRecord = {
      ...target,
      invokedAtEpochMs,
      tickLatenessMs,
      status: "started",
    };
    tickRecords.push(tickRecord);
    if (tickLatenessMs > maximumTickLatenessMs) {
      lateTickCount += 1;
      skippedTickCount += 1;
      tickRecord.status = "late";
    }
    if (inFlight) {
      overlapTickCount += 1;
      skippedTickCount += 1;
      tickRecord.status = "skipped-overlap";
      return;
    }
    concurrentSamples += 1;
    maximumConcurrentSamples = Math.max(
      maximumConcurrentSamples,
      concurrentSamples,
    );
    const sampleStartedAtEpochMs = now();
    const promise = Promise.resolve().then(() =>
      observe({
        ...target,
        invokedAtEpochMs,
        tickLatenessMs,
      }),
    );
    const sampleTask = promise
      .then((observation) => {
        const sampleCompletedAtEpochMs = now();
        const sampleDurationMs = Math.max(
          0,
          sampleCompletedAtEpochMs - sampleStartedAtEpochMs,
        );
        tickRecord.sampleCompletedAtEpochMs = sampleCompletedAtEpochMs;
        tickRecord.sampleDurationMs = sampleDurationMs;
        if (sampleDurationMs > maximumSampleDurationMs) {
          slowSampleCount += 1;
          skippedTickCount += 1;
          tickRecord.status = "slow";
        } else if (tickRecord.status === "started") {
          tickRecord.status = "completed";
        }
        if (observation == null || typeof observation !== "object") {
          captureErrorCount += 1;
          skippedTickCount += 1;
          tickRecord.status = "empty";
          schedulerErrors.push(
            `aligned observation ${target.index} returned no evidence`,
          );
          return;
        }
        if (
          Number.isFinite(observation.capturedAtEpochMs) &&
          (observation.capturedAtEpochMs < window.startedAtEpochMs ||
            observation.capturedAtEpochMs > window.endedAtEpochMs)
        ) {
          outOfWindowCaptureCount += 1;
          skippedTickCount += 1;
          tickRecord.status = "outside-window";
        }
        observations.push({
          ...observation,
          scheduledAtEpochMs: target.scheduledAtEpochMs,
          observationPhase: target.phase,
          tickInvokedAtEpochMs: invokedAtEpochMs,
          tickLatenessMs,
          sampleDurationMs,
        });
      })
      .catch((error) => {
        captureErrorCount += 1;
        skippedTickCount += 1;
        tickRecord.status = "capture-error";
        schedulerErrors.push(
          `aligned observation ${target.index} failed: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        concurrentSamples = Math.max(0, concurrentSamples - 1);
        inFlight = null;
      });
    inFlight = sampleTask;
  };

  for (const target of targets) {
    schedule(target.scheduledAtEpochMs, () => invoke(target));
  }
  schedule(window.endedAtEpochMs, () => {
    observerStoppedAtEpochMs = now();
    const boundaryLatenessMs = Math.max(
      0,
      observerStoppedAtEpochMs - window.endedAtEpochMs,
    );
    if (boundaryLatenessMs > maximumTickLatenessMs) {
      lateTickCount += 1;
      skippedTickCount += 1;
      schedulerErrors.push(
        `aligned observer terminal boundary was ${boundaryLatenessMs}ms late`,
      );
    }
    for (const target of targets) {
      if (!invokedIndexes.has(target.index)) {
        skippedTickCount += 1;
        schedulerErrors.push(
          `aligned observation ${target.index} was not invoked before the terminal boundary`,
        );
      }
    }
    for (const timer of timers) clearTimer(timer);
    timers.clear();
    if (inFlight) {
      void inFlight.finally(finish);
    } else {
      finish();
    }
  });

  return Object.freeze({
    version: 1,
    measurementWindow: window,
    armedAtEpochMs,
    scheduledObservationCount: targets.length,
    async stop() {
      return completion;
    },
  });
}
