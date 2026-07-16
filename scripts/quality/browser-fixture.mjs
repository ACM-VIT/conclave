import { readFileSync } from "node:fs";
import {
  CAPTURE_TO_DISPLAY_LATENCY_VERSION,
  VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS,
} from "./media-latency.mjs";
import { buildAlignedWindowObservationTargets } from "./epoch-aligned-observer.mjs";
import { createVisualMetricToolkit } from "./visual-metrics.mjs";

const HARNESS_GLOBAL = "__conclaveQualityHarness";
export const VIDEO_QUALITY_FIXTURE_ASSET_PATHS = [
  "../../apps/web/public/effects/backgrounds/office-green-space.webp",
  "../../apps/web/public/effects/backgrounds/dog-office.webp",
  "../../apps/web/public/effects/backgrounds/rainy-cafe.webp",
];
const FIXTURE_ASSET_DATA_URLS = VIDEO_QUALITY_FIXTURE_ASSET_PATHS.map(
  (relativePath) =>
    `data:image/webp;base64,${readFileSync(
      new URL(relativePath, import.meta.url),
    ).toString("base64")}`,
);

const integerOption = (value, fallback, { name, min, max }) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
  }
  return resolved;
};

export function normalizeMeasurementWindow(value) {
  const version = value?.version;
  const id = typeof value?.id === "string" ? value.id.trim() : "";
  const startedAtEpochMs = value?.startedAtEpochMs;
  const endedAtEpochMs = value?.endedAtEpochMs;
  const durationMs = value?.durationMs;
  if (
    version !== 1 ||
    !id ||
    !Number.isFinite(startedAtEpochMs) ||
    !Number.isFinite(endedAtEpochMs) ||
    !Number.isFinite(durationMs) ||
    !Number.isInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs % 500 !== 0 ||
    endedAtEpochMs <= startedAtEpochMs ||
    Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) > 1
  ) {
    throw new TypeError(
      "measurementWindow must be {version:1,id,startedAtEpochMs,endedAtEpochMs,durationMs}",
    );
  }
  return Object.freeze({
    version: 1,
    id,
    startedAtEpochMs,
    endedAtEpochMs,
    durationMs,
  });
}

const SAMPLER_BEGIN_MINIMUM_EVALUATION_TIMEOUT_MS = 10_000;
const SAMPLER_BEGIN_POST_BARRIER_ALLOWANCE_MS = 10_000;

/**
 * Keep Runtime.evaluate alive while beginSamplerWindow waits for the shared
 * epoch. Dynamic-network runs intentionally arm 15 seconds before that epoch,
 * so a fixed 10 second CDP timeout would abort an otherwise healthy sampler.
 */
export function resolveSamplerBeginEvaluationTimeoutMs(
  measurementWindow,
  nowEpochMs = Date.now(),
) {
  const normalized = normalizeMeasurementWindow(measurementWindow);
  if (!Number.isFinite(nowEpochMs) || nowEpochMs < 0) {
    throw new TypeError("sampler begin current epoch must be non-negative");
  }
  const remainingBarrierLeadMs = Math.max(
    0,
    normalized.startedAtEpochMs - nowEpochMs,
  );
  return Math.max(
    SAMPLER_BEGIN_MINIMUM_EVALUATION_TIMEOUT_MS,
    Math.ceil(remainingBarrierLeadMs) +
      SAMPLER_BEGIN_POST_BARRIER_ALLOWANCE_MS,
  );
}

/**
 * Return how many compositor-presented frames elapsed between two
 * requestVideoFrameCallback observations. A reset, missing value, or duplicate
 * counter represents only the current callback.
 */
export function calculatePresentedFrameDelta(current, previous) {
  if (
    Number.isFinite(current) &&
    Number.isFinite(previous) &&
    current > previous
  ) {
    return Math.max(1, Math.round(current - previous));
  }
  return 1;
}

/** Require an exact, monotonic cumulative-counter baseline. */
export function calculateStrictCounterDelta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { valid: false, reset: false, delta: null };
  }
  if (current < previous) {
    return { valid: false, reset: true, delta: null };
  }
  return { valid: true, reset: false, delta: current - previous };
}

/**
 * Expand a rolling marker into the full source sequence used since the exact
 * measurement reset. Normal forward motion, including a modulus wrap, is
 * exact. A backwards or implausibly large jump is marked ambiguous and only
 * re-anchored near elapsed source time so later frames can recover safely.
 */
export function resolveRollingMarkerSequence({
  previousSourceSequence = null,
  markerSequence,
  elapsedSourceFrames,
  modulus,
} = {}) {
  if (
    !Number.isInteger(markerSequence) ||
    !Number.isInteger(modulus) ||
    modulus < 2 ||
    markerSequence < 0 ||
    markerSequence >= modulus ||
    (previousSourceSequence !== null &&
      (!Number.isInteger(previousSourceSequence) ||
        previousSourceSequence < 0))
  ) {
    return {
      valid: false,
      ambiguous: true,
      sourceSequence: null,
      markerGeneration: null,
    };
  }
  if (previousSourceSequence === null) {
    return {
      valid: true,
      ambiguous: false,
      sourceSequence: markerSequence,
      markerGeneration: 0,
    };
  }

  const previousGeneration = Math.floor(previousSourceSequence / modulus);
  let forwardSourceSequence =
    previousGeneration * modulus + markerSequence;
  if (forwardSourceSequence < previousSourceSequence) {
    forwardSourceSequence += modulus;
  }
  const forwardDelta = forwardSourceSequence - previousSourceSequence;
  if (forwardDelta === 0 || forwardDelta < modulus / 2) {
    return {
      valid: true,
      ambiguous: false,
      sourceSequence: forwardSourceSequence,
      markerGeneration: Math.floor(forwardSourceSequence / modulus),
    };
  }

  const elapsed = Number.isFinite(elapsedSourceFrames)
    ? Math.max(0, elapsedSourceFrames)
    : previousSourceSequence;
  const elapsedGeneration = Math.max(
    0,
    Math.round((elapsed - markerSequence) / modulus),
  );
  const reanchoredSourceSequence =
    elapsedGeneration * modulus + markerSequence;
  return {
    valid: true,
    ambiguous: true,
    sourceSequence: reanchoredSourceSequence,
    markerGeneration: elapsedGeneration,
  };
}

/**
 * Resolve the concrete capture settings a deterministic camera can satisfy.
 * Numeric constraints follow getUserMedia semantics: a bare number is ideal,
 * while exact/min/max values are mandatory.
 */
export function resolveSyntheticVideoCaptureSettings(
  constraints = true,
  {
    defaultWidth = 1280,
    defaultHeight = 720,
    defaultFrameRate = 30,
    minWidth = 160,
    maxWidth = defaultWidth,
    minHeight = 90,
    maxHeight = defaultHeight,
    minFrameRate = 1,
    maxFrameRate = defaultFrameRate,
  } = {},
) {
  const constraintSet =
    constraints && typeof constraints === "object" ? constraints : {};

  const overconstrained = (name) => {
    const error = new RangeError(
      `Synthetic video cannot satisfy the requested ${name} constraint`,
    );
    error.constraint = name;
    return error;
  };
  const finite = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const normalizeDimension = (value) => Math.max(1, Math.round(value));
  const normalizeFrameRate = (value) =>
    Math.max(0.001, Math.round(value * 1000) / 1000);

  const resolve = ({
    name,
    value,
    fallback,
    supportedMin,
    supportedMax,
    normalize,
  }) => {
    const normalizedSupportedMin = normalize(supportedMin);
    const normalizedSupportedMax = normalize(supportedMax);
    if (normalizedSupportedMin > normalizedSupportedMax) {
      throw new RangeError(`Invalid synthetic ${name} capability range`);
    }

    let exact = null;
    let ideal = null;
    let requiredMin = normalizedSupportedMin;
    let requiredMax = normalizedSupportedMax;

    if (typeof value === "number") {
      ideal = finite(value);
      if (ideal === null) throw new TypeError(`${name} must be finite`);
    } else if (value && typeof value === "object") {
      if (value.exact !== undefined) exact = finite(value.exact);
      if (value.ideal !== undefined) ideal = finite(value.ideal);
      if (value.min !== undefined) {
        const requestedMin = finite(value.min);
        if (requestedMin === null) throw new TypeError(`${name}.min must be finite`);
        requiredMin = Math.max(requiredMin, normalize(requestedMin));
      }
      if (value.max !== undefined) {
        const requestedMax = finite(value.max);
        if (requestedMax === null) throw new TypeError(`${name}.max must be finite`);
        requiredMax = Math.min(requiredMax, normalize(requestedMax));
      }
    } else if (value !== undefined) {
      throw new TypeError(`${name} must be a number or constraint object`);
    }

    if (
      (value && typeof value === "object" && value.exact !== undefined && exact === null) ||
      (value && typeof value === "object" && value.ideal !== undefined && ideal === null) ||
      requiredMin > requiredMax
    ) {
      throw overconstrained(name);
    }

    if (exact !== null) {
      const normalizedExact = normalize(exact);
      if (normalizedExact < requiredMin || normalizedExact > requiredMax) {
        throw overconstrained(name);
      }
      return normalizedExact;
    }

    const preferred = ideal === null ? normalize(fallback) : normalize(ideal);
    return Math.min(requiredMax, Math.max(requiredMin, preferred));
  };

  return {
    width: resolve({
      name: "width",
      value: constraintSet.width,
      fallback: defaultWidth,
      supportedMin: minWidth,
      supportedMax: maxWidth,
      normalize: normalizeDimension,
    }),
    height: resolve({
      name: "height",
      value: constraintSet.height,
      fallback: defaultHeight,
      supportedMin: minHeight,
      supportedMax: maxHeight,
      normalize: normalizeDimension,
    }),
    frameRate: resolve({
      name: "frameRate",
      value: constraintSet.frameRate,
      fallback: defaultFrameRate,
      supportedMin: minFrameRate,
      supportedMax: maxFrameRate,
      normalize: normalizeFrameRate,
    }),
  };
}

/** Return the first capture property that requires opening a new source. */
export function getSyntheticCaptureReopenConstraint(current, next) {
  return ["width", "height", "frameRate"].find(
    (name) => current?.[name] !== next?.[name],
  ) ?? null;
}

/**
 * Reference-counted lifecycle for synthetic sources. A settings change opens a
 * replacement before retiring the previous source, so the old capture can
 * remain live until its last cloned track is released.
 */
export function createSyntheticSourceLifecycle({
  createSource,
  stopSource,
  isSourceLive = () => true,
  sourceKey = (settings) => JSON.stringify(settings),
  keepCurrentWhenIdle = false,
} = {}) {
  if (typeof createSource !== "function") {
    throw new TypeError("createSource must be a function");
  }
  if (typeof stopSource !== "function") {
    throw new TypeError("stopSource must be a function");
  }

  let current = null;
  let nextGeneration = 1;
  const records = new Set();

  const describe = (record, includeSource = false) =>
    record
      ? {
          ...(includeSource ? { source: record.source } : {}),
          generation: record.generation,
          key: record.key,
          settings: { ...record.settings },
          leaseCount: record.leaseCount,
          retired: record.retired,
          stopped: record.stopped,
        }
      : null;

  const stopRecord = (record) => {
    if (!record || record.stopped || record.leaseCount > 0) return;
    record.stopped = true;
    records.delete(record);
    try {
      stopSource(record.source, {
        generation: record.generation,
        settings: { ...record.settings },
      });
    } catch {}
  };

  const retire = (record) => {
    if (!record || record.retired) return;
    record.retired = true;
    if (current === record) current = null;
    stopRecord(record);
  };

  const createLease = (record) => {
    if (!record || record.stopped) {
      throw new Error("Synthetic source is no longer available");
    }
    record.leaseCount += 1;
    let released = false;
    return {
      source: record.source,
      generation: record.generation,
      settings: { ...record.settings },
      get released() {
        return released;
      },
      retain() {
        if (released) throw new Error("Synthetic source lease is released");
        return createLease(record);
      },
      release() {
        if (released) return;
        released = true;
        record.leaseCount = Math.max(0, record.leaseCount - 1);
        if (record.leaseCount === 0 && !keepCurrentWhenIdle) retire(record);
        if (record.retired) stopRecord(record);
      },
    };
  };

  return {
    acquire(settings) {
      const resolvedSettings = { ...settings };
      const key = sourceKey(resolvedSettings);
      if (
        !current ||
        current.key !== key ||
        current.stopped ||
        !isSourceLive(current.source)
      ) {
        const source = createSource(resolvedSettings, {
          generation: nextGeneration,
        });
        const previous = current;
        current = {
          source,
          generation: nextGeneration,
          key,
          settings: resolvedSettings,
          leaseCount: 0,
          retired: false,
          stopped: false,
        };
        nextGeneration += 1;
        records.add(current);
        retire(previous);
      }
      return createLease(current);
    },
    getCurrent() {
      return describe(current, true);
    },
    getLatestActive() {
      const record = Array.from(records)
        .filter((candidate) => !candidate.stopped && candidate.leaseCount > 0)
        .sort((left, right) => right.generation - left.generation)[0];
      return describe(record, true);
    },
    snapshot() {
      return {
        current: describe(current),
        openSourceCount: records.size,
        sources: Array.from(records, (record) => describe(record)),
      };
    },
    close() {
      const activeRecords = Array.from(records);
      current = null;
      for (const record of activeRecords) retire(record);
    },
  };
}

/**
 * Build a script intended for CDP Page.addScriptToEvaluateOnNewDocument.
 *
 * The script always installs the sampler and RTCPeerConnection registry. When
 * enableSyntheticCamera is true it also replaces getUserMedia camera capture
 * with a deterministic canvas track. enableSyntheticAudio independently
 * replaces requested microphone capture with a zero-valued MediaStream track
 * that is never connected to speakers.
 */
export function buildFixtureInjectionScript({
  enableSyntheticCamera = false,
  enableSyntheticAudio = true,
  targetFps = 30,
  width = 1280,
  height = 720,
} = {}) {
  if (typeof enableSyntheticCamera !== "boolean") {
    throw new TypeError("enableSyntheticCamera must be a boolean");
  }
  if (typeof enableSyntheticAudio !== "boolean") {
    throw new TypeError("enableSyntheticAudio must be a boolean");
  }

  const config = {
    enableSyntheticCamera,
    enableSyntheticAudio,
    targetFps: integerOption(targetFps, 30, {
      name: "targetFps",
      min: 1,
      max: 60,
    }),
    width: integerOption(width, 1280, {
      name: "width",
      min: 160,
      max: 3840,
    }),
    height: integerOption(height, 720, {
      name: "height",
      min: 90,
      max: 2160,
    }),
    fixtureAssetDataUrls: FIXTURE_ASSET_DATA_URLS,
  };

  return `;(${installBrowserQualityHarness.toString()})(${JSON.stringify(config)}, (${calculatePresentedFrameDelta.toString()}), (${calculateStrictCounterDelta.toString()}), (${resolveRollingMarkerSequence.toString()}), (${resolveSyntheticVideoCaptureSettings.toString()}), (${getSyntheticCaptureReopenConstraint.toString()}), (${createSyntheticSourceLifecycle.toString()}), (${createVisualMetricToolkit.toString()}), (${buildAlignedWindowObservationTargets.toString()}), ${VIDEO_QUALITY_MARKER_SEQUENCE_MODULUS}, ${CAPTURE_TO_DISPLAY_LATENCY_VERSION});`;
}

/** Prepare a remote-video sampler without opening its measurement window. */
export function buildArmSamplerExpression({
  mode = "visual",
  sampleIntervalMs = 450,
  sourceFixture = null,
  targetTrackId = null,
  mediaPathBinding = null,
} = {}) {
  if (!["visual", "telemetry"].includes(mode)) {
    throw new TypeError("sampler mode must be visual or telemetry");
  }
  const interval = integerOption(sampleIntervalMs, 450, {
    name: "sampleIntervalMs",
    min: 100,
    max: 5_000,
  });
  const normalizedSourceFixture = sourceFixture
    ? {
        width: integerOption(sourceFixture.width, null, {
          name: "sourceFixture.width",
          min: 160,
          max: 3840,
        }),
        height: integerOption(sourceFixture.height, null, {
          name: "sourceFixture.height",
          min: 90,
          max: 2160,
        }),
        fps: integerOption(sourceFixture.fps, null, {
          name: "sourceFixture.fps",
          min: 1,
          max: 60,
        }),
        sourceGeneration: Number.isInteger(sourceFixture.sourceGeneration)
          ? sourceFixture.sourceGeneration
          : null,
        markerSequenceModulus: Number.isInteger(
          sourceFixture.markerSequenceModulus,
        )
          ? sourceFixture.markerSequenceModulus
          : null,
        active: sourceFixture.active === true,
      }
    : null;
  const normalizedTargetTrackId =
    typeof targetTrackId === "string" && targetTrackId.trim().length > 0
      ? targetTrackId.trim()
      : null;
  const normalizedMediaPathBinding = mediaPathBinding
    ? {
        producerId: String(mediaPathBinding.producerId ?? ""),
        consumerId: String(mediaPathBinding.consumerId ?? ""),
        connectionId: String(mediaPathBinding.connectionId ?? ""),
        statId: String(mediaPathBinding.statId ?? ""),
        ssrc:
          typeof mediaPathBinding.ssrc === "number" ||
          typeof mediaPathBinding.ssrc === "string"
            ? String(mediaPathBinding.ssrc)
            : "",
        codecMimeType: String(mediaPathBinding.codecMimeType ?? "").toLowerCase(),
        codecId:
          typeof mediaPathBinding.codecId === "string"
            ? mediaPathBinding.codecId
            : null,
        codecPayloadType: Number.isInteger(mediaPathBinding.codecPayloadType)
          ? mediaPathBinding.codecPayloadType
          : null,
        codecFmtpLine:
          typeof mediaPathBinding.codecFmtpLine === "string"
            ? mediaPathBinding.codecFmtpLine
            : null,
        scalabilityMode:
          typeof mediaPathBinding.scalabilityMode === "string"
            ? mediaPathBinding.scalabilityMode
            : null,
        decoderImplementation:
          typeof mediaPathBinding.decoderImplementation === "string"
            ? mediaPathBinding.decoderImplementation
            : null,
        powerEfficientDecoder:
          typeof mediaPathBinding.powerEfficientDecoder === "boolean"
            ? mediaPathBinding.powerEfficientDecoder
            : null,
        frameWidth: Number.isInteger(mediaPathBinding.frameWidth)
          ? mediaPathBinding.frameWidth
          : null,
        frameHeight: Number.isInteger(mediaPathBinding.frameHeight)
          ? mediaPathBinding.frameHeight
          : null,
        spatialLayer: Number.isInteger(mediaPathBinding.spatialLayer)
          ? mediaPathBinding.spatialLayer
          : null,
        temporalLayer: Number.isInteger(mediaPathBinding.temporalLayer)
          ? mediaPathBinding.temporalLayer
          : null,
      }
    : null;
  if (
    normalizedMediaPathBinding &&
    [
      "producerId",
      "consumerId",
      "connectionId",
      "statId",
      "ssrc",
      "codecMimeType",
    ].some((field) => !normalizedMediaPathBinding[field])
  ) {
    throw new TypeError("mediaPathBinding is incomplete");
  }

  return `(() => {
    const harness = globalThis.${HARNESS_GLOBAL};
    if (!harness) return { ok: false, reason: "quality-harness-not-installed" };
    return harness.armSampler({ mode: ${JSON.stringify(mode)}, sampleIntervalMs: ${interval}, sourceFixture: ${JSON.stringify(normalizedSourceFixture)}, targetTrackId: ${JSON.stringify(normalizedTargetTrackId)}, mediaPathBinding: ${JSON.stringify(normalizedMediaPathBinding)} });
  })()`;
}

// Kept as a source-compatible alias for external diagnostics. It now arms the
// sampler; callers must explicitly open one shared window with the builder below.
export const buildStartSamplerExpression = buildArmSamplerExpression;

/** Open an already-armed sampler on the shared authoritative epoch. */
export function buildBeginSamplerExpression(measurementWindow) {
  const normalized = normalizeMeasurementWindow(measurementWindow);
  return `(() => {
    const harness = globalThis.${HARNESS_GLOBAL};
    if (!harness) return { ok: false, reason: "quality-harness-not-installed" };
    return harness.beginSamplerWindow(${JSON.stringify(normalized)});
  })()`;
}

/** Build an awaitable expression that stops the sampler and returns its report. */
export function buildStopSamplerExpression(measurementWindow) {
  const normalized = normalizeMeasurementWindow(measurementWindow);
  return `(() => {
    const harness = globalThis.${HARNESS_GLOBAL};
    if (!harness) return { ok: false, reason: "quality-harness-not-installed" };
    return harness.stopSampler(${JSON.stringify(normalized)});
  })()`;
}

function installBrowserQualityHarness(
  initialConfig,
  calculatePresentedFrameDelta,
  calculateStrictCounterDelta,
  resolveRollingMarkerSequence,
  resolveSyntheticVideoCaptureSettings,
  getSyntheticCaptureReopenConstraint,
  createSyntheticSourceLifecycle,
  createVisualMetricToolkit,
  buildAlignedWindowObservationTargets,
  markerSequenceModulus,
  captureToDisplayLatencyVersion,
) {
  "use strict";

  const GLOBAL_NAME = "__conclaveQualityHarness";
  const VERSION = "1.7.1";
  const MARKER_FRAME_MODULUS = 360;
  const MARKER_SEQUENCE_MODULUS = markerSequenceModulus;
  const CAPTURE_TO_DISPLAY_VERSION = captureToDisplayLatencyVersion;
  const MARKER_PAYLOAD_BITS = 16;
  const MARKER_CELL_COUNT = MARKER_PAYLOAD_BITS * 2;
  const MARKER_REPETITIONS = 3;
  const MAX_PC_EVENTS = 200;
  const MAX_WORST_FRAMES = 3;
  const MAX_AUDIT_FRAME_CANDIDATES = 64;
  const MAX_TAIL_AUDIT_FRAMES = 128;
  const MAX_PENDING_METRIC_JOBS = 2;
  const MAX_WINDOW_BOUNDARY_SKEW_MS = 150;
  const MAX_ANALYSIS_WIDTH = 640;
  const PATH_OBSERVATION_INTERVAL_MS = 500;
  const PATH_TERMINAL_LEAD_MS = 50;
  // A completed 500ms path sample remains authoritative when Chrome's main
  // thread briefly slips, provided it stays inside the same 150ms boundary
  // authority used by the immutable measurement window. Counter windows keep
  // an additional 500ms guard around every network mutation, so this cannot
  // move a counter sample across a transition boundary.
  const MAX_PATH_TICK_LATENESS_MS = MAX_WINDOW_BOUNDARY_SKEW_MS;
  const MARKER_ANALYSIS_WIDTH = 256;
  const MARKER_ROW_HEIGHT = 8;
  const MIN_FIXTURE_WIDTH = 160;
  const MIN_FIXTURE_HEIGHT = 90;
  const MIN_FIXTURE_FRAME_RATE = 1;

  const existing = globalThis[GLOBAL_NAME];
  if (existing?.version === VERSION) {
    existing.configure(initialConfig);
    return;
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const finiteNumber = (value, fallback = 0) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const round = (value, digits = 4) => {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  };
  const nowEpochMs = () => Date.now();
  const nowPerformanceMs = () => performance.now();
  const performanceEpochMs = (performanceMs = nowPerformanceMs()) =>
    performance.timeOrigin + performanceMs;
  const normalizeWindow = (value) => {
    const id = typeof value?.id === "string" ? value.id.trim() : "";
    const startedAtEpochMs = finiteNumber(value?.startedAtEpochMs, null);
    const endedAtEpochMs = finiteNumber(value?.endedAtEpochMs, null);
    const durationMs = finiteNumber(value?.durationMs, null);
    if (
      value?.version !== 1 ||
      !id ||
      startedAtEpochMs === null ||
      endedAtEpochMs === null ||
      durationMs === null ||
      !Number.isInteger(durationMs) ||
      durationMs <= 0 ||
      durationMs % 500 !== 0 ||
      endedAtEpochMs <= startedAtEpochMs ||
      Math.abs(endedAtEpochMs - startedAtEpochMs - durationMs) > 1
    ) {
      return null;
    }
    return {
      version: 1,
      id,
      startedAtEpochMs,
      endedAtEpochMs,
      durationMs,
    };
  };
  const waitUntilEpoch = async (epochMs) => {
    const remainingMs = epochMs - nowEpochMs();
    if (remainingMs > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, remainingMs));
    }
  };
  const clockSnapshot = () => {
    const performanceNowMs = nowPerformanceMs();
    return {
      performanceTimeOriginEpochMs: performance.timeOrigin,
      performanceNowMs,
      performanceEpochMs: performanceEpochMs(performanceNowMs),
      wallClockEpochMs: nowEpochMs(),
    };
  };

  const normalizeConfig = (value) => ({
    enableSyntheticCamera: value?.enableSyntheticCamera === true,
    enableSyntheticAudio: value?.enableSyntheticAudio === true,
    targetFps: clamp(Math.round(finiteNumber(value?.targetFps, 30)), 1, 60),
    width: clamp(Math.round(finiteNumber(value?.width, 1280)), 160, 3840),
    height: clamp(Math.round(finiteNumber(value?.height, 720)), 90, 2160),
    fixtureAssetDataUrls: Array.isArray(value?.fixtureAssetDataUrls)
      ? value.fixtureAssetDataUrls
          .filter(
            (entry) =>
              typeof entry === "string" && entry.startsWith("data:image/webp;base64,"),
          )
          .slice(0, 3)
      : [],
  });

  const runtime = {
    config: normalizeConfig(initialConfig),
    fixtureLifecycle: null,
    lastFixtureSettings: null,
    lastFixtureFrameId: null,
    nextFixtureSourceSequence: 0,
    fixtureSourcesByGeneration: new Map(),
    fixtureTimelineResetAtEpochMs: null,
    silence: null,
    referenceCanvas: null,
    referenceFrameId: null,
    fixtureImages: [],
    fixtureImagesPromise: null,
    fixtureImagesError: null,
    peerConnections: [],
    nextPeerConnectionId: 1,
    rtpSenderIds: new WeakMap(),
    nextRtpSenderId: 1,
    sampler: null,
    lastSamplerResult: null,
    lastFixtureSourceSequence: null,
    nativeGetUserMedia: null,
    nativeEnumerateDevices: null,
    nativeRTCPeerConnection: null,
    nativeMediaCaptureCalls: [],
  };
  const visualMetrics = createVisualMetricToolkit({
    maskFactory: markerPixelMask,
  });

  async function loadFixtureImages(dataUrls) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("createImageBitmap is required for camera fixture assets");
    }
    const images = await Promise.all(
      dataUrls.map(async (dataUrl) => {
        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error("camera fixture asset could not be read");
        return createImageBitmap(await response.blob());
      }),
    );
    runtime.fixtureImages = images;
    return images;
  }

  runtime.fixtureImagesPromise = loadFixtureImages(
    runtime.config.fixtureAssetDataUrls,
  ).catch((error) => {
    runtime.fixtureImagesError =
      error instanceof Error ? error.message : String(error);
    return [];
  });

  function markerRects(width, height) {
    const barHeight = Math.max(3, Math.round(height * 0.008));
    const marginX = Math.max(2, Math.round(width * 0.012));
    const marginY = Math.max(2, Math.round(height * 0.008));
    const markerWidth = Math.min(
      width - marginX * 2,
      Math.max(32, Math.round(width * 0.15)),
    );
    return [
      {
        x: marginX,
        y: marginY,
        width: markerWidth,
        height: barHeight,
      },
      {
        x: width - marginX - markerWidth,
        y: marginY,
        width: markerWidth,
        height: barHeight,
      },
      {
        x: width - marginX - markerWidth,
        y: height - marginY - barHeight,
        width: markerWidth,
        height: barHeight,
      },
    ];
  }

  function markerBits(sourceSequence) {
    const payload =
      ((Math.trunc(sourceSequence) % MARKER_SEQUENCE_MODULUS) +
        MARKER_SEQUENCE_MODULUS) %
      MARKER_SEQUENCE_MODULUS;
    const code = new Array(17).fill(0);
    const dataPositions = [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
    for (let index = 0; index < dataPositions.length; index += 1) {
      code[dataPositions[index]] = (payload >>> index) & 1;
    }
    for (const parityPosition of [1, 2, 4, 8]) {
      let parity = 0;
      for (let position = 1; position <= 15; position += 1) {
        if (position & parityPosition) parity ^= code[position];
      }
      code[parityPosition] = parity;
    }
    let overallParity = 0;
    for (let position = 1; position <= 15; position += 1) {
      overallParity ^= code[position];
    }
    code[16] = overallParity;
    return code.slice(1);
  }

  function decodeMarkerBits(bits) {
    if (!Array.isArray(bits) || bits.length !== MARKER_PAYLOAD_BITS) {
      return null;
    }
    const code = [0, ...bits.map((bit) => (bit ? 1 : 0))];
    let syndrome = 0;
    for (const parityPosition of [1, 2, 4, 8]) {
      let parity = 0;
      for (let position = 1; position <= 15; position += 1) {
        if (position & parityPosition) parity ^= code[position];
      }
      if (parity) syndrome |= parityPosition;
    }
    let overallParity = 0;
    for (let position = 1; position <= 16; position += 1) {
      overallParity ^= code[position];
    }
    if (syndrome !== 0 && overallParity === 1) {
      code[syndrome] ^= 1;
    } else if (syndrome !== 0 && overallParity === 0) {
      return null;
    } else if (syndrome === 0 && overallParity === 1) {
      code[16] ^= 1;
    }
    const dataPositions = [3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
    let payload = 0;
    for (let index = 0; index < dataPositions.length; index += 1) {
      payload |= code[dataPositions[index]] << index;
    }
    const markerSequence = payload;
    const frameId = markerSequence % MARKER_FRAME_MODULUS;
    return {
      markerSequence,
      frameId,
      sceneId: fixtureSceneId(frameId),
    };
  }

  function drawMarker(context, width, height, sourceSequence) {
    const bits = markerBits(sourceSequence);
    const dark = "rgb(8, 8, 8)";
    const bright = "rgb(247, 247, 247)";
    for (const rect of markerRects(width, height)) {
      const cellWidth = rect.width / MARKER_CELL_COUNT;
      context.fillStyle = dark;
      context.fillRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2);
      for (let index = 0; index < bits.length; index += 1) {
        const firstBright = bits[index] === 1;
        const cellX = rect.x + index * cellWidth * 2;
        context.fillStyle = firstBright ? bright : dark;
        context.fillRect(cellX, rect.y, cellWidth + 0.25, rect.height);
        context.fillStyle = firstBright ? dark : bright;
        context.fillRect(
          cellX + cellWidth,
          rect.y,
          cellWidth + 0.25,
          rect.height,
        );
      }
    }
  }

  function fixtureSceneId(frameId) {
    return Math.floor((((frameId % 360) + 360) % 360) / 120);
  }

  function seededUnit(seed) {
    let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35);
    value ^= value >>> 16;
    return (value >>> 0) / 0xffffffff;
  }

  function renderMeetingCameraScene(
    context,
    width,
    height,
    frameId,
    fixtureImages = null,
  ) {
    const sceneId = fixtureSceneId(frameId);
    const sceneFrame = ((frameId % 120) + 120) % 120;
    const phase = (sceneFrame / 120) * Math.PI * 2;
    const left = 0;
    const top = 0;
    const sceneWidth = width;
    const sceneHeight = height;

    context.save();
    context.beginPath();
    context.rect(left, top, sceneWidth, sceneHeight);
    context.clip();

    const room = context.createLinearGradient(left, top, left + sceneWidth, top + sceneHeight);
    const palettes = [
      ["#d9c7aa", "#758e86", "#344f59"],
      ["#b8c7d8", "#6f7d98", "#30384b"],
      ["#252737", "#3f3549", "#171a25"],
    ];
    const palette = palettes[sceneId];
    const photographicBackground = fixtureImages?.[sceneId] ?? null;
    if (photographicBackground) {
      const imageWidth = photographicBackground.width;
      const imageHeight = photographicBackground.height;
      const scale = Math.max(sceneWidth / imageWidth, sceneHeight / imageHeight);
      const cropWidth = sceneWidth / scale;
      const cropHeight = sceneHeight / scale;
      const pan = Math.sin(phase * 0.16) * imageWidth * 0.008;
      const sourceX = clamp(
        (imageWidth - cropWidth) * 0.5 + pan,
        0,
        Math.max(0, imageWidth - cropWidth),
      );
      const sourceY = Math.max(0, (imageHeight - cropHeight) * 0.5);
      context.drawImage(
        photographicBackground,
        sourceX,
        sourceY,
        cropWidth,
        cropHeight,
        left,
        top,
        sceneWidth,
        sceneHeight,
      );
      context.fillStyle =
        sceneId === 2
          ? "rgba(22,18,36,0.38)"
          : sceneId === 1
            ? "rgba(38,48,66,0.12)"
            : "rgba(228,213,182,0.08)";
      context.fillRect(left, top, sceneWidth, sceneHeight);
    } else {
      room.addColorStop(0, palette[0]);
      room.addColorStop(0.58, palette[1]);
      room.addColorStop(1, palette[2]);
      context.fillStyle = room;
      context.fillRect(left, top, sceneWidth, sceneHeight);
    }

    // Window, shelves, plant leaves, and soft background edges exercise the
    // kind of low-frequency structure and chroma transitions found in calls.
    if (!photographicBackground) {
      context.fillStyle = sceneId === 2 ? "#3b3c55" : "rgba(227,242,245,0.72)";
      context.fillRect(width * 0.62, height * 0.13, width * 0.28, height * 0.31);
      context.strokeStyle = "rgba(24,35,47,0.45)";
      context.lineWidth = Math.max(1, width / 640);
      context.strokeRect(width * 0.62, height * 0.13, width * 0.28, height * 0.31);
      context.beginPath();
      context.moveTo(width * 0.76, height * 0.13);
      context.lineTo(width * 0.76, height * 0.44);
      context.moveTo(width * 0.62, height * 0.285);
      context.lineTo(width * 0.9, height * 0.285);
      context.stroke();
      context.fillStyle = "rgba(31,35,45,0.62)";
      context.fillRect(width * 0.69, height * 0.5, width * 0.24, height * 0.025);
      for (let index = 0; index < 7; index += 1) {
        const leafPhase = phase * 0.18 + index * 0.91;
        context.fillStyle = index % 2 === 0 ? "#2e735d" : "#4e946a";
        context.beginPath();
        context.ellipse(
          width * (0.83 + Math.sin(leafPhase) * 0.055),
          height * (0.57 + index * 0.037),
          width * 0.032,
          height * 0.012,
          Math.sin(leafPhase) * 0.7,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }

    const headX = width * (0.33 + Math.sin(phase * 0.45) * 0.008);
    const headY = height * (0.43 + Math.cos(phase * 0.38) * 0.006);
    const skin = sceneId === 2 ? "#a86d58" : "#c98a6b";
    context.fillStyle = sceneId === 1 ? "#315d73" : "#5a3f75";
    context.beginPath();
    context.ellipse(headX, height * 0.82, width * 0.22, height * 0.25, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = skin;
    context.fillRect(headX - width * 0.034, height * 0.57, width * 0.068, height * 0.12);
    context.beginPath();
    context.ellipse(headX, headY, width * 0.105, height * 0.205, 0, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.ellipse(headX - width * 0.105, headY, width * 0.018, height * 0.04, 0, 0, Math.PI * 2);
    context.ellipse(headX + width * 0.105, headY, width * 0.018, height * 0.04, 0, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#27212a";
    context.beginPath();
    context.ellipse(headX, headY - height * 0.11, width * 0.108, height * 0.11, 0, Math.PI, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(20,15,22,0.82)";
    context.lineWidth = Math.max(0.8, width / 1500);
    for (let index = 0; index < 42; index += 1) {
      const strand = (index - 21) / 21;
      context.beginPath();
      context.moveTo(headX + strand * width * 0.1, headY - height * 0.16);
      context.quadraticCurveTo(
        headX + strand * width * 0.115 + Math.sin(phase + index) * width * 0.002,
        headY - height * 0.045,
        headX + strand * width * 0.095,
        headY + height * 0.005,
      );
      context.stroke();
    }

    const blink = Math.abs(Math.sin(phase * 2.1)) > 0.96 ? 0.002 : 0.009;
    context.fillStyle = "#2a2224";
    for (const direction of [-1, 1]) {
      context.beginPath();
      context.ellipse(
        headX + direction * width * 0.038,
        headY - height * 0.018,
        width * 0.012,
        height * blink,
        0,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.strokeStyle = "#7d3f45";
    context.lineWidth = Math.max(1.5, width / 700);
    context.beginPath();
    context.arc(headX, headY + height * 0.07, width * 0.035, 0.16, Math.PI - 0.16);
    context.stroke();

    // A gesturing hand crosses textured background and face edges.
    const handX = width * (0.52 + Math.sin(phase * 1.35) * 0.065);
    const handY = height * (0.61 + Math.cos(phase * 1.1) * 0.055);
    context.fillStyle = skin;
    context.beginPath();
    context.ellipse(handX, handY, width * 0.043, height * 0.065, -0.3, 0, Math.PI * 2);
    context.fill();
    context.lineCap = "round";
    context.strokeStyle = skin;
    context.lineWidth = Math.max(5, width * 0.012);
    for (let index = 0; index < 4; index += 1) {
      context.beginPath();
      context.moveTo(handX + (index - 1.5) * width * 0.012, handY - height * 0.025);
      context.lineTo(
        handX + (index - 1.5) * width * 0.017,
        handY - height * (0.09 + index * 0.006),
      );
      context.stroke();
    }

    // Temporally correlated low-light sensor texture: the pattern updates in
    // four-frame groups instead of becoming an unrealistic white-noise codec tax.
    if (sceneId === 2) {
      const noiseFrame = Math.floor(sceneFrame / 4);
      const cellsX = 18;
      const cellsY = 10;
      for (let y = 0; y < cellsY; y += 1) {
        for (let x = 0; x < cellsX; x += 1) {
          const value = seededUnit(noiseFrame * 4099 + y * cellsX + x);
          const alpha = 0.025 + value * 0.055;
          context.fillStyle =
            value > 0.66
              ? `rgba(72,93,121,${alpha})`
              : `rgba(146,78,105,${alpha})`;
          context.fillRect(
            left + (x * sceneWidth) / cellsX,
            top + (y * sceneHeight) / cellsY,
            sceneWidth / cellsX + 1,
            sceneHeight / cellsY + 1,
          );
        }
      }
    }
    context.restore();
    return sceneId;
  }

  function renderFixtureFrame(
    canvas,
    rawSourceSequence,
    fixtureImages = runtime.fixtureImages,
  ) {
    const sourceSequence = Math.trunc(rawSourceSequence);
    const frameId =
      ((sourceSequence % MARKER_FRAME_MODULUS) + MARKER_FRAME_MODULUS) %
      MARKER_FRAME_MODULUS;
    const width = canvas.width;
    const height = canvas.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!context) throw new Error("2D canvas context is unavailable");

    context.save();
    context.globalCompositeOperation = "copy";
    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#15213b");
    background.addColorStop(0.35, "#416f87");
    background.addColorStop(0.7, "#d89261");
    background.addColorStop(1, "#f2dfb9");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";

    renderMeetingCameraScene(
      context,
      width,
      height,
      frameId,
      fixtureImages,
    );

    drawMarker(context, width, height, sourceSequence);
    context.restore();
  }

  function renderScaledFixtureFrame(canvas, sourceSequence) {
    if (
      !runtime.referenceCanvas ||
      runtime.referenceCanvas.width !== runtime.config.width ||
      runtime.referenceCanvas.height !== runtime.config.height
    ) {
      runtime.referenceCanvas = document.createElement("canvas");
      runtime.referenceCanvas.width = runtime.config.width;
      runtime.referenceCanvas.height = runtime.config.height;
      runtime.referenceFrameId = null;
    }
    if (runtime.referenceFrameId !== sourceSequence) {
      renderFixtureFrame(runtime.referenceCanvas, sourceSequence);
      runtime.referenceFrameId = sourceSequence;
    }

    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!context) throw new Error("2D canvas context is unavailable");
    context.save();
    context.globalCompositeOperation = "copy";
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(runtime.referenceCanvas, 0, 0, canvas.width, canvas.height);
    context.restore();
  }

  function nextFixtureSourceSequence() {
    const sourceSequence = runtime.nextFixtureSourceSequence;
    runtime.nextFixtureSourceSequence += 1;
    return sourceSequence;
  }

  function sourceFrameDescription(fixture, availableAtEpochMs) {
    return {
      sourceSequence: fixture.sourceSequence,
      markerSequence:
        ((fixture.sourceSequence % MARKER_SEQUENCE_MODULUS) +
          MARKER_SEQUENCE_MODULUS) %
        MARKER_SEQUENCE_MODULUS,
      markerGeneration: Math.floor(
        fixture.sourceSequence / MARKER_SEQUENCE_MODULUS,
      ),
      frameId:
        ((fixture.sourceSequence % MARKER_FRAME_MODULUS) +
          MARKER_FRAME_MODULUS) %
        MARKER_FRAME_MODULUS,
      sourceGeneration: fixture.generation,
      availableAtEpochMs,
    };
  }

  function makeFixtureFrameAvailable(fixture) {
    if (fixture.manualFrames) {
      const availableAtEpochMs = performanceEpochMs();
      try {
        // Keep the authoritative epoch immediately adjacent to requestFrame.
        // Recording it only after success avoids claiming a source frame that
        // the capture track rejected.
        fixture.track.requestFrame();
      } catch {
        fixture.requestFrameFailureCount += 1;
        return false;
      }
      fixture.sourceFrameTimeline.push(
        sourceFrameDescription(fixture, availableAtEpochMs),
      );
      return true;
    }
    fixture.sourceFrameTimeline.push(
      sourceFrameDescription(fixture, performanceEpochMs()),
    );
    return true;
  }

  function createFixtureSource(settings, { generation }) {
    if (typeof document === "undefined") {
      throw new Error("Synthetic camera requires a document");
    }

    const canvas = document.createElement("canvas");
    canvas.width = settings.width;
    canvas.height = settings.height;
    canvas.dataset.conclaveQualityFixture = "camera";
    canvas.dataset.conclaveQualityFixtureGeneration = String(generation);
    const intervalMs = 1000 / settings.frameRate;
    let sourceSequence = nextFixtureSourceSequence();
    const initialRenderStartedAt = nowPerformanceMs();
    renderScaledFixtureFrame(canvas, sourceSequence);
    const initialRenderDurationMs = Math.max(
      0,
      nowPerformanceMs() - initialRenderStartedAt,
    );

    let stream = canvas.captureStream(0);
    let track = stream.getVideoTracks()[0] ?? null;
    let manualFrames = typeof track?.requestFrame === "function";
    if (!track || !manualFrames) {
      track?.stop();
      stream = canvas.captureStream(settings.frameRate);
      track = stream.getVideoTracks()[0] ?? null;
      manualFrames = false;
    }
    if (!track) throw new Error("Canvas capture did not create a video track");
    try {
      track.contentHint = "motion";
    } catch {}

    const fixture = {
      canvas,
      stream,
      track,
      manualFrames,
      generation,
      settings: { ...settings },
      sourceSequence,
      frameId: sourceSequence % MARKER_FRAME_MODULUS,
      timer: null,
      startedAt: nowEpochMs(),
      startedPerformanceAt: initialRenderStartedAt,
      lastRenderStartedAt: initialRenderStartedAt,
      renderDurations: [initialRenderDurationMs],
      renderIntervals: [],
      sourceFrameTimeline: [],
      // A replacement capture source is a new generation on the same exact
      // measurement timeline. Carry the shared epoch forward so its frames can
      // be joined to visual and rVFC evidence without rewriting timestamps.
      sourceTimelineResetAtEpochMs: runtime.fixtureTimelineResetAtEpochMs,
      requestFrameFailureCount: 0,
    };
    runtime.lastFixtureSettings = { ...settings };
    runtime.lastFixtureSourceSequence = sourceSequence;
    runtime.lastFixtureFrameId = fixture.frameId;
    makeFixtureFrameAvailable(fixture);
    fixture.timer = setInterval(() => {
      const renderStartedAt = nowPerformanceMs();
      fixture.renderIntervals.push(
        Math.max(0, renderStartedAt - fixture.lastRenderStartedAt),
      );
      fixture.lastRenderStartedAt = renderStartedAt;
      fixture.sourceSequence = nextFixtureSourceSequence();
      fixture.frameId = fixture.sourceSequence % MARKER_FRAME_MODULUS;
      runtime.lastFixtureSourceSequence = fixture.sourceSequence;
      runtime.lastFixtureFrameId = fixture.frameId;
      renderScaledFixtureFrame(canvas, fixture.sourceSequence);
      fixture.renderDurations.push(
        Math.max(0, nowPerformanceMs() - renderStartedAt),
      );
      makeFixtureFrameAvailable(fixture);
    }, intervalMs);
    runtime.fixtureSourcesByGeneration.set(generation, fixture);
    return fixture;
  }

  function stopFixtureSource(fixture) {
    if (fixture.timer !== null) {
      clearInterval(fixture.timer);
      fixture.timer = null;
    }
    try {
      fixture.track.stop();
    } catch {}
  }

  function getFixtureLifecycle() {
    if (!runtime.fixtureLifecycle) {
      runtime.fixtureLifecycle = createSyntheticSourceLifecycle({
        createSource: createFixtureSource,
        stopSource: stopFixtureSource,
        isSourceLive: (fixture) => fixture.track?.readyState === "live",
        sourceKey: (settings) =>
          `${settings.width}x${settings.height}@${settings.frameRate}`,
      });
    }
    return runtime.fixtureLifecycle;
  }

  function captureSettingsOptions(defaults) {
    return {
      defaultWidth: defaults.width,
      defaultHeight: defaults.height,
      defaultFrameRate: defaults.frameRate,
      minWidth: MIN_FIXTURE_WIDTH,
      maxWidth: runtime.config.width,
      minHeight: MIN_FIXTURE_HEIGHT,
      maxHeight: runtime.config.height,
      minFrameRate: MIN_FIXTURE_FRAME_RATE,
      maxFrameRate: runtime.config.targetFps,
    };
  }

  function resolveFixtureCaptureSettings(constraints, defaults) {
    return resolveSyntheticVideoCaptureSettings(
      constraints,
      captureSettingsOptions(
        defaults ?? {
          width: runtime.config.width,
          height: runtime.config.height,
          frameRate: runtime.config.targetFps,
        },
      ),
    );
  }

  function copyConstraintSet(value) {
    if (!value || typeof value !== "object") return {};
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { ...value };
    }
  }

  function createOverconstrainedError(constraint, message) {
    if (typeof globalThis.OverconstrainedError === "function") {
      return new globalThis.OverconstrainedError(constraint, message);
    }
    const error = new DOMException(message, "OverconstrainedError");
    try {
      Object.defineProperty(error, "constraint", {
        value: constraint,
        enumerable: true,
      });
    } catch {}
    return error;
  }

  function assertFixtureDeviceConstraint(constraints) {
    const deviceId = constraints?.deviceId;
    if (!deviceId || typeof deviceId !== "object" || deviceId.exact === undefined) {
      return;
    }
    const exactValues = Array.isArray(deviceId.exact)
      ? deviceId.exact
      : [deviceId.exact];
    if (!exactValues.includes("conclave-quality-camera")) {
      throw createOverconstrainedError(
        "deviceId",
        "The requested camera is unavailable in the deterministic fixture",
      );
    }
  }

  function defineTrackMethod(track, name, value) {
    try {
      Object.defineProperty(track, name, {
        configurable: true,
        value,
      });
      return;
    } catch {}
    track[name] = value;
  }

  function wrapSyntheticVideoTrack(track, lease, initialConstraints) {
    const settings = { ...lease.settings };
    const capabilityLimits = {
      minWidth: MIN_FIXTURE_WIDTH,
      maxWidth: runtime.config.width,
      minHeight: MIN_FIXTURE_HEIGHT,
      maxHeight: runtime.config.height,
      minFrameRate: MIN_FIXTURE_FRAME_RATE,
      maxFrameRate: runtime.config.targetFps,
    };
    let currentConstraints = copyConstraintSet(initialConstraints);
    let released = false;
    const nativeStop = track.stop.bind(track);
    const nativeClone = track.clone.bind(track);
    const nativeGetSettings =
      typeof track.getSettings === "function" ? track.getSettings.bind(track) : null;
    const nativeGetCapabilities =
      typeof track.getCapabilities === "function"
        ? track.getCapabilities.bind(track)
        : null;

    const release = () => {
      if (released) return;
      released = true;
      lease.release();
    };
    track.addEventListener("ended", release, { once: true });

    defineTrackMethod(track, "stop", () => {
      try {
        nativeStop();
      } finally {
        release();
      }
    });
    defineTrackMethod(track, "clone", () => {
      const retainedLease = lease.retain();
      let clonedTrack = null;
      try {
        clonedTrack = nativeClone();
        return wrapSyntheticVideoTrack(
          clonedTrack,
          retainedLease,
          currentConstraints,
        );
      } catch (error) {
        try {
          clonedTrack?.stop();
        } catch {}
        retainedLease.release();
        throw error;
      }
    });
    defineTrackMethod(track, "applyConstraints", async (nextConstraints = {}) => {
      try {
        assertFixtureDeviceConstraint(nextConstraints);
        const nextSettings = resolveSyntheticVideoCaptureSettings(
          nextConstraints,
          {
            defaultWidth: settings.width,
            defaultHeight: settings.height,
            defaultFrameRate: settings.frameRate,
            ...capabilityLimits,
          },
        );
        const changedConstraint = getSyntheticCaptureReopenConstraint(
          settings,
          nextSettings,
        );
        if (changedConstraint) {
          throw createOverconstrainedError(
            changedConstraint,
            `Changing synthetic ${changedConstraint} requires reopening capture`,
          );
        }
        currentConstraints = copyConstraintSet(nextConstraints);
      } catch (error) {
        if (error?.name === "OverconstrainedError") throw error;
        throw createOverconstrainedError(
          error?.constraint ?? "video",
          String(error?.message ?? error),
        );
      }
    });
    defineTrackMethod(track, "getConstraints", () =>
      copyConstraintSet(currentConstraints),
    );
    defineTrackMethod(track, "getSettings", () => {
      let nativeSettings = {};
      try {
        nativeSettings = nativeGetSettings?.() ?? {};
      } catch {}
      return {
        ...nativeSettings,
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        aspectRatio: settings.width / settings.height,
        deviceId: "conclave-quality-camera",
        groupId: "conclave-quality-fixture",
      };
    });
    defineTrackMethod(track, "getCapabilities", () => {
      let nativeCapabilities = {};
      try {
        nativeCapabilities = nativeGetCapabilities?.() ?? {};
      } catch {}
      return {
        ...nativeCapabilities,
        width: {
          min: capabilityLimits.minWidth,
          max: capabilityLimits.maxWidth,
        },
        height: {
          min: capabilityLimits.minHeight,
          max: capabilityLimits.maxHeight,
        },
        frameRate: {
          min: capabilityLimits.minFrameRate,
          max: capabilityLimits.maxFrameRate,
        },
        aspectRatio: {
          min: capabilityLimits.minWidth / capabilityLimits.maxHeight,
          max: capabilityLimits.maxWidth / capabilityLimits.minHeight,
        },
        deviceId: "conclave-quality-camera",
        groupId: "conclave-quality-fixture",
      };
    });
    try {
      Object.defineProperty(track, "__conclaveQualitySyntheticSettings", {
        value: Object.freeze({ ...settings }),
        enumerable: false,
      });
    } catch {}
    try {
      track.contentHint = "motion";
    } catch {}
    return track;
  }

  function createSyntheticVideoTrack(constraints) {
    const constraintSet =
      constraints && typeof constraints === "object" ? constraints : {};
    assertFixtureDeviceConstraint(constraintSet);
    let settings;
    try {
      settings = resolveFixtureCaptureSettings(constraintSet);
    } catch (error) {
      if (error?.name === "OverconstrainedError") throw error;
      throw createOverconstrainedError(
        error?.constraint ?? "video",
        String(error?.message ?? error),
      );
    }
    const lease = getFixtureLifecycle().acquire(settings);
    let clonedTrack = null;
    try {
      clonedTrack = lease.source.track.clone();
      return wrapSyntheticVideoTrack(
        clonedTrack,
        lease,
        constraintSet,
      );
    } catch (error) {
      try {
        clonedTrack?.stop();
      } catch {}
      lease.release();
      throw error;
    }
  }

  function ensureSilentAudio() {
    if (runtime.silence?.track?.readyState === "live") return runtime.silence;

    const AudioContextConstructor =
      globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (AudioContextConstructor) {
      const context = new AudioContextConstructor({
        latencyHint: "interactive",
        sampleRate: 48_000,
      });
      const destination = context.createMediaStreamDestination();
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(destination);
      source.start();
      context.resume().catch(() => {});
      const track = destination.stream.getAudioTracks()[0] ?? null;
      if (track) {
        try {
          track.contentHint = "speech";
        } catch {}
        runtime.silence = { context, destination, source, track, timer: null };
        return runtime.silence;
      }
    }

    if (globalThis.MediaStreamTrackGenerator && globalThis.AudioData) {
      const generator = new MediaStreamTrackGenerator({ kind: "audio" });
      const writer = generator.writable.getWriter();
      let timestamp = 0;
      let writeInFlight = false;
      const timer = setInterval(() => {
        if (writeInFlight || generator.readyState !== "live") return;
        const numberOfFrames = 960;
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: 48_000,
          numberOfFrames,
          numberOfChannels: 1,
          timestamp,
          data: new Float32Array(numberOfFrames),
        });
        timestamp += 20_000;
        writeInFlight = true;
        writer
          .write(data)
          .catch(() => {})
          .finally(() => {
            data.close();
            writeInFlight = false;
          });
      }, 20);
      runtime.silence = {
        context: null,
        destination: null,
        source: null,
        track: generator,
        timer,
        writer,
      };
      return runtime.silence;
    }

    return null;
  }

  function fakeDevice(kind, deviceId, label) {
    return {
      kind,
      deviceId,
      groupId: "conclave-quality-fixture",
      label,
      toJSON() {
        return {
          kind: this.kind,
          deviceId: this.deviceId,
          groupId: this.groupId,
          label: this.label,
        };
      },
    };
  }

  function callNativeGetUserMedia(receiver, constraints) {
    const requestedAudio = Boolean(constraints?.audio);
    const requestedVideo = Boolean(constraints?.video);
    const call = {
      at: nowEpochMs(),
      requestedAudio,
      requestedVideo,
      blocked: requestedAudio,
    };
    runtime.nativeMediaCaptureCalls.push(call);
    if (requestedAudio) {
      return Promise.reject(
        new DOMException(
          "The quality harness blocked a native microphone capture attempt",
          "NotAllowedError",
        ),
      );
    }
    return runtime.nativeGetUserMedia.call(receiver, constraints);
  }

  function installMediaDevicesOverride() {
    const prototype = globalThis.MediaDevices?.prototype;
    if (!prototype || typeof prototype.getUserMedia !== "function") return;

    runtime.nativeGetUserMedia = prototype.getUserMedia;
    runtime.nativeEnumerateDevices = prototype.enumerateDevices;

    prototype.getUserMedia = async function getUserMedia(constraints = {}) {
      const wantsVideo = Boolean(constraints?.video);
      const wantsAudio = Boolean(constraints?.audio);
      if (!wantsVideo && !wantsAudio) {
        return callNativeGetUserMedia(this, constraints);
      }

      const tracks = [];
      try {
        if (wantsVideo) {
          if (runtime.config.enableSyntheticCamera) {
            await runtime.fixtureImagesPromise;
            if (runtime.fixtureImages.length !== 3) {
              throw new DOMException(
                "Deterministic camera fixture assets are unavailable",
                "NotFoundError",
              );
            }
            tracks.push(createSyntheticVideoTrack(constraints.video));
          } else {
            const nativeStream = await callNativeGetUserMedia(this, {
              ...constraints,
              audio: false,
            });
            const nativeVideoTracks = nativeStream.getVideoTracks();
            const unexpectedAudioTracks = nativeStream.getAudioTracks();
            for (const unexpectedAudioTrack of unexpectedAudioTracks) {
              try {
                unexpectedAudioTrack.stop();
              } catch {}
            }
            if (unexpectedAudioTracks.length > 0) {
              throw new DOMException(
                "Native capture returned audio when it was explicitly disabled",
                "SecurityError",
              );
            }
            if (nativeVideoTracks.length === 0) {
              throw new DOMException(
                "Native video capture did not return a track",
                "NotFoundError",
              );
            }
            tracks.push(...nativeVideoTracks);
          }
        }
        if (wantsAudio) {
          if (runtime.config.enableSyntheticAudio) {
            const silence = ensureSilentAudio();
            if (!silence?.track) {
              throw new DOMException(
                "A synthetic silent audio track could not be created",
                "NotFoundError",
              );
            }
            tracks.push(silence.track.clone());
          } else {
            await callNativeGetUserMedia(this, {
              audio: constraints.audio,
              video: false,
            });
          }
        }
        const stream = new MediaStream(tracks);
        Object.defineProperty(stream, "__conclaveQualitySynthetic", {
          value:
            (wantsVideo && runtime.config.enableSyntheticCamera) ||
            (wantsAudio && runtime.config.enableSyntheticAudio),
          enumerable: false,
        });
        return stream;
      } catch (error) {
        for (const track of tracks) {
          try {
            track.stop();
          } catch {}
        }
        throw error;
      }
    };

    if (typeof runtime.nativeEnumerateDevices === "function") {
      prototype.enumerateDevices = async function enumerateDevices() {
        if (
          !runtime.config.enableSyntheticCamera &&
          !runtime.config.enableSyntheticAudio
        ) {
          return runtime.nativeEnumerateDevices.call(this);
        }
        let devices = [];
        try {
          devices = await runtime.nativeEnumerateDevices.call(this);
        } catch {}
        const withoutFixtureDuplicates = Array.from(devices ?? []).filter(
          (device) =>
            device.deviceId !== "conclave-quality-camera" &&
            device.deviceId !== "conclave-quality-silence",
        );
        return [
          ...withoutFixtureDuplicates,
          ...(runtime.config.enableSyntheticCamera
            ? [
                fakeDevice(
                  "videoinput",
                  "conclave-quality-camera",
                  "Conclave deterministic camera",
                ),
              ]
            : []),
          ...(runtime.config.enableSyntheticAudio
            ? [
                fakeDevice(
                  "audioinput",
                  "conclave-quality-silence",
                  "Conclave silent microphone",
                ),
              ]
            : []),
        ];
      };
    }
  }

  function jsonSafe(value, depth = 0) {
    if (depth > 5) return String(value);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value === "number") return null;
    if (Array.isArray(value)) {
      return value.map((item) => jsonSafe(item, depth + 1));
    }
    if (typeof value === "object") {
      const output = {};
      for (const key of Object.keys(value)) {
        const item = value[key];
        if (typeof item !== "function" && typeof item !== "undefined") {
          output[key] = jsonSafe(item, depth + 1);
        }
      }
      return output;
    }
    return String(value);
  }

  function peerConnectionMetadata(record) {
    const pc = record.pc;
    let configuration = null;
    try {
      configuration = jsonSafe(pc.getConfiguration());
    } catch {}
    return {
      id: record.id,
      createdAt: record.createdAt,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
      configuration,
      events: record.events.slice(),
    };
  }

  function pushPeerConnectionEvent(record, type, details = {}) {
    record.events.push({
      at: nowEpochMs(),
      type,
      ...details,
    });
    if (record.events.length > MAX_PC_EVENTS) {
      record.events.splice(0, record.events.length - MAX_PC_EVENTS);
    }
  }

  function registerPeerConnection(pc) {
    const record = {
      id: `pc-${runtime.nextPeerConnectionId++}`,
      pc,
      createdAt: nowEpochMs(),
      events: [],
    };
    runtime.peerConnections.push(record);
    pushPeerConnectionEvent(record, "created");

    const stateEvents = [
      "connectionstatechange",
      "iceconnectionstatechange",
      "icegatheringstatechange",
      "signalingstatechange",
      "negotiationneeded",
    ];
    for (const eventName of stateEvents) {
      pc.addEventListener(eventName, () => {
        pushPeerConnectionEvent(record, eventName, {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
        });
      });
    }
    pc.addEventListener("track", (event) => {
      pushPeerConnectionEvent(record, "track", {
        kind: event.track?.kind ?? null,
        trackId: event.track?.id ?? null,
        streamIds: Array.from(event.streams ?? []).map((stream) => stream.id),
      });
    });
    pc.addEventListener("icecandidateerror", (event) => {
      pushPeerConnectionEvent(record, "icecandidateerror", {
        errorCode: event.errorCode ?? null,
        errorText: event.errorText ?? null,
      });
    });
    return record;
  }

  function installPeerConnectionRegistry() {
    const NativeRTCPeerConnection = globalThis.RTCPeerConnection;
    if (typeof NativeRTCPeerConnection !== "function") return;
    runtime.nativeRTCPeerConnection = NativeRTCPeerConnection;

    function InstrumentedRTCPeerConnection(...args) {
      const pc = new NativeRTCPeerConnection(...args);
      registerPeerConnection(pc);
      return pc;
    }
    InstrumentedRTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
    Object.setPrototypeOf(InstrumentedRTCPeerConnection, NativeRTCPeerConnection);
    try {
      Object.defineProperty(InstrumentedRTCPeerConnection, "name", {
        value: "RTCPeerConnection",
      });
    } catch {}
    globalThis.RTCPeerConnection = InstrumentedRTCPeerConnection;
  }

  function serializeStatsReport(report) {
    const output = [];
    report.forEach((stat) => {
      const serialized = {};
      for (const key of Object.keys(stat)) {
        serialized[key] = jsonSafe(stat[key]);
      }
      serialized.id = stat.id;
      serialized.type = stat.type;
      serialized.timestamp = stat.timestamp;
      output.push(serialized);
    });
    return output;
  }

  function getRtpSenderId(sender) {
    const existing = runtime.rtpSenderIds.get(sender);
    if (existing) return existing;
    const id = `sender-${runtime.nextRtpSenderId++}`;
    runtime.rtpSenderIds.set(sender, id);
    return id;
  }

  async function collectPeerConnectionStats() {
    const peerConnections = [];
    for (const record of runtime.peerConnections) {
      let stats = [];
      let error = null;
      try {
        stats = serializeStatsReport(await record.pc.getStats());
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      const senders = [];
      const liveSenders = Array.from(record.pc.getSenders?.() ?? []);
      for (let index = 0; index < liveSenders.length; index += 1) {
        const sender = liveSenders[index];
        let parameters = null;
        let parametersError = null;
        let senderStats = [];
        let senderStatsError = null;
        try {
          parameters = jsonSafe(sender.getParameters());
        } catch (caught) {
          parametersError = String(caught?.message ?? caught);
        }
        try {
          senderStats = serializeStatsReport(await sender.getStats());
        } catch (caught) {
          senderStatsError = String(caught?.message ?? caught);
        }
        senders.push({
          id: getRtpSenderId(sender),
          index,
          track: sender.track
            ? {
                id: sender.track.id,
                kind: sender.track.kind,
                enabled: sender.track.enabled,
                muted: sender.track.muted,
                readyState: sender.track.readyState,
              }
            : null,
          parameters,
          parametersError,
          stats: senderStats,
          statsError: senderStatsError,
        });
      }
      peerConnections.push({
        ...peerConnectionMetadata(record),
        stats,
        statsError: error,
        senders,
      });
    }
    return {
      capturedAt: nowEpochMs(),
      peerConnections,
    };
  }

  function statsIndex(snapshot) {
    const index = new Map();
    for (const connection of snapshot?.peerConnections ?? []) {
      for (const stat of connection.stats ?? []) {
        index.set(`${connection.id}:${stat.id}`, stat);
      }
    }
    return index;
  }

  function counterDelta(current, previous) {
    const currentNumber = finiteNumber(current, 0);
    const previousNumber = finiteNumber(previous, 0);
    return currentNumber >= previousNumber
      ? currentNumber - previousNumber
      : currentNumber;
  }

  function selectedCandidatePairSummary(connection) {
    const stats = connection?.stats ?? [];
    const byId = new Map(stats.map((stat) => [stat.id, stat]));
    let pair = null;
    let selectedBy = null;

    for (const transport of stats) {
      if (transport.type !== "transport" || !transport.selectedCandidatePairId) {
        continue;
      }
      const candidate = byId.get(transport.selectedCandidatePairId);
      if (candidate?.type === "candidate-pair") {
        pair = candidate;
        selectedBy = "transport";
        break;
      }
    }
    if (!pair) {
      pair = stats.find(
        (stat) => stat.type === "candidate-pair" && stat.selected === true,
      );
      if (pair) selectedBy = "selected-flag";
    }
    if (!pair) {
      pair = stats.find(
        (stat) =>
          stat.type === "candidate-pair" &&
          stat.nominated === true &&
          stat.state === "succeeded",
      );
      if (pair) selectedBy = "nominated-succeeded";
    }
    if (!pair) return null;

    const local = byId.get(pair.localCandidateId) ?? null;
    const remote = byId.get(pair.remoteCandidateId) ?? null;
    const localCandidateType = local?.candidateType ?? null;
    const remoteCandidateType = remote?.candidateType ?? null;
    const localProtocol = local?.protocol ?? null;
    const remoteProtocol = remote?.protocol ?? null;
    const protocols = Array.from(
      new Set([localProtocol, remoteProtocol].filter(Boolean)),
    );
    const localRelayProtocol = local?.relayProtocol ?? null;
    const remoteRelayProtocol = remote?.relayProtocol ?? null;
    const relayProtocols = Array.from(
      new Set([localRelayProtocol, remoteRelayProtocol].filter(Boolean)),
    );

    return {
      id: pair.id,
      selectedBy,
      state: pair.state ?? null,
      nominated:
        typeof pair.nominated === "boolean" ? pair.nominated : null,
      protocol: protocols.length > 0 ? protocols.join("/") : null,
      localProtocol,
      remoteProtocol,
      localCandidateType,
      remoteCandidateType,
      usesRelay:
        localCandidateType || remoteCandidateType
          ? localCandidateType === "relay" || remoteCandidateType === "relay"
          : null,
      relayProtocol:
        relayProtocols.length > 0 ? relayProtocols.join("/") : null,
      localRelayProtocol,
      remoteRelayProtocol,
      localNetworkType: local?.networkType ?? null,
      localTcpType: local?.tcpType ?? null,
      remoteTcpType: remote?.tcpType ?? null,
      currentRoundTripTimeMs: Number.isFinite(pair.currentRoundTripTime)
        ? round(pair.currentRoundTripTime * 1000, 2)
        : null,
      availableIncomingBitrateBps: Number.isFinite(
        pair.availableIncomingBitrate,
      )
        ? round(pair.availableIncomingBitrate, 0)
        : null,
      availableOutgoingBitrateBps: Number.isFinite(
        pair.availableOutgoingBitrate,
      )
        ? round(pair.availableOutgoingBitrate, 0)
        : null,
    };
  }

  function deriveRtcSummary(
    startSnapshot,
    endSnapshot,
    durationMs,
    mediaPathBinding = null,
  ) {
    const start = statsIndex(startSnapshot);
    let framesDecodedDelta = 0;
    let framesDroppedDelta = 0;
    let videoInboundCount = 0;
    let frameCounterEvidenceValid = true;
    let frameCounterResetDetected = false;
    let bytesReceivedDelta = 0;
    let packetsLostDelta = 0;
    let packetsReceivedDelta = 0;
    let nackCountDelta = 0;
    let pliCountDelta = 0;
    let firCountDelta = 0;
    let keyFramesDecodedDelta = 0;
    let freezeCountDelta = 0;
    let totalFreezesDurationDelta = 0;
    let qpSumDelta = 0;
    let jitterBufferDelayDelta = 0;
    let jitterBufferTargetDelayDelta = 0;
    let jitterBufferMinimumDelayDelta = 0;
    let jitterBufferEmittedCountDelta = 0;
    let totalDecodeTimeDelta = 0;
    let decodeTimedFramesDelta = 0;
    let hasJitterBufferDelay = false;
    let hasJitterBufferTargetDelay = false;
    let hasJitterBufferMinimumDelay = false;
    let jitterBufferCounterResetDetected = false;
    let hasTotalDecodeTime = false;
    let frameWidth = 0;
    let frameHeight = 0;
    let primaryInbound = null;
    const jitterValues = [];
    const fpsValues = [];

    for (const connection of endSnapshot?.peerConnections ?? []) {
      if (
        mediaPathBinding?.connectionId &&
        String(connection.id ?? "") !== mediaPathBinding.connectionId
      ) {
        continue;
      }
      for (const stat of connection.stats ?? []) {
        const kind = String(stat.kind ?? stat.mediaType ?? "").toLowerCase();
        if (stat.type !== "inbound-rtp" || kind !== "video" || stat.isRemote) {
          continue;
        }
        if (stat.mid === "probator" || stat.trackIdentifier === "probator") {
          continue;
        }
        if (
          mediaPathBinding &&
          (String(stat.id ?? "") !== mediaPathBinding.statId ||
            String(stat.ssrc ?? "") !== mediaPathBinding.ssrc ||
            String(stat.trackIdentifier ?? "") !==
              mediaPathBinding.consumerId)
        ) {
          continue;
        }
        const statKey = `${connection.id}:${stat.id}`;
        const previous = start.get(statKey) ?? {};
        videoInboundCount += 1;
        const decodedFrameEvidence = calculateStrictCounterDelta(
          stat.framesDecoded,
          previous.framesDecoded,
        );
        const droppedFrameEvidence = calculateStrictCounterDelta(
          stat.framesDropped,
          previous.framesDropped,
        );
        if (decodedFrameEvidence.reset || droppedFrameEvidence.reset) {
          frameCounterResetDetected = true;
        }
        if (!decodedFrameEvidence.valid || !droppedFrameEvidence.valid) {
          frameCounterEvidenceValid = false;
        }
        const streamFramesDecodedDelta = decodedFrameEvidence.valid
          ? decodedFrameEvidence.delta
          : 0;
        const streamBytesReceivedDelta = counterDelta(
          stat.bytesReceived,
          previous.bytesReceived,
        );
        framesDecodedDelta += streamFramesDecodedDelta;
        framesDroppedDelta += droppedFrameEvidence.valid
          ? droppedFrameEvidence.delta
          : 0;
        bytesReceivedDelta += streamBytesReceivedDelta;
        packetsLostDelta += counterDelta(stat.packetsLost, previous.packetsLost);
        packetsReceivedDelta += counterDelta(
          stat.packetsReceived,
          previous.packetsReceived,
        );
        nackCountDelta += counterDelta(stat.nackCount, previous.nackCount);
        pliCountDelta += counterDelta(stat.pliCount, previous.pliCount);
        firCountDelta += counterDelta(stat.firCount, previous.firCount);
        keyFramesDecodedDelta += counterDelta(
          stat.keyFramesDecoded,
          previous.keyFramesDecoded,
        );
        freezeCountDelta += counterDelta(stat.freezeCount, previous.freezeCount);
        totalFreezesDurationDelta += counterDelta(
          stat.totalFreezesDuration,
          previous.totalFreezesDuration,
        );
        qpSumDelta += counterDelta(stat.qpSum, previous.qpSum);
        const emittedCountEvidence = calculateStrictCounterDelta(
          stat.jitterBufferEmittedCount,
          previous.jitterBufferEmittedCount,
        );
        const delayEvidence = calculateStrictCounterDelta(
          stat.jitterBufferDelay,
          previous.jitterBufferDelay,
        );
        const targetDelayEvidence = calculateStrictCounterDelta(
          stat.jitterBufferTargetDelay,
          previous.jitterBufferTargetDelay,
        );
        const minimumDelayEvidence = calculateStrictCounterDelta(
          stat.jitterBufferMinimumDelay,
          previous.jitterBufferMinimumDelay,
        );
        if (
          emittedCountEvidence.reset ||
          delayEvidence.reset ||
          targetDelayEvidence.reset ||
          minimumDelayEvidence.reset
        ) {
          jitterBufferCounterResetDetected = true;
        }
        if (emittedCountEvidence.valid && delayEvidence.valid) {
          hasJitterBufferDelay = true;
          jitterBufferDelayDelta += delayEvidence.delta;
          jitterBufferEmittedCountDelta += emittedCountEvidence.delta;
        }
        if (emittedCountEvidence.valid && targetDelayEvidence.valid) {
          hasJitterBufferTargetDelay = true;
          jitterBufferTargetDelayDelta += targetDelayEvidence.delta;
        }
        if (emittedCountEvidence.valid && minimumDelayEvidence.valid) {
          hasJitterBufferMinimumDelay = true;
          jitterBufferMinimumDelayDelta += minimumDelayEvidence.delta;
        }
        if (Number.isFinite(stat.totalDecodeTime)) {
          hasTotalDecodeTime = true;
          totalDecodeTimeDelta += counterDelta(
            stat.totalDecodeTime,
            previous.totalDecodeTime,
          );
          decodeTimedFramesDelta += streamFramesDecodedDelta;
        }
        frameWidth = Math.max(frameWidth, finiteNumber(stat.frameWidth, 0));
        frameHeight = Math.max(frameHeight, finiteNumber(stat.frameHeight, 0));
        if (Number.isFinite(stat.jitter)) jitterValues.push(stat.jitter * 1000);
        if (Number.isFinite(stat.framesPerSecond)) {
          fpsValues.push(stat.framesPerSecond);
        }
        if (
          !primaryInbound ||
          streamBytesReceivedDelta > primaryInbound.bytesReceivedDelta ||
          (streamBytesReceivedDelta === primaryInbound.bytesReceivedDelta &&
            streamFramesDecodedDelta > primaryInbound.framesDecodedDelta)
        ) {
          primaryInbound = {
            connection,
            stat,
            bytesReceivedDelta: streamBytesReceivedDelta,
            framesDecodedDelta: streamFramesDecodedDelta,
          };
        }
      }
    }

    const snapshotDurationMs =
      Number.isFinite(startSnapshot?.capturedAt) &&
      Number.isFinite(endSnapshot?.capturedAt) &&
      endSnapshot.capturedAt > startSnapshot.capturedAt
        ? endSnapshot.capturedAt - startSnapshot.capturedAt
        : durationMs;
    const durationSeconds = Math.max(0.001, snapshotDurationMs / 1000);
    frameCounterEvidenceValid =
      frameCounterEvidenceValid &&
      !frameCounterResetDetected &&
      videoInboundCount > 0;
    const totalPackets = packetsLostDelta + packetsReceivedDelta;
    const primaryStats = new Map(
      (primaryInbound?.connection?.stats ?? []).map((stat) => [stat.id, stat]),
    );
    const primaryCodec = primaryInbound?.stat?.codecId
      ? primaryStats.get(primaryInbound.stat.codecId)
      : null;
    const codecMimeType =
      primaryCodec?.mimeType ?? primaryInbound?.stat?.codecMimeType ?? null;
    const decoderImplementation =
      typeof primaryInbound?.stat?.decoderImplementation === "string"
        ? primaryInbound.stat.decoderImplementation
        : null;
    const powerEfficientDecoder =
      typeof primaryInbound?.stat?.powerEfficientDecoder === "boolean"
        ? primaryInbound.stat.powerEfficientDecoder
        : null;
    const boundMediaPathMatched = mediaPathBinding
      ? Boolean(
          primaryInbound &&
            String(primaryInbound.connection?.id ?? "") ===
              mediaPathBinding.connectionId &&
            String(primaryInbound.stat?.id ?? "") === mediaPathBinding.statId &&
            String(primaryInbound.stat?.ssrc ?? "") === mediaPathBinding.ssrc &&
            String(primaryInbound.stat?.trackIdentifier ?? "") ===
              mediaPathBinding.consumerId &&
            String(codecMimeType ?? "").toLowerCase() ===
              mediaPathBinding.codecMimeType,
        )
      : null;
    const selectedCandidatePair = primaryInbound
      ? selectedCandidatePairSummary(primaryInbound.connection)
      : (endSnapshot?.peerConnections ?? [])
          .map(selectedCandidatePairSummary)
          .find(Boolean) ?? null;
    return {
      framesDecodedDelta: frameCounterEvidenceValid
        ? framesDecodedDelta
        : null,
      decodedFramesPerSecond: frameCounterEvidenceValid
        ? round(framesDecodedDelta / durationSeconds, 3)
        : null,
      framesDroppedDelta: frameCounterEvidenceValid
        ? framesDroppedDelta
        : null,
      frameCounterEvidenceValid,
      frameCounterResetDetected,
      bytesReceivedDelta,
      statsDurationMs: round(snapshotDurationMs, 2),
      averageVideoBitrateBps: round((bytesReceivedDelta * 8) / durationSeconds, 0),
      packetLossRatio:
        totalPackets > 0 ? round(packetsLostDelta / totalPackets, 6) : 0,
      packetsLostDelta,
      packetsReceivedDelta,
      nackCountDelta,
      pliCountDelta,
      firCountDelta,
      keyFramesDecodedDelta,
      freezeCountDelta,
      totalFreezesDurationMs: round(totalFreezesDurationDelta * 1000, 2),
      averageQp:
        framesDecodedDelta > 0 ? round(qpSumDelta / framesDecodedDelta, 2) : null,
      codecMimeType,
      decoderImplementation,
      powerEfficientDecoder,
      jitterBufferDelayMsPerFrame:
        hasJitterBufferDelay &&
        !jitterBufferCounterResetDetected &&
        jitterBufferEmittedCountDelta > 0
          ? round(
              (jitterBufferDelayDelta * 1000) /
                jitterBufferEmittedCountDelta,
              3,
            )
          : null,
      jitterBufferDelayEvidenceComplete:
        hasJitterBufferDelay &&
        !jitterBufferCounterResetDetected &&
        jitterBufferEmittedCountDelta > 0,
      jitterBufferCounterResetDetected,
      jitterBufferTargetDelayMsPerFrame:
        hasJitterBufferTargetDelay &&
        !jitterBufferCounterResetDetected &&
        jitterBufferEmittedCountDelta > 0
          ? round(
              (jitterBufferTargetDelayDelta * 1000) /
                jitterBufferEmittedCountDelta,
              3,
            )
          : null,
      jitterBufferMinimumDelayMsPerFrame:
        hasJitterBufferMinimumDelay &&
        !jitterBufferCounterResetDetected &&
        jitterBufferEmittedCountDelta > 0
          ? round(
              (jitterBufferMinimumDelayDelta * 1000) /
                jitterBufferEmittedCountDelta,
              3,
            )
          : null,
      totalDecodeTimeMsPerFrame:
        hasTotalDecodeTime && decodeTimedFramesDelta > 0
          ? round((totalDecodeTimeDelta * 1000) / decodeTimedFramesDelta, 3)
          : null,
      selectedCandidatePair,
      selectedCandidatePairProtocol: selectedCandidatePair?.protocol ?? null,
      selectedCandidatePairUsesRelay: selectedCandidatePair?.usesRelay ?? null,
      selectedCandidatePairRelayProtocol:
        selectedCandidatePair?.relayProtocol ?? null,
      selectedCandidatePairLocalCandidateType:
        selectedCandidatePair?.localCandidateType ?? null,
      selectedCandidatePairRemoteCandidateType:
        selectedCandidatePair?.remoteCandidateType ?? null,
      frameWidth,
      frameHeight,
      jitterMs:
        jitterValues.length > 0
          ? round(
              jitterValues.reduce((sum, value) => sum + value, 0) /
                jitterValues.length,
              2,
            )
          : null,
      reportedFramesPerSecond:
        fpsValues.length > 0
          ? round(
              fpsValues.reduce((sum, value) => sum + value, 0) / fpsValues.length,
              2,
            )
          : null,
      boundMediaPathMatched,
      boundMediaPath: mediaPathBinding ? { ...mediaPathBinding } : null,
      inboundStatId: primaryInbound?.stat?.id ?? null,
      inboundSsrc: primaryInbound?.stat?.ssrc ?? null,
      inboundTrackIdentifier:
        primaryInbound?.stat?.trackIdentifier ?? null,
    };
  }

  function averageCellLuma(imageData, rowIndex, cellIndex) {
    const width = imageData.width;
    const height = imageData.height;
    const rowTop = rowIndex * MARKER_ROW_HEIGHT;
    const cellWidth = width / MARKER_CELL_COUNT;
    const xStart = clamp(
      Math.floor((cellIndex + 0.22) * cellWidth),
      0,
      width - 1,
    );
    const xEnd = clamp(
      Math.ceil((cellIndex + 0.78) * cellWidth),
      xStart + 1,
      width,
    );
    const yStart = clamp(
      Math.floor(rowTop + MARKER_ROW_HEIGHT * 0.22),
      0,
      height - 1,
    );
    const yEnd = clamp(
      Math.ceil(rowTop + MARKER_ROW_HEIGHT * 0.78),
      yStart + 1,
      height,
    );
    let sum = 0;
    let count = 0;
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        const offset = (y * width + x) * 4;
        sum +=
          imageData.data[offset] * 0.2126 +
          imageData.data[offset + 1] * 0.7152 +
          imageData.data[offset + 2] * 0.0722;
        count += 1;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  function decodeMarkerRows(imageData) {
    const candidates = [];
    for (let repetition = 0; repetition < MARKER_REPETITIONS; repetition += 1) {
      const bits = [];
      let confidenceSum = 0;
      for (let bitIndex = 0; bitIndex < MARKER_PAYLOAD_BITS; bitIndex += 1) {
        const first = averageCellLuma(imageData, repetition, bitIndex * 2);
        const second = averageCellLuma(imageData, repetition, bitIndex * 2 + 1);
        bits.push(first > second ? 1 : 0);
        confidenceSum += Math.abs(first - second) / 255;
      }
      const decoded = decodeMarkerBits(bits);
      if (!decoded) continue;
      candidates.push({
        repetition,
        markerSequence: decoded.markerSequence,
        frameId: decoded.frameId,
        confidence: confidenceSum / MARKER_PAYLOAD_BITS,
      });
    }

    if (candidates.length === 0) {
      return {
        valid: false,
        markerSequence: null,
        frameId: null,
        confidence: 0,
        copies: 0,
      };
    }
    const groups = new Map();
    for (const candidate of candidates) {
      const group = groups.get(candidate.markerSequence) ?? {
        markerSequence: candidate.markerSequence,
        frameId: candidate.frameId,
        count: 0,
        confidence: 0,
      };
      group.count += 1;
      group.confidence += candidate.confidence;
      groups.set(candidate.markerSequence, group);
    }
    const selected = Array.from(groups.values()).sort(
      (left, right) =>
        right.count - left.count ||
        right.confidence / right.count - left.confidence / left.count,
    )[0];
    return {
      valid: selected.count >= 2,
      markerSequence: selected.markerSequence,
      frameId: selected.frameId,
      confidence: selected.confidence / selected.count,
      copies: selected.count,
    };
  }

  function decodeMarkerFromSource(state, source, sourceWidth, sourceHeight) {
    if (!source || sourceWidth <= 0 || sourceHeight <= 0) {
      return {
        valid: false,
        markerSequence: null,
        frameId: null,
        confidence: 0,
        copies: 0,
      };
    }
    const canvas = state.markerCanvas;
    const context = state.markerContext;
    const rects = markerRects(sourceWidth, sourceHeight);
    try {
      for (let repetition = 0; repetition < rects.length; repetition += 1) {
        const rect = rects[repetition];
        context.drawImage(
          source,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          repetition * MARKER_ROW_HEIGHT,
          canvas.width,
          MARKER_ROW_HEIGHT,
        );
      }
      return decodeMarkerRows(
        context.getImageData(0, 0, canvas.width, canvas.height),
      );
    } catch {
      return {
        valid: false,
        markerSequence: null,
        frameId: null,
        confidence: 0,
        copies: 0,
      };
    }
  }

  function decodeMarkerFromVideo(state, video) {
    return decodeMarkerFromSource(
      state,
      video,
      video?.videoWidth ?? 0,
      video?.videoHeight ?? 0,
    );
  }

  function resolveSamplerMarker(state, marker, callbackAtMs) {
    if (marker.valid !== true) {
      return {
        ...marker,
        sourceSequence: null,
        markerGeneration: null,
        sequenceAmbiguous: false,
      };
    }
    const resolved = resolveRollingMarkerSequence({
      previousSourceSequence: state.lastDecodedSourceSequence,
      markerSequence: marker.markerSequence,
      elapsedSourceFrames:
        (callbackAtMs - state.startedPerformanceAt) /
        state.expectedFrameIntervalMs,
      modulus: MARKER_SEQUENCE_MODULUS,
    });
    if (!resolved.valid || resolved.sourceSequence === null) {
      return {
        ...marker,
        valid: false,
        sourceSequence: null,
        markerGeneration: null,
        sequenceAmbiguous: true,
      };
    }
    state.lastDecodedSourceSequence = resolved.sourceSequence;
    if (resolved.ambiguous) {
      state.markerSequenceAmbiguityCount += 1;
      // Cadence deltas cannot bridge an ambiguous reset or large jump.
      state.lastMarkerId = null;
      state.lastMarkerAdvanceAt = null;
      state.presentedFramesSinceLastMarker = 0;
      state.duplicateCallbacksSinceMarkerAdvance = 0;
    }
    const frameId =
      resolved.sourceSequence % MARKER_FRAME_MODULUS;
    return {
      ...marker,
      valid: marker.valid === true && !resolved.ambiguous,
      sourceSequence: resolved.sourceSequence,
      markerGeneration: resolved.markerGeneration,
      sequenceAmbiguous: resolved.ambiguous,
      frameId,
      sceneId: fixtureSceneId(frameId),
    };
  }

  function captureAtomicVideoSnapshot(state, video) {
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const canvas = state.sampleSnapshotCanvas;
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const context = canvas.getContext("2d", { alpha: false });
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas;
    } catch {
      return null;
    }
  }

  function isLiveRemoteWebcamVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    if (video.dataset.meetVideoStreamType !== "webcam") return false;
    if (!video.isConnected || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return false;
    }
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) return false;
    return stream.getVideoTracks().some((track) => track.readyState === "live");
  }

  function remoteVideoCandidates(targetTrackId = null) {
    const videos = Array.from(
      document.querySelectorAll(
        'video[data-meet-tile-video="true"][data-meet-video-stream-type="webcam"]',
      ),
    )
      .filter(isLiveRemoteWebcamVideo)
      .filter((video) => {
        if (!targetTrackId) return true;
        const stream = video.srcObject;
        return (
          stream instanceof MediaStream &&
          stream.getVideoTracks().some((track) => track.id === targetTrackId)
        );
      });
    return videos
      .map((video) => {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) > 0 &&
          rect.width > 0 &&
          rect.height > 0;
        return {
          video,
          score:
            (visible ? 1_000_000 : 0) +
            Math.max(0, rect.width * rect.height) +
            video.readyState * 10_000,
        };
      })
      .sort((left, right) => right.score - left.score);
  }

  function percentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    const position = clamp(fraction, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return (
      sorted[lower] * (upper - position) + sorted[upper] * (position - lower)
    );
  }

  function nearestRankPercentile(values, fraction) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    const rank = Math.max(
      1,
      Math.ceil(clamp(fraction, 0, 1) * sorted.length),
    );
    return sorted[Math.min(sorted.length - 1, rank - 1)];
  }

  function markerPixelMask(width, height) {
    const mask = new Uint8Array(width * height);
    for (const rect of markerRects(width, height)) {
      const startX = clamp(Math.floor(rect.x) - 1, 0, width - 1);
      const endX = clamp(
        Math.ceil(rect.x + rect.width) + 1,
        startX + 1,
        width,
      );
      const startY = clamp(Math.floor(rect.y) - 1, 0, height - 1);
      const endY = clamp(
        Math.ceil(rect.y + rect.height) + 1,
        startY + 1,
        height,
      );
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          mask[y * width + x] = 1;
        }
      }
    }
    return mask;
  }

  function lumaPlane(imageData) {
    const output = new Float32Array(imageData.width * imageData.height);
    for (let index = 0; index < output.length; index += 1) {
      const offset = index * 4;
      output[index] =
        imageData.data[offset] * 0.2126 +
        imageData.data[offset + 1] * 0.7152 +
        imageData.data[offset + 2] * 0.0722;
    }
    return output;
  }

  function chromaPlanes(imageData) {
    const cb = new Float32Array(imageData.width * imageData.height);
    const cr = new Float32Array(imageData.width * imageData.height);
    for (let index = 0; index < cb.length; index += 1) {
      const offset = index * 4;
      const red = imageData.data[offset];
      const green = imageData.data[offset + 1];
      const blue = imageData.data[offset + 2];
      const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      cb[index] = (blue - luma) / 1.8556 + 128;
      cr[index] = (red - luma) / 1.5748 + 128;
    }
    return { cb, cr };
  }

  function downsamplePlane2x(plane, width, height) {
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const output = new Float32Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y += 1) {
      for (let x = 0; x < nextWidth; x += 1) {
        const sourceX = x * 2;
        const sourceY = y * 2;
        const top = sourceY * width + sourceX;
        const bottom = Math.min(height - 1, sourceY + 1) * width + sourceX;
        output[y * nextWidth + x] =
          (plane[top] +
            plane[top + Math.min(1, width - 1 - sourceX)] +
            plane[bottom] +
            plane[bottom + Math.min(1, width - 1 - sourceX)]) /
          4;
      }
    }
    return { plane: output, width: nextWidth, height: nextHeight };
  }

  function computeSsim(actual, expected, width, height, pixelMask) {
    const blockSize = 8;
    const c1 = (0.01 * 255) ** 2;
    const c2 = (0.03 * 255) ** 2;
    let total = 0;
    let blocks = 0;
    for (let top = 0; top < height; top += blockSize) {
      for (let left = 0; left < width; left += blockSize) {
        let count = 0;
        let actualSum = 0;
        let expectedSum = 0;
        const bottom = Math.min(height, top + blockSize);
        const right = Math.min(width, left + blockSize);
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = y * width + x;
            if (pixelMask[index]) continue;
            actualSum += actual[index];
            expectedSum += expected[index];
            count += 1;
          }
        }
        if (count < 8) continue;
        const actualMean = actualSum / count;
        const expectedMean = expectedSum / count;
        let actualVariance = 0;
        let expectedVariance = 0;
        let covariance = 0;
        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            const index = y * width + x;
            if (pixelMask[index]) continue;
            const actualDelta = actual[index] - actualMean;
            const expectedDelta = expected[index] - expectedMean;
            actualVariance += actualDelta * actualDelta;
            expectedVariance += expectedDelta * expectedDelta;
            covariance += actualDelta * expectedDelta;
          }
        }
        const divisor = Math.max(1, count - 1);
        actualVariance /= divisor;
        expectedVariance /= divisor;
        covariance /= divisor;
        const numerator =
          (2 * actualMean * expectedMean + c1) * (2 * covariance + c2);
        const denominator =
          (actualMean ** 2 + expectedMean ** 2 + c1) *
          (actualVariance + expectedVariance + c2);
        total += denominator > 0 ? numerator / denominator : 1;
        blocks += 1;
      }
    }
    return blocks > 0 ? clamp(total / blocks, -1, 1) : 0;
  }

  function sobelMagnitude(plane, width, x, y) {
    const top = (y - 1) * width;
    const middle = y * width;
    const bottom = (y + 1) * width;
    const gx =
      -plane[top + x - 1] +
      plane[top + x + 1] -
      2 * plane[middle + x - 1] +
      2 * plane[middle + x + 1] -
      plane[bottom + x - 1] +
      plane[bottom + x + 1];
    const gy =
      -plane[top + x - 1] -
      2 * plane[top + x] -
      plane[top + x + 1] +
      plane[bottom + x - 1] +
      2 * plane[bottom + x] +
      plane[bottom + x + 1];
    return Math.hypot(gx, gy);
  }

  function edgeRetention(actual, expected, width, height, pixelMask) {
    let retained = 0;
    let expectedTotal = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (
          pixelMask[index] ||
          pixelMask[index - 1] ||
          pixelMask[index + 1] ||
          pixelMask[index - width] ||
          pixelMask[index + width]
        ) {
          continue;
        }
        const expectedMagnitude = sobelMagnitude(expected, width, x, y);
        if (expectedMagnitude < 12) continue;
        const actualMagnitude = sobelMagnitude(actual, width, x, y);
        retained += Math.min(expectedMagnitude, actualMagnitude);
        expectedTotal += expectedMagnitude;
      }
    }
    return expectedTotal > 0 ? clamp(retained / expectedTotal, 0, 1) : 1;
  }

  function rawBlockiness(plane, width, height, pixelMask) {
    let boundarySum = 0;
    let boundaryCount = 0;
    let interiorSum = 0;
    let interiorCount = 0;
    for (let y = 1; y < height; y += 1) {
      const horizontalBoundary = y % 8 === 0;
      const horizontalInterior = y % 8 === 4;
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const previousIndex = (y - 1) * width + x;
        if (pixelMask[index] || pixelMask[previousIndex]) continue;
        const difference = Math.abs(plane[index] - plane[previousIndex]);
        if (horizontalBoundary) {
          boundarySum += difference;
          boundaryCount += 1;
        } else if (horizontalInterior) {
          interiorSum += difference;
          interiorCount += 1;
        }
      }
    }
    for (let x = 1; x < width; x += 1) {
      const verticalBoundary = x % 8 === 0;
      const verticalInterior = x % 8 === 4;
      if (!verticalBoundary && !verticalInterior) continue;
      for (let y = 0; y < height; y += 1) {
        const index = y * width + x;
        if (pixelMask[index] || pixelMask[index - 1]) continue;
        const difference = Math.abs(plane[index] - plane[index - 1]);
        if (verticalBoundary) {
          boundarySum += difference;
          boundaryCount += 1;
        } else {
          interiorSum += difference;
          interiorCount += 1;
        }
      }
    }
    const boundaryMean = boundaryCount > 0 ? boundarySum / boundaryCount : 0;
    const interiorMean = interiorCount > 0 ? interiorSum / interiorCount : 0;
    return Math.max(0, (boundaryMean - interiorMean) / 255);
  }

  function compareImages(actualImage, expectedImage) {
    return visualMetrics.compareImages(actualImage, expectedImage);
  }

  function renderExpectedFrame(canvas, frameId) {
    renderScaledFixtureFrame(canvas, frameId);
  }

  function differencePng(actualImage, expectedImage) {
    const canvas = document.createElement("canvas");
    canvas.width = actualImage.width;
    canvas.height = actualImage.height;
    const context = canvas.getContext("2d", { alpha: false });
    const output = context.createImageData(canvas.width, canvas.height);
    for (let index = 0; index < output.data.length; index += 4) {
      output.data[index] = clamp(
        Math.abs(actualImage.data[index] - expectedImage.data[index]) * 4,
        0,
        255,
      );
      output.data[index + 1] = clamp(
        Math.abs(actualImage.data[index + 1] - expectedImage.data[index + 1]) * 4,
        0,
        255,
      );
      output.data[index + 2] = clamp(
        Math.abs(actualImage.data[index + 2] - expectedImage.data[index + 2]) * 4,
        0,
        255,
      );
      output.data[index + 3] = 255;
    }
    context.putImageData(output, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function sampleQualityRank(sample) {
    if (!sample.valid) return -1;
    return (
      finiteNumber(sample.multiScaleSsim ?? sample.ssim, 0) * 0.4 +
      clamp(finiteNumber(sample.psnrDb, 0) / 55, 0, 1) * 0.13 +
      finiteNumber(sample.edgeRetention, 0) * 0.18 +
      (1 - clamp(finiteNumber(sample.meanAbsoluteLumaError, 255) / 20, 0, 1)) *
        0.1 +
      clamp(finiteNumber(sample.chromaPsnrDb, 0) / 55, 0, 1) * 0.06 +
      finiteNumber(sample.chromaSsim, 0) * 0.08 +
      (1 -
        clamp(
          finiteNumber(sample.meanAbsoluteChromaError, 255) / 20,
          0,
          1,
        )) *
        0.05 -
      finiteNumber(sample.blockiness, 0) * 0.1
    );
  }

  function considerWorstFrame(
    state,
    sample,
    actualCanvas,
    expectedCanvas,
    actualImage,
    expectedImage,
  ) {
    const rank = sampleQualityRank(sample);
    const currentBestOfWorst = state.worstFrames[state.worstFrames.length - 1];
    if (
      state.worstFrames.length >= MAX_WORST_FRAMES &&
      currentBestOfWorst &&
      rank >= currentBestOfWorst._rank
    ) {
      return;
    }
    const frame = {
      _rank: rank,
      frameId: sample.frameId,
      sampledAtMs: sample.sampledAtMs,
      valid: sample.valid,
      ssim: sample.ssim ?? null,
      psnrDb: sample.psnrDb ?? null,
      receivedPngDataUrl: actualCanvas.toDataURL("image/png"),
      expectedPngDataUrl: expectedCanvas?.toDataURL("image/png") ?? null,
      differencePngDataUrl:
        actualImage && expectedImage ? differencePng(actualImage, expectedImage) : null,
    };
    state.worstFrames.push(frame);
    state.worstFrames.sort((left, right) => left._rank - right._rank);
    if (state.worstFrames.length > MAX_WORST_FRAMES) {
      state.worstFrames.length = MAX_WORST_FRAMES;
    }
  }

  function retainDistributedAuditFrames(candidates) {
    if (candidates.length <= MAX_AUDIT_FRAME_CANDIDATES) return candidates;
    const sorted = candidates
      .slice()
      .sort((left, right) => left._rank - right._rank);
    const retained = [];
    const seen = new Set();
    for (let index = 0; index < MAX_AUDIT_FRAME_CANDIDATES; index += 1) {
      const sourceIndex = Math.round(
        (index * (sorted.length - 1)) / (MAX_AUDIT_FRAME_CANDIDATES - 1),
      );
      if (seen.has(sourceIndex)) continue;
      seen.add(sourceIndex);
      retained.push(sorted[sourceIndex]);
    }
    return retained;
  }

  function considerAuditFrame(
    state,
    sample,
    actualImage,
    expectedImage,
  ) {
    if (!sample.valid || !actualImage || !expectedImage) return;
    const frame = {
      _sampleId: state.nextAuditSampleId,
      _rank: sampleQualityRank(sample),
      frameId: sample.frameId,
      sceneId: sample.sceneId,
      sampledAtMs: sample.sampledAtMs,
      ssim: sample.ssim ?? null,
      multiScaleSsim: sample.multiScaleSsim ?? null,
      multiScaleLevels: sample.multiScaleLevels ?? null,
      psnrDb: sample.psnrDb ?? null,
      chromaPsnrDb: sample.chromaPsnrDb ?? null,
      chromaSsim: sample.chromaSsim ?? null,
      meanAbsoluteLumaError: sample.meanAbsoluteLumaError ?? null,
      meanAbsoluteChromaError: sample.meanAbsoluteChromaError ?? null,
      edgeRetention: sample.edgeRetention ?? null,
      blockiness: sample.blockiness ?? null,
      actualImage,
      expectedImage,
    };
    state.nextAuditSampleId += 1;
    state.auditRankIndex.push({
      sampleId: frame._sampleId,
      rank: frame._rank,
    });
    state.auditFrameCandidates.push(frame);
    state.auditFrameCandidates = retainDistributedAuditFrames(
      state.auditFrameCandidates,
    );
    state.tailAuditFrames.push(frame);
    state.tailAuditFrames.sort((left, right) => left._rank - right._rank);
    if (state.tailAuditFrames.length > MAX_TAIL_AUDIT_FRAMES) {
      state.tailAuditFrames.length = MAX_TAIL_AUDIT_FRAMES;
    }
  }

  function imageDataPng(image) {
    if (!image) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  }

  function exportAuditFrame(frame, quantile) {
    if (!frame) return null;
    return {
      quantile,
      frameId: frame.frameId,
      sceneId: frame.sceneId,
      sampledAtMs: frame.sampledAtMs,
      ssim: frame.ssim,
      multiScaleSsim: frame.multiScaleSsim,
      multiScaleLevels: frame.multiScaleLevels,
      psnrDb: frame.psnrDb,
      chromaPsnrDb: frame.chromaPsnrDb,
      chromaSsim: frame.chromaSsim,
      meanAbsoluteLumaError: frame.meanAbsoluteLumaError,
      meanAbsoluteChromaError: frame.meanAbsoluteChromaError,
      edgeRetention: frame.edgeRetention,
      blockiness: frame.blockiness,
      remoteDataUrl: imageDataPng(frame.actualImage),
      expectedDataUrl: imageDataPng(frame.expectedImage),
      differencePngDataUrl: differencePng(
        frame.actualImage,
        frame.expectedImage,
      ),
    };
  }

  function resolveMetricDrain(state) {
    if (state.pendingMetricJobs !== 0) return;
    const resolvers = state.metricDrainResolvers.splice(0);
    for (const resolveDrain of resolvers) resolveDrain();
  }

  function handleMetricWorkerMessage(state, message) {
    const job = state.metricJobs.get(message.jobId);
    if (!job) return;
    state.metricJobs.delete(message.jobId);
    state.pendingMetricJobs = Math.max(0, state.pendingMetricJobs - 1);
    if (Number.isFinite(message.metricComputeMs)) {
      state.metricComputeDurations.push(message.metricComputeMs);
    }
    if (message.error) {
      state.metricWorkerErrors.push(String(message.error));
      state.skippedVisualSamples += 1;
      state.visualSamples.push({
        ...job.base,
        valid: false,
        reason: "visual-metric-worker-failed",
      });
      resolveMetricDrain(state);
      return;
    }

    const actualImage = new ImageData(
      new Uint8ClampedArray(message.actualBuffer),
      message.width,
      message.height,
    );
    const expectedImage = new ImageData(
      new Uint8ClampedArray(message.expectedBuffer),
      message.width,
      message.height,
    );
    const alignment = message.alignment ?? {};
    const sample = {
      ...job.base,
      ...message.metrics,
      alignmentValid: alignment.valid === true,
      alignmentWeightSum: alignment.weightSum ?? null,
      alignmentCurrentError: alignment.currentError ?? null,
      alignmentPreviousError: alignment.previousError ?? null,
      alignmentNextError: alignment.nextError ?? null,
      alignmentMargin: alignment.margin ?? null,
      alignmentCurrentWins:
        alignment.valid === true ? alignment.currentWins === true : null,
    };
    state.visualSamples.push(sample);
    considerAuditFrame(state, sample, actualImage, expectedImage);
    resolveMetricDrain(state);
  }

  function createMetricWorker(state) {
    const workerSource = `
      "use strict";
      const MARKER_FRAME_MODULUS = ${MARKER_FRAME_MODULUS};
      const MARKER_SEQUENCE_MODULUS = ${MARKER_SEQUENCE_MODULUS};
      const MARKER_PAYLOAD_BITS = ${MARKER_PAYLOAD_BITS};
      const MARKER_CELL_COUNT = ${MARKER_CELL_COUNT};
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const fixtureSceneId = (${fixtureSceneId.toString()});
      const seededUnit = (${seededUnit.toString()});
      const markerRects = (${markerRects.toString()});
      const markerBits = (${markerBits.toString()});
      const drawMarker = (${drawMarker.toString()});
      const renderMeetingCameraScene = (${renderMeetingCameraScene.toString()});
      const renderFixtureFrame = (${renderFixtureFrame.toString()});
      const markerPixelMask = (${markerPixelMask.toString()});
      const createVisualMetricToolkit = (${createVisualMetricToolkit.toString()});
      const metrics = createVisualMetricToolkit();
      const fixtureAssetDataUrls = ${JSON.stringify(runtime.config.fixtureAssetDataUrls)};
      const fixtureImagesPromise = Promise.all(
        fixtureAssetDataUrls.map(async (dataUrl) => {
          const response = await fetch(dataUrl);
          if (!response.ok) throw new Error("worker fixture asset could not be read");
          return createImageBitmap(await response.blob());
        }),
      );
      fixtureImagesPromise.then(
        () => self.postMessage({ type: "ready" }),
        (error) => self.postMessage({
          type: "ready-error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      self.onmessage = async (event) => {
        const message = event.data;
        const startedAt = performance.now();
        let fixtureImages;
        try {
          fixtureImages = await fixtureImagesPromise;
        } catch (error) {
          self.postMessage({
            jobId: message.jobId,
            width: message.width,
            height: message.height,
            error: error instanceof Error ? error.message : String(error),
            metricComputeMs: performance.now() - startedAt,
          });
          return;
        }
        const actualImage = new ImageData(
          new Uint8ClampedArray(message.actualBuffer),
          message.width,
          message.height,
        );
        const renderExpected = (sourceSequence, width, height) => {
          const sourceCanvas = new OffscreenCanvas(
            message.sourceWidth,
            message.sourceHeight,
          );
          renderFixtureFrame(sourceCanvas, sourceSequence, fixtureImages);
          const targetCanvas = new OffscreenCanvas(width, height);
          const targetContext = targetCanvas.getContext("2d", { alpha: false });
          targetContext.imageSmoothingEnabled = true;
          targetContext.imageSmoothingQuality = "high";
          targetContext.drawImage(sourceCanvas, 0, 0, width, height);
          return targetContext.getImageData(0, 0, width, height);
        };
        const downsampleImage = (sourceImage, width, height) => {
          const sourceCanvas = new OffscreenCanvas(
            sourceImage.width,
            sourceImage.height,
          );
          sourceCanvas.getContext("2d", { alpha: false }).putImageData(
            sourceImage,
            0,
            0,
          );
          const targetCanvas = new OffscreenCanvas(width, height);
          const targetContext = targetCanvas.getContext("2d", { alpha: false });
          targetContext.imageSmoothingEnabled = true;
          targetContext.imageSmoothingQuality = "high";
          targetContext.drawImage(sourceCanvas, 0, 0, width, height);
          return targetContext.getImageData(0, 0, width, height);
        };
        try {
          const expectedImage = renderExpected(
            message.sourceSequence,
            message.width,
            message.height,
          );
          const alignmentActual = downsampleImage(
            actualImage,
            message.alignmentWidth,
            message.alignmentHeight,
          );
          const alignmentCurrent = downsampleImage(
            expectedImage,
            message.alignmentWidth,
            message.alignmentHeight,
          );
          const alignmentPrevious = renderExpected(
            message.sourceSequence - 1,
            message.alignmentWidth,
            message.alignmentHeight,
          );
          const alignmentNext = renderExpected(
            message.sourceSequence + 1,
            message.alignmentWidth,
            message.alignmentHeight,
          );
          const providedMask = markerPixelMask(message.width, message.height);
          const visual = metrics.compareImages(
            actualImage,
            expectedImage,
            providedMask,
          );
          const alignment = metrics.motionWeightedAlignment({
            actualImage: alignmentActual,
            currentImage: alignmentCurrent,
            previousImage: alignmentPrevious,
            nextImage: alignmentNext,
            providedMask: markerPixelMask(
              message.alignmentWidth,
              message.alignmentHeight,
            ),
          });
          self.postMessage(
            {
              jobId: message.jobId,
              width: message.width,
              height: message.height,
              metrics: visual,
              alignment,
              metricComputeMs: performance.now() - startedAt,
              actualBuffer: actualImage.data.buffer,
              expectedBuffer: expectedImage.data.buffer,
            },
            [actualImage.data.buffer, expectedImage.data.buffer],
          );
        } catch (error) {
          self.postMessage({
            jobId: message.jobId,
            width: message.width,
            height: message.height,
            error: error instanceof Error ? error.message : String(error),
            metricComputeMs: performance.now() - startedAt,
          });
        }
      };
    `;
    const objectUrl = URL.createObjectURL(
      new Blob([workerSource], { type: "text/javascript" }),
    );
    try {
      const worker = new Worker(objectUrl, {
        name: "conclave-video-quality-metrics",
      });
      state.metricWorkerReadyPromise = new Promise((resolveReady, rejectReady) => {
        state.resolveMetricWorkerReady = resolveReady;
        state.rejectMetricWorkerReady = rejectReady;
      });
      worker.onmessage = (event) => {
        if (event.data?.type === "ready") {
          state.metricWorkerReady = true;
          state.resolveMetricWorkerReady?.();
          return;
        }
        if (event.data?.type === "ready-error") {
          state.rejectMetricWorkerReady?.(
            new Error(event.data.error || "visual metric worker assets failed"),
          );
          return;
        }
        handleMetricWorkerMessage(state, event.data);
      };
      worker.onerror = (event) => {
        state.metricWorkerErrors.push(
          event.message || "visual metric worker crashed",
        );
        state.skippedVisualSamples += state.pendingMetricJobs;
        state.metricJobs.clear();
        state.pendingMetricJobs = 0;
        state.rejectMetricWorkerReady?.(
          new Error(event.message || "visual metric worker crashed"),
        );
        resolveMetricDrain(state);
      };
      return worker;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function waitForMetricDrain(state) {
    if (state.pendingMetricJobs === 0) return;
    await new Promise((resolveDrain) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolveDrain();
      };
      const timeoutId = setTimeout(() => {
        const pending = state.pendingMetricJobs;
        if (pending > 0) {
          state.metricWorkerErrors.push(
            `timed out waiting for ${pending} visual metric job(s)`,
          );
          state.skippedVisualSamples += pending;
          state.metricJobs.clear();
          state.pendingMetricJobs = 0;
        }
        finish();
      }, 10_000);
      state.metricDrainResolvers.push(finish);
    });
  }

  function captureVisualSample(
    state,
    marker,
    callbackAtMs,
    metadata,
    snapshot,
  ) {
    const dispatchStartedAt = nowPerformanceMs();
    const video = state.video;
    const decodedWidth = video.videoWidth;
    const decodedHeight = video.videoHeight;
    const analysisWidth = Math.max(
      1,
      Math.min(decodedWidth, MAX_ANALYSIS_WIDTH),
    );
    const analysisHeight = Math.max(
      1,
      Math.round((decodedHeight / decodedWidth) * analysisWidth),
    );
    const alignmentWidth = Math.max(1, Math.min(analysisWidth, 320));
    const alignmentHeight = Math.max(
      1,
      Math.round((decodedHeight / decodedWidth) * alignmentWidth),
    );
    if (
      state.actualCanvas.width !== analysisWidth ||
      state.actualCanvas.height !== analysisHeight
    ) {
      state.actualCanvas.width = analysisWidth;
      state.actualCanvas.height = analysisHeight;
    }
    const actualContext = state.actualCanvas.getContext("2d", { alpha: false });
    actualContext.imageSmoothingEnabled = true;
    actualContext.imageSmoothingQuality = "high";
    try {
      actualContext.drawImage(snapshot, 0, 0, analysisWidth, analysisHeight);
    } catch {
      state.skippedVisualSamples += 1;
      state.metricDispatchMainThreadDurations.push(
        Math.max(0, nowPerformanceMs() - dispatchStartedAt),
      );
      return;
    }

    const base = {
      measurementWindowId: state.measurementWindow?.id ?? null,
      valid: marker.valid,
      markerSequence: marker.markerSequence,
      sourceSequence: marker.sourceSequence,
      markerGeneration: marker.markerGeneration,
      sequenceAmbiguous: marker.sequenceAmbiguous === true,
      frameId: marker.frameId,
      sceneId: marker.valid ? fixtureSceneId(marker.frameId) : null,
      markerConfidence: round(marker.confidence, 6),
      markerCopies: marker.copies,
      sampledAtMs: round(callbackAtMs - state.startedPerformanceAt, 2),
      mediaTime: finiteNumber(metadata?.mediaTime, null),
      presentedFrames: finiteNumber(metadata?.presentedFrames, null),
      decodedWidth,
      decodedHeight,
      analysisWidth,
      analysisHeight,
    };
    const actualImage = actualContext.getImageData(
      0,
      0,
      analysisWidth,
      analysisHeight,
    );
    if (!marker.valid) {
      const sample = { ...base, reason: "frame-marker-decode-failed" };
      state.visualSamples.push(sample);
      state.metricDispatchMainThreadDurations.push(
        Math.max(0, nowPerformanceMs() - dispatchStartedAt),
      );
      return;
    }

    if (state.pendingMetricJobs >= MAX_PENDING_METRIC_JOBS) {
      state.skippedVisualSamples += 1;
      state.maximumQueuedMetricJobDepth = Math.max(
        state.maximumQueuedMetricJobDepth,
        state.pendingMetricJobs,
      );
      state.visualSamples.push({
        ...base,
        valid: false,
        reason: "visual-metric-worker-backpressure",
      });
      state.metricDispatchMainThreadDurations.push(
        Math.max(0, nowPerformanceMs() - dispatchStartedAt),
      );
      return;
    }

    if (!state.metricWorker) {
      state.skippedVisualSamples += 1;
      state.metricWorkerErrors.push("visual metric worker is unavailable");
      state.metricDispatchMainThreadDurations.push(
        Math.max(0, nowPerformanceMs() - dispatchStartedAt),
      );
      return;
    }
    const jobId = state.nextMetricJobId;
    state.nextMetricJobId += 1;
    state.metricJobs.set(jobId, { base });
    state.pendingMetricJobs += 1;
    state.maximumQueuedMetricJobDepth = Math.max(
      state.maximumQueuedMetricJobDepth,
      Math.max(0, state.pendingMetricJobs - 1),
    );
    try {
      const message = {
        jobId,
        width: analysisWidth,
        height: analysisHeight,
        alignmentWidth,
        alignmentHeight,
        frameId: marker.frameId,
        sourceSequence: marker.sourceSequence,
        sourceWidth: state.sourceFixture.width,
        sourceHeight: state.sourceFixture.height,
        actualBuffer: actualImage.data.buffer,
      };
      state.metricWorker.postMessage(message, [
        message.actualBuffer,
      ]);
    } catch (error) {
      state.metricJobs.delete(jobId);
      state.pendingMetricJobs = Math.max(0, state.pendingMetricJobs - 1);
      state.skippedVisualSamples += 1;
      state.metricWorkerErrors.push(
        error instanceof Error ? error.message : String(error),
      );
      resolveMetricDrain(state);
    }
    state.metricDispatchMainThreadDurations.push(
      Math.max(0, nowPerformanceMs() - dispatchStartedAt),
    );
  }

  function updateMarkerCadence(state, marker, callbackAtMs) {
    if (!marker.valid) return;
    state.validMarkerCallbacks += 1;
    if (state.lastMarkerId === null) {
      state.lastMarkerId = marker.sourceSequence;
      state.lastMarkerAdvanceAt = callbackAtMs;
      state.presentedFramesSinceLastMarker = 0;
      state.duplicateCallbacksSinceMarkerAdvance = 0;
      return;
    }
    const delta = marker.sourceSequence - state.lastMarkerId;
    if (delta === 0) {
      state.markerDuplicateCallbacks += 1;
      state.duplicateCallbacksSinceMarkerAdvance += 1;
      return;
    }
    const advanceGap = callbackAtMs - state.lastMarkerAdvanceAt;
    const presentedFramesSinceLastMarker = Math.max(
      1,
      state.presentedFramesSinceLastMarker,
    );
    // A busy sampler can miss rVFC callbacks even while the compositor keeps
    // presenting frames. Normalize that callback gap unless we directly
    // observed the same source marker being presented repeatedly.
    const visibleAdvanceGap =
      state.duplicateCallbacksSinceMarkerAdvance > 0
        ? advanceGap
        : advanceGap / presentedFramesSinceLastMarker;
    if (visibleAdvanceGap > state.freezeThresholdMs) {
      state.freezeCount += 1;
      state.freezeDurationMs += Math.max(
        0,
        visibleAdvanceGap - state.expectedFrameIntervalMs,
      );
      state.longestMarkerFreezeMs = Math.max(
        state.longestMarkerFreezeMs,
        visibleAdvanceGap,
      );
    }
    state.markerDroppedFrames += Math.max(
      0,
      delta - presentedFramesSinceLastMarker,
    );
    state.markerAdvanceCount += 1;
    state.markerAdvancedFrames += delta;
    state.lastMarkerId = marker.sourceSequence;
    state.lastMarkerAdvanceAt = callbackAtMs;
    state.presentedFramesSinceLastMarker = 0;
    state.duplicateCallbacksSinceMarkerAdvance = 0;
  }

  function handleVideoFrame(state, callbackAtMs, metadata) {
    const expectedDisplayTimeMs = finiteNumber(
      metadata?.expectedDisplayTime,
      null,
    );
    const presentedAtMs = expectedDisplayTimeMs ?? callbackAtMs;
    const callbackAtEpochMs = performanceEpochMs(callbackAtMs);
    const presentedAtEpochMs = performanceEpochMs(presentedAtMs);
    if (
      state.stopped ||
      state.windowClosed ||
      !state.measurementWindow ||
      presentedAtEpochMs < state.measurementWindow.startedAtEpochMs ||
      presentedAtEpochMs > state.measurementWindow.endedAtEpochMs
    ) {
      return;
    }
    const frameObserverStartedAt = nowPerformanceMs();
    state.callbackCount += 1;
    const presentedFrames = finiteNumber(metadata?.presentedFrames, null);
    const previousPresentedFrames = state.lastPresentedFrames;
    const presentedFrameDelta = calculatePresentedFrameDelta(
      presentedFrames,
      previousPresentedFrames,
    );
    if (presentedFrames !== null) {
      state.hasPresentedFramesMetadata = true;
      state.lastPresentedFrames = presentedFrames;
      if (previousPresentedFrames !== null) {
        state.missedVideoFrameCallbacks += Math.max(
          0,
          presentedFrameDelta - 1,
        );
      }
    } else {
      state.lastPresentedFrames = null;
    }
    state.presentedFrameCount += presentedFrameDelta;
    state.presentedFramesSinceLastMarker += presentedFrameDelta;
    if (state.lastCallbackAt !== null) {
      const rawGap = Math.max(0, callbackAtMs - state.lastCallbackAt);
      state.rawCallbackGaps.push(rawGap);
      state.longestRawCallbackGapMs = Math.max(
        state.longestRawCallbackGapMs,
        rawGap,
      );
    }
    if (state.lastPresentedAt !== null) {
      const presentationGap = Math.max(
        0,
        presentedAtMs - state.lastPresentedAt,
      );
      const visibleGap = presentationGap / presentedFrameDelta;
      state.frameGaps.push(visibleGap);
      state.longestGapMs = Math.max(state.longestGapMs, visibleGap);
    }
    state.lastCallbackAt = callbackAtMs;
    state.lastPresentedAt = presentedAtMs;

    const shouldCaptureVisual =
      state.mode === "visual" && callbackAtMs >= state.nextVisualSampleAt;
    const snapshotStartedAt = shouldCaptureVisual ? nowPerformanceMs() : null;
    const snapshot = shouldCaptureVisual
      ? captureAtomicVideoSnapshot(state, state.video)
      : null;
    const decodedMarker = snapshot
      ? decodeMarkerFromSource(
          state,
          snapshot,
          snapshot.width,
          snapshot.height,
      )
      : decodeMarkerFromVideo(state, state.video);
    const marker = resolveSamplerMarker(state, decodedMarker, presentedAtMs);
    state.presentationObservations.push({
      measurementWindowId: state.measurementWindow?.id ?? null,
      markerValid: marker.valid === true,
      markerSequence: marker.markerSequence ?? null,
      sourceSequence: marker.sourceSequence ?? null,
      markerGeneration: marker.markerGeneration ?? null,
      sequenceAmbiguous: marker.sequenceAmbiguous === true,
      frameId: marker.frameId ?? null,
      expectedDisplayTimeAvailable: expectedDisplayTimeMs !== null,
      presentedAtEpochMs:
        expectedDisplayTimeMs === null ? null : presentedAtEpochMs,
      callbackAtEpochMs,
      mediaTime: finiteNumber(metadata?.mediaTime, null),
      presentedFrames,
    });
    if (snapshotStartedAt !== null) {
      state.snapshotMainThreadDurations.push(
        Math.max(0, nowPerformanceMs() - snapshotStartedAt),
      );
    }
    updateMarkerCadence(state, marker, presentedAtMs);
    if (shouldCaptureVisual) {
      state.visualSampleAttempts += 1;
      const elapsedScheduleSlots =
        Math.floor(
          Math.max(0, callbackAtMs - state.nextVisualSampleAt) /
            state.sampleIntervalMs,
        ) + 1;
      state.missedVisualSampleSlots += Math.max(
        0,
        elapsedScheduleSlots - 1,
      );
      // Preserve one cadence anchored at sampler start. Scheduling relative to
      // this callback would accumulate normal rVFC jitter and systematically
      // leave a larger unmeasured fixture phase near the end of the run.
      state.nextVisualSampleAt +=
        elapsedScheduleSlots * state.sampleIntervalMs;
      if (snapshot) {
        captureVisualSample(state, marker, callbackAtMs, metadata, snapshot);
      } else {
        state.skippedVisualSamples += 1;
      }
    }
    state.frameObserverDurations.push(
      Math.max(0, nowPerformanceMs() - frameObserverStartedAt),
    );
  }

  function cancelFrameCallbacks(state) {
    state.videoGeneration += 1;
    if (
      state.frameCallbackId !== null &&
      typeof state.video?.cancelVideoFrameCallback === "function"
    ) {
      try {
        state.video.cancelVideoFrameCallback(state.frameCallbackId);
      } catch {}
    }
    state.frameCallbackId = null;
    if (state.fallbackFrameTimer !== null) {
      clearInterval(state.fallbackFrameTimer);
      state.fallbackFrameTimer = null;
    }
  }

  function scheduleFrameCallbacks(state) {
    cancelFrameCallbacks(state);
    const generation = state.videoGeneration;
    const video = state.video;
    if (typeof video.requestVideoFrameCallback === "function") {
      const next = () => {
        if (
          state.stopped ||
          state.windowClosed ||
          generation !== state.videoGeneration
        ) return;
        state.frameCallbackId = video.requestVideoFrameCallback((now, metadata) => {
          if (
            state.stopped ||
            state.windowClosed ||
            generation !== state.videoGeneration
          ) return;
          state.frameCallbackId = null;
          // Arm the next one-shot callback before visual analysis. Otherwise a
          // synchronous SSIM sample creates an avoidable registration gap and
          // headless compositor cadence becomes noisier than the media path.
          next();
          handleVideoFrame(state, now, metadata);
        });
      };
      next();
      return;
    }

    let lastCurrentTime = -1;
    state.fallbackFrameTimer = setInterval(() => {
      if (
        state.stopped ||
        state.windowClosed ||
        generation !== state.videoGeneration
      ) return;
      if (video.currentTime === lastCurrentTime) return;
      lastCurrentTime = video.currentTime;
      handleVideoFrame(state, nowPerformanceMs(), {
        mediaTime: video.currentTime,
        presentedFrames: null,
      });
    }, Math.max(16, state.expectedFrameIntervalMs * 0.5));
  }

  function switchSampledVideo(state, video) {
    if (!video || state.video === video) return;
    cancelFrameCallbacks(state);
    state.video = video;
    state.videoSwitches += 1;
    state.lastPresentedFrames = null;
    scheduleFrameCallbacks(state);
  }

  async function observeBoundMediaPath(
    state,
    tick = null,
    snapshotPromise = null,
  ) {
    if (
      !state.mediaPathBinding ||
      !state.measurementWindow ||
      state.windowClosed ||
      nowEpochMs() < state.measurementWindow.startedAtEpochMs ||
      nowEpochMs() > state.measurementWindow.endedAtEpochMs
    ) return null;
    if (state.pathObservationPromise) return state.pathObservationPromise;
    const observationStartedAt = nowPerformanceMs();
    state.pathObservationPromise = (async () => {
      const binding = state.mediaPathBinding;
      const snapshot = snapshotPromise
        ? await snapshotPromise
        : await collectPeerConnectionStats();
      const connection = (snapshot.peerConnections ?? []).find(
        (candidate) => String(candidate.id ?? "") === binding.connectionId,
      );
      const stat = (connection?.stats ?? []).find(
        (candidate) =>
          candidate.type === "inbound-rtp" &&
          String(candidate.id ?? "") === binding.statId &&
          String(candidate.ssrc ?? "") === binding.ssrc &&
          String(candidate.trackIdentifier ?? "") === binding.consumerId,
      );
      const codec = stat?.codecId
        ? (connection?.stats ?? []).find(
            (candidate) => candidate.id === stat.codecId,
          )
        : null;
      const debug = globalThis.__conclaveGetMeetVideoDebug?.();
      const consumer = (debug?.adaptiveConsumers?.entries ?? []).find(
        (candidate) => candidate?.consumerId === binding.consumerId,
      );
      const video = remoteVideoCandidates(binding.consumerId)[0]?.video ?? null;
      const videoTrack =
        video?.srcObject instanceof MediaStream
          ? video.srcObject
              .getVideoTracks()
              .find((track) => track.id === binding.consumerId) ?? null
          : null;
      const reasons = [];
      if (!connection) reasons.push("bound peer connection disappeared");
      if (debug?.connectionState !== "joined") {
        reasons.push("viewer left the joined state");
      }
      if (
        connection &&
        !["connected"].includes(connection.connectionState)
      ) {
        reasons.push("bound peer connection was not connected");
      }
      if (
        connection &&
        !["connected", "completed"].includes(connection.iceConnectionState)
      ) {
        reasons.push("bound ICE connection was not connected");
      }
      if (connection && connection.signalingState !== "stable") {
        reasons.push("bound peer connection signaling was not stable");
      }
      if (!stat) reasons.push("bound inbound RTP stat disappeared");
      if (
        stat &&
        String(codec?.mimeType ?? stat.codecMimeType ?? "").toLowerCase() !==
          binding.codecMimeType
      ) {
        reasons.push("bound inbound codec changed");
      }
      if (binding.codecId && stat?.codecId !== binding.codecId) {
        reasons.push("bound inbound codec id changed");
      }
      if (
        Number.isInteger(binding.codecPayloadType) &&
        codec?.payloadType !== binding.codecPayloadType
      ) {
        reasons.push("bound inbound codec payload type changed");
      }
      if (
        typeof binding.codecFmtpLine === "string" &&
        (codec?.sdpFmtpLine ?? null) !== binding.codecFmtpLine
      ) {
        reasons.push("bound inbound codec fmtp changed");
      }
      if (
        typeof binding.scalabilityMode === "string" &&
        (stat?.scalabilityMode ?? null) !== binding.scalabilityMode
      ) {
        reasons.push("bound inbound scalability mode changed");
      }
      if (
        typeof binding.decoderImplementation === "string" &&
        (stat?.decoderImplementation ?? null) !== binding.decoderImplementation
      ) {
        reasons.push("bound decoder implementation changed");
      }
      if (
        typeof binding.powerEfficientDecoder === "boolean" &&
        stat?.powerEfficientDecoder !== binding.powerEfficientDecoder
      ) {
        reasons.push("bound decoder power-efficiency flag changed");
      }
      if (!consumer || consumer.producerId !== binding.producerId) {
        reasons.push("bound producer/consumer relationship changed");
      }
      if (
        Number.isInteger(binding.spatialLayer) &&
        consumer?.currentLayers?.spatialLayer !== binding.spatialLayer
      ) {
        reasons.push("bound spatial layer changed");
      }
      if (
        Number.isInteger(binding.temporalLayer) &&
        consumer?.currentLayers?.temporalLayer !== binding.temporalLayer
      ) {
        reasons.push("bound temporal layer changed");
      }
      if (!video) reasons.push("bound rendered track disappeared");
      if (!videoTrack || videoTrack.readyState !== "live") {
        reasons.push("bound rendered video track was not live");
      }
      if (videoTrack?.muted === true) {
        reasons.push("bound rendered video track was muted");
      }
      if (
        stat &&
        Number.isInteger(binding.frameWidth) &&
        finiteNumber(stat.frameWidth, 0) !== binding.frameWidth
      ) {
        reasons.push("bound decoded width changed");
      }
      if (
        stat &&
        Number.isInteger(binding.frameHeight) &&
        finiteNumber(stat.frameHeight, 0) !== binding.frameHeight
      ) {
        reasons.push("bound decoded height changed");
      }
      const capturedAtEpochMs = finiteNumber(snapshot?.capturedAt, nowEpochMs());
      if (
        capturedAtEpochMs < state.measurementWindow.startedAtEpochMs ||
        capturedAtEpochMs > state.measurementWindow.endedAtEpochMs
      ) {
        return null;
      }
      const observation = {
        measurementWindowId: state.measurementWindow.id,
        scheduledAtEpochMs: tick?.scheduledAtEpochMs ?? null,
        observationPhase: tick?.phase ?? null,
        tickInvokedAtEpochMs: tick?.invokedAtEpochMs ?? null,
        tickLatenessMs: tick?.tickLatenessMs ?? null,
        capturedAtEpochMs,
        sampledAtMs: round(
          capturedAtEpochMs - state.measurementWindow.startedAtEpochMs,
          2,
        ),
        matched: reasons.length === 0,
        reasons,
        appConnectionState: debug?.connectionState ?? null,
        peerConnectionState: connection?.connectionState ?? null,
        iceConnectionState: connection?.iceConnectionState ?? null,
        signalingState: connection?.signalingState ?? null,
        videoTrackReadyState: videoTrack?.readyState ?? null,
        videoTrackMuted: videoTrack?.muted ?? null,
        connectionId: connection?.id ?? null,
        statId: stat?.id ?? null,
        ssrc: stat?.ssrc ?? null,
        consumerId: stat?.trackIdentifier ?? null,
        producerId: consumer?.producerId ?? null,
        codecMimeType: codec?.mimeType ?? stat?.codecMimeType ?? null,
        codecId: stat?.codecId ?? null,
        codecPayloadType: codec?.payloadType ?? null,
        codecFmtpLine: codec?.sdpFmtpLine ?? null,
        scalabilityMode: stat?.scalabilityMode ?? null,
        decoderImplementation: stat?.decoderImplementation ?? null,
        powerEfficientDecoder: stat?.powerEfficientDecoder ?? null,
        frameWidth: stat?.frameWidth ?? null,
        frameHeight: stat?.frameHeight ?? null,
        framesDecoded: stat?.framesDecoded ?? null,
        framesDropped: stat?.framesDropped ?? null,
        keyFramesDecoded: stat?.keyFramesDecoded ?? null,
        bytesReceived: stat?.bytesReceived ?? null,
        packetsReceived: stat?.packetsReceived ?? null,
        packetsLost: stat?.packetsLost ?? null,
        jitter: stat?.jitter ?? null,
        jitterBufferDelay: stat?.jitterBufferDelay ?? null,
        jitterBufferTargetDelay: stat?.jitterBufferTargetDelay ?? null,
        jitterBufferMinimumDelay: stat?.jitterBufferMinimumDelay ?? null,
        jitterBufferEmittedCount: stat?.jitterBufferEmittedCount ?? null,
        totalDecodeTime: stat?.totalDecodeTime ?? null,
        qpSum: stat?.qpSum ?? null,
        freezeCount: stat?.freezeCount ?? null,
        totalFreezesDuration: stat?.totalFreezesDuration ?? null,
        requestedJitterBufferTargetMs:
          consumer?.requestedJitterBufferTargetMs ?? null,
        observedJitterBufferTargetMs: consumer?.observedTargetMs ?? null,
        jitterBufferTargetStatus:
          consumer?.jitterBufferTargetStatus ?? null,
        spatialLayer: consumer?.currentLayers?.spatialLayer ?? null,
        temporalLayer: consumer?.currentLayers?.temporalLayer ?? null,
        dynamicNetworkRaw: globalThis.__conclaveQualityDynamicNetworkHint
          ? {
              capturedAtEpochMs,
              debug,
              hintRuntime:
                globalThis.__conclaveQualityDynamicNetworkHint.snapshot?.() ??
                null,
              rtc: snapshot,
            }
          : null,
      };
      const observerWorkMs = Math.max(
        0,
        nowPerformanceMs() - observationStartedAt,
      );
      observation.observerWorkMs = round(observerWorkMs, 3);
      state.pathObservationDurations.push(observerWorkMs);
      state.pathObservations.push(observation);
      if (!observation.matched) state.pathBindingViolations.push(observation);
      return observation;
    })()
      .catch((error) => {
        state.pathObservationCaptureErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        return null;
      })
      .finally(() => {
        state.pathObservationPromise = null;
      });
    return state.pathObservationPromise;
  }

  function runBoundMediaPathObservationTick(
    state,
    target,
    snapshotPromise = null,
  ) {
    const invokedAtEpochMs = nowEpochMs();
    state.pathObservationInvokedIndexes.add(target.index);
    const tickLatenessMs = Math.max(
      0,
      invokedAtEpochMs - target.scheduledAtEpochMs,
    );
    const tick = {
      ...target,
      invokedAtEpochMs,
      tickLatenessMs,
      status: "started",
    };
    state.pathObservationTickRecords.push(tick);
    if (tickLatenessMs > MAX_PATH_TICK_LATENESS_MS) {
      state.pathObservationLateTickCount += 1;
      state.pathObservationSkippedTickCount += 1;
      tick.status = "late";
    }
    if (state.stopped || state.windowClosed) {
      state.pathObservationSkippedTickCount += 1;
      tick.status = "closed";
      return null;
    }
    if (state.pathObservationPromise) {
      state.pathObservationOverlapTickCount += 1;
      state.pathObservationSkippedTickCount += 1;
      tick.status = "skipped-overlap";
      return null;
    }
    const resolvedSnapshotPromise =
      target.phase === "terminal"
        ? collectTerminalPeerConnectionStats(state)
        : snapshotPromise;
    const promise = observeBoundMediaPath(
      state,
      tick,
      resolvedSnapshotPromise,
    ).then((observation) => {
      if (observation && tick.status === "started") tick.status = "completed";
      if (!observation) {
        tick.status = "empty";
        state.pathObservationSkippedTickCount += 1;
      }
      return observation;
    });
    if (target.phase === "start") {
      state.pathObservationFirstPromise = promise;
      state.pathObserverStartedAtEpochMs = invokedAtEpochMs;
    }
    if (target.phase === "terminal") {
      state.pathObservationTerminalPromise = promise;
      state.pathObserverTerminalInvokedAtEpochMs = invokedAtEpochMs;
    }
    return promise;
  }

  function armBoundMediaPathObservationSchedule(
    state,
    firstSnapshotPromise,
  ) {
    const targets = buildAlignedWindowObservationTargets({
      measurementWindow: state.measurementWindow,
      observationIntervalMs: PATH_OBSERVATION_INTERVAL_MS,
      terminalLeadMs: PATH_TERMINAL_LEAD_MS,
    });
    state.pathObservationTargets = targets;
    for (const target of targets.slice(1)) {
      let timer = null;
      timer = setTimeout(() => {
        state.pathObservationTimers.delete(timer);
        void runBoundMediaPathObservationTick(state, target);
      }, Math.max(0, target.scheduledAtEpochMs - nowEpochMs()));
      state.pathObservationTimers.add(timer);
    }
    return runBoundMediaPathObservationTick(
      state,
      targets[0],
      firstSnapshotPromise,
    );
  }

  async function armSampler({
    mode = "visual",
    sampleIntervalMs = 450,
    sourceFixture = null,
    targetTrackId = null,
    mediaPathBinding = null,
  } = {}) {
    if (!["visual", "telemetry"].includes(mode)) {
      return { ok: false, reason: "invalid-sampler-mode", mode };
    }
    if (runtime.sampler && !runtime.sampler.stopped) {
      return {
        ok: true,
        alreadyArmed: true,
        armed: true,
        startedAt: runtime.sampler.startedAt,
        mode: runtime.sampler.mode,
        video: {
          width: runtime.sampler.video.videoWidth,
          height: runtime.sampler.video.videoHeight,
        },
        sourceFixture: runtime.sampler.sourceFixture,
        targetTrackId: runtime.sampler.targetTrackId,
      };
    }

    const candidate = remoteVideoCandidates(targetTrackId)[0]?.video ?? null;
    if (!candidate) {
      return {
        ok: false,
        reason: "remote-webcam-video-not-ready",
        targetTrackId,
        candidateCount: document.querySelectorAll(
          'video[data-meet-tile-video="true"][data-meet-video-stream-type="webcam"]',
        ).length,
      };
    }

    const markerCanvas = document.createElement("canvas");
    markerCanvas.width = MARKER_ANALYSIS_WIDTH;
    markerCanvas.height = MARKER_ROW_HEIGHT * MARKER_REPETITIONS;
    const localFixtureState = getFixtureState();
    const expectedSourceFixture = sourceFixture
      ? {
          width: clamp(
            Math.round(finiteNumber(sourceFixture.width, runtime.config.width)),
            MIN_FIXTURE_WIDTH,
            runtime.config.width,
          ),
          height: clamp(
            Math.round(finiteNumber(sourceFixture.height, runtime.config.height)),
            MIN_FIXTURE_HEIGHT,
            runtime.config.height,
          ),
          fps: clamp(
            Math.round(finiteNumber(sourceFixture.fps, runtime.config.targetFps)),
            MIN_FIXTURE_FRAME_RATE,
            runtime.config.targetFps,
          ),
          sourceGeneration: Number.isInteger(sourceFixture.sourceGeneration)
            ? sourceFixture.sourceGeneration
            : null,
          markerSequenceModulus: Number.isInteger(
            sourceFixture.markerSequenceModulus,
          )
            ? sourceFixture.markerSequenceModulus
            : null,
          active: sourceFixture.active === true,
        }
      : localFixtureState;
    const expectedFps = Math.max(
      1,
      finiteNumber(expectedSourceFixture.fps, runtime.config.targetFps),
    );
    const state = {
      mode,
      stopped: false,
      armed: false,
      armedAtEpochMs: null,
      windowClosed: false,
      windowEndTimer: null,
      measurementWindow: null,
      beganAtEpochMs: null,
      endedAtEpochMs: null,
      startedAt: null,
      startedPerformanceAt: null,
      startedPerformanceEpochMs: null,
      sampleIntervalMs: clamp(Math.round(sampleIntervalMs), 100, 5_000),
      sourceFixture: { ...expectedSourceFixture },
      targetTrackId,
      mediaPathBinding: mediaPathBinding ? { ...mediaPathBinding } : null,
      expectedFrameIntervalMs: 1000 / expectedFps,
      freezeThresholdMs: Math.max(250, (1000 / expectedFps) * 5),
      video: candidate,
      videoGeneration: 0,
      videoSwitches: 0,
      markerCanvas,
      markerContext: markerCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      }),
      actualCanvas:
        mode === "visual" ? document.createElement("canvas") : null,
      sampleSnapshotCanvas:
        mode === "visual" ? document.createElement("canvas") : null,
      visualSamples: [],
      visualSampleAttempts: 0,
      skippedVisualSamples: 0,
      snapshotMainThreadDurations: [],
      metricDispatchMainThreadDurations: [],
      metricComputeDurations: [],
      metricWorker: null,
      metricWorkerReady: false,
      metricWorkerReadyPromise: null,
      resolveMetricWorkerReady: null,
      rejectMetricWorkerReady: null,
      metricWorkerErrors: [],
      metricJobs: new Map(),
      pendingMetricJobs: 0,
      maximumQueuedMetricJobDepth: 0,
      nextMetricJobId: 1,
      metricDrainResolvers: [],
      auditFrameCandidates: [],
      tailAuditFrames: [],
      auditRankIndex: [],
      nextAuditSampleId: 1,
      callbackCount: 0,
      presentedFrameCount: 0,
      hasPresentedFramesMetadata: false,
      missedVideoFrameCallbacks: 0,
      lastPresentedFrames: null,
      validMarkerCallbacks: 0,
      markerAdvanceCount: 0,
      markerAdvancedFrames: 0,
      markerDroppedFrames: 0,
      markerDuplicateCallbacks: 0,
      markerSequenceAmbiguityCount: 0,
      duplicateCallbacksSinceMarkerAdvance: 0,
      presentedFramesSinceLastMarker: 0,
      lastMarkerId: null,
      lastDecodedSourceSequence: null,
      lastMarkerAdvanceAt: null,
      lastCallbackAt: null,
      lastPresentedAt: null,
      frameGaps: [],
      rawCallbackGaps: [],
      longestGapMs: 0,
      longestRawCallbackGapMs: 0,
      freezeCount: 0,
      freezeDurationMs: 0,
      longestMarkerFreezeMs: 0,
      nextVisualSampleAt: 0,
      missedVisualSampleSlots: 0,
      frameCallbackId: null,
      fallbackFrameTimer: null,
      videoWatcherTimer: null,
      statsStart: null,
      statsStartPromise: null,
      statsEndPromise: null,
      statsEndError: null,
      stopPromise: null,
      pathObservations: [],
      pathBindingViolations: [],
      pathObservationPromise: null,
      pathObservationFirstPromise: null,
      pathObservationTerminalPromise: null,
      pathObservationTargets: [],
      pathObservationTimers: new Set(),
      pathObservationInvokedIndexes: new Set(),
      pathObservationTickRecords: [],
      pathObservationSkippedTickCount: 0,
      pathObservationLateTickCount: 0,
      pathObservationOverlapTickCount: 0,
      pathObservationCaptureErrors: [],
      pathObserverStartedAtEpochMs: null,
      pathObserverTerminalInvokedAtEpochMs: null,
      pathObservationDurations: [],
      frameObserverDurations: [],
      presentationObservations: [],
    };
    runtime.sampler = state;
    if (mode === "visual") {
      try {
        state.metricWorker = createMetricWorker(state);
        await Promise.race([
          state.metricWorkerReadyPromise,
          new Promise((_, rejectReady) => {
            setTimeout(
              () => rejectReady(new Error("visual metric worker startup timed out")),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        state.metricWorker?.terminate();
        runtime.sampler = null;
        return {
          ok: false,
          reason: "visual-metric-worker-unavailable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const preflightStats = await collectPeerConnectionStats();
    const preflightConnection = (preflightStats?.peerConnections ?? []).find(
      (connection) => connection?.id === state.mediaPathBinding?.connectionId,
    );
    const preflightInbound = (preflightConnection?.stats ?? []).find(
      (stat) =>
        stat?.id === state.mediaPathBinding?.statId &&
        stat?.type === "inbound-rtp" &&
        String(stat?.ssrc ?? "") === String(state.mediaPathBinding?.ssrc ?? ""),
    );
    const preflightCodec = preflightInbound?.codecId
      ? (preflightConnection?.stats ?? []).find(
          (stat) => stat?.id === preflightInbound.codecId && stat?.type === "codec",
        )
      : null;
    if (state.mediaPathBinding && preflightInbound) {
      state.mediaPathBinding = {
        ...state.mediaPathBinding,
        codecId: preflightInbound.codecId ?? null,
        codecPayloadType: Number.isInteger(preflightCodec?.payloadType)
          ? preflightCodec.payloadType
          : null,
        codecFmtpLine:
          typeof preflightCodec?.sdpFmtpLine === "string"
            ? preflightCodec.sdpFmtpLine
            : null,
        scalabilityMode:
          typeof preflightInbound.scalabilityMode === "string"
            ? preflightInbound.scalabilityMode
            : null,
        decoderImplementation:
          typeof preflightInbound.decoderImplementation === "string"
            ? preflightInbound.decoderImplementation
            : null,
        powerEfficientDecoder:
          typeof preflightInbound.powerEfficientDecoder === "boolean"
            ? preflightInbound.powerEfficientDecoder
            : null,
      };
    }
    state.armed = true;
    state.armedAtEpochMs = nowEpochMs();

    return {
      ok: true,
      alreadyArmed: false,
      armed: true,
      mode,
      armedAtEpochMs: state.armedAtEpochMs,
      sampleIntervalMs: state.sampleIntervalMs,
      targetFps: expectedFps,
      sourceFixture: state.sourceFixture,
      targetTrackId: state.targetTrackId,
      mediaPathBinding: state.mediaPathBinding,
      video: {
        width: candidate.videoWidth,
        height: candidate.videoHeight,
        readyState: candidate.readyState,
      },
      peerConnectionCount: runtime.peerConnections.length,
      usesRequestVideoFrameCallback:
        typeof candidate.requestVideoFrameCallback === "function",
    };
  }

  function finalizeCadence(state, stoppedAtPerformance) {
    let terminalSilenceMs = 0;
    const lastPresentedAt = state.lastPresentedAt ?? state.lastCallbackAt;
    if (lastPresentedAt !== null) {
      terminalSilenceMs = Math.max(
        0,
        stoppedAtPerformance - lastPresentedAt,
      );
      // The stop time right-censors the next frame. Only treat the partial
      // terminal interval as a visible gap once it independently crosses the
      // same freeze threshold used for completed frame intervals.
      if (terminalSilenceMs > state.freezeThresholdMs) {
        state.frameGaps.push(terminalSilenceMs);
        state.longestGapMs = Math.max(
          state.longestGapMs,
          terminalSilenceMs,
        );
      }
    }
    if (state.lastMarkerAdvanceAt !== null) {
      const terminalFreeze = stoppedAtPerformance - state.lastMarkerAdvanceAt;
      if (terminalFreeze > state.freezeThresholdMs) {
        state.freezeCount += 1;
        state.freezeDurationMs += Math.max(
          0,
          terminalFreeze - state.expectedFrameIntervalMs,
        );
        state.longestMarkerFreezeMs = Math.max(
          state.longestMarkerFreezeMs,
          terminalFreeze,
        );
      }
    } else if (lastPresentedAt !== null) {
      const terminalFreeze = stoppedAtPerformance - lastPresentedAt;
      if (terminalFreeze > state.freezeThresholdMs) {
        state.freezeCount += 1;
        state.freezeDurationMs += Math.max(
          0,
          terminalFreeze - state.expectedFrameIntervalMs,
        );
      }
    }

    return {
      callbackCount: state.callbackCount,
      presentedFrameCount: state.hasPresentedFramesMetadata
        ? state.presentedFrameCount
        : null,
      missedVideoFrameCallbacks: state.hasPresentedFramesMetadata
        ? state.missedVideoFrameCallbacks
        : null,
      videoFrameCallbackCoverage:
        state.hasPresentedFramesMetadata && state.presentedFrameCount > 0
          ? round(state.callbackCount / state.presentedFrameCount, 6)
          : null,
      validMarkerCallbacks: state.validMarkerCallbacks,
      markerDecodeRate:
        state.callbackCount > 0
          ? round(state.validMarkerCallbacks / state.callbackCount, 6)
          : 0,
      markerAdvanceCount: state.markerAdvanceCount,
      markerAdvancedFrames: state.markerAdvancedFrames,
      markerDroppedFrames: state.markerDroppedFrames,
      markerDuplicateCallbacks: state.markerDuplicateCallbacks,
      markerSequenceAmbiguityCount: state.markerSequenceAmbiguityCount,
      freezeCount: state.freezeCount,
      freezeDurationMs: round(state.freezeDurationMs, 2),
      longestMarkerFreezeMs: round(state.longestMarkerFreezeMs, 2),
      longestGapMs: round(state.longestGapMs, 2),
      p95FrameGapMs: round(
        nearestRankPercentile(state.frameGaps, 0.95),
        2,
      ),
      longestRawCallbackGapMs: round(state.longestRawCallbackGapMs, 2),
      p95RawCallbackGapMs: round(
        percentile(state.rawCallbackGaps, 0.95),
        2,
      ),
      terminalSilenceMs: round(terminalSilenceMs, 2),
      meanFrameGapMs:
        state.frameGaps.length > 0
          ? round(
              state.frameGaps.reduce((sum, value) => sum + value, 0) /
                state.frameGaps.length,
              2,
            )
          : 0,
      videoSwitches: state.videoSwitches,
      usesRequestVideoFrameCallback:
        typeof state.video?.requestVideoFrameCallback === "function",
    };
  }

  function closeSamplerAtWindowBoundary(state) {
    if (!state || state.windowClosed) return;
    state.windowClosed = true;
    state.endedAtEpochMs = nowEpochMs();
    cancelFrameCallbacks(state);
    if (state.videoWatcherTimer !== null) {
      clearInterval(state.videoWatcherTimer);
      state.videoWatcherTimer = null;
    }
    if (state.windowEndTimer !== null) {
      clearTimeout(state.windowEndTimer);
      state.windowEndTimer = null;
    }
    for (const timer of state.pathObservationTimers) clearTimeout(timer);
    state.pathObservationTimers.clear();
    for (const target of state.pathObservationTargets) {
      if (!state.pathObservationInvokedIndexes.has(target.index)) {
        state.pathObservationSkippedTickCount += 1;
      }
    }
    // The terminal media-path observation owns the receiver's one end
    // snapshot. Reuse it here so two full getStats traversals never overlap.
    collectTerminalPeerConnectionStats(state);
  }

  function collectTerminalPeerConnectionStats(state) {
    state.statsEndPromise ??= collectPeerConnectionStats().catch((error) => {
      state.statsEndError =
        error instanceof Error ? error : new Error(String(error));
      return null;
    });
    return state.statsEndPromise;
  }

  async function beginSamplerWindow(value) {
    const state = runtime.sampler;
    const measurementWindow = normalizeWindow(value);
    if (!state || state.stopped || state.armed !== true) {
      return { ok: false, reason: "sampler-not-armed" };
    }
    if (!measurementWindow) {
      return { ok: false, reason: "invalid-measurement-window" };
    }
    if (state.measurementWindow) {
      return {
        ok:
          state.measurementWindow.id === measurementWindow.id &&
          state.beganAtEpochMs !== null,
        alreadyBegun: true,
        measurementWindow: state.measurementWindow,
        beganAtEpochMs: state.beganAtEpochMs,
      };
    }
    if (
      nowEpochMs() >
      measurementWindow.startedAtEpochMs + MAX_WINDOW_BOUNDARY_SKEW_MS
    ) {
      return { ok: false, reason: "measurement-window-start-is-stale" };
    }
    state.measurementWindow = measurementWindow;
    await waitUntilEpoch(measurementWindow.startedAtEpochMs);
    state.beganAtEpochMs = nowEpochMs();
    const beginSkewMs =
      state.beganAtEpochMs - measurementWindow.startedAtEpochMs;
    if (Math.abs(beginSkewMs) > MAX_WINDOW_BOUNDARY_SKEW_MS) {
      state.measurementWindow = null;
      return {
        ok: false,
        reason: "measurement-window-start-skew-exceeded",
        beginSkewMs,
      };
    }
    state.startedAt = measurementWindow.startedAtEpochMs;
    state.startedPerformanceAt =
      measurementWindow.startedAtEpochMs - performance.timeOrigin;
    state.startedPerformanceEpochMs = measurementWindow.startedAtEpochMs;
    state.nextVisualSampleAt = state.startedPerformanceAt;
    // Install the actual frame/path schedules synchronously at the barrier;
    // the asynchronous RTC snapshot must not delay visible-frame observation.
    scheduleFrameCallbacks(state);
    state.videoWatcherTimer = setInterval(() => {
      if (state.stopped || state.windowClosed) return;
      const nextVideo = remoteVideoCandidates(state.targetTrackId)[0]?.video ?? null;
      if (nextVideo && nextVideo !== state.video) switchSampledVideo(state, nextVideo);
    }, PATH_OBSERVATION_INTERVAL_MS);
    state.statsStartPromise = collectPeerConnectionStats();
    const firstPathObservation = armBoundMediaPathObservationSchedule(
      state,
      state.statsStartPromise,
    );
    state.windowEndTimer = setTimeout(
      () => closeSamplerAtWindowBoundary(state),
      Math.max(0, measurementWindow.endedAtEpochMs - nowEpochMs()),
    );
    state.statsStart = await state.statsStartPromise;
    await firstPathObservation;
    return {
      ok: true,
      alreadyBegun: false,
      measurementWindow,
      beganAtEpochMs: state.beganAtEpochMs,
      beginSkewMs: round(beginSkewMs, 3),
      statsStartedAtEpochMs: state.statsStart?.capturedAt ?? null,
    };
  }

  function stopSampler(value) {
    const state = runtime.sampler;
    if (!state) {
      return Promise.resolve(
        runtime.lastSamplerResult ?? {
          ok: false,
          reason: "sampler-not-running",
        },
      );
    }
    if (state.stopPromise) return state.stopPromise;
    if (state.stopped) {
      return Promise.resolve(
        runtime.lastSamplerResult ?? {
          ok: false,
          reason: "sampler-not-running",
        },
      );
    }
    const measurementWindow = normalizeWindow(value);
    if (
      !measurementWindow ||
      !state.measurementWindow ||
      measurementWindow.id !== state.measurementWindow.id ||
      measurementWindow.startedAtEpochMs !==
        state.measurementWindow.startedAtEpochMs ||
      measurementWindow.endedAtEpochMs !== state.measurementWindow.endedAtEpochMs
    ) {
      return Promise.resolve({
        ok: false,
        reason: "measurement-window-mismatch",
      });
    }
    state.stopPromise = finalizeSamplerStop(state, measurementWindow);
    return state.stopPromise;
  }

  async function finalizeSamplerStop(state, measurementWindow) {
    await waitUntilEpoch(measurementWindow.endedAtEpochMs);
    closeSamplerAtWindowBoundary(state);
    state.stopped = true;
    const stoppedAtPerformance =
      measurementWindow.endedAtEpochMs - performance.timeOrigin;
    const stoppedAtPerformanceEpochMs = measurementWindow.endedAtEpochMs;
    const stoppedAt = measurementWindow.endedAtEpochMs;
    if (state.pathObservationPromise) {
      await state.pathObservationPromise;
    }
    if (state.pathObservationTerminalPromise) {
      await state.pathObservationTerminalPromise;
    }
    const statsEnd = await state.statsEndPromise;
    if (!statsEnd) {
      throw state.statsEndError ?? new Error("terminal RTC snapshot failed");
    }
    if (state.mode === "visual") await waitForMetricDrain(state);
    if (state.metricWorker) {
      state.metricWorker.terminate();
      state.metricWorker = null;
    }
    const finalizedAtEpochMs = nowEpochMs();
    const durationMs = measurementWindow.durationMs;
    const cadence = finalizeCadence(state, stoppedAtPerformance);
    const snapshotMainThreadTotalMs = state.snapshotMainThreadDurations.reduce(
      (sum, value) => sum + value,
      0,
    );
    const metricComputeTotalMs = state.metricComputeDurations.reduce(
      (sum, value) => sum + value,
      0,
    );
    const metricDispatchMainThreadTotalMs =
      state.metricDispatchMainThreadDurations.reduce(
        (sum, value) => sum + value,
        0,
      );
    const pathObservationTotalMs = state.pathObservationDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    const frameObserverTotalMs = state.frameObserverDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    const mainThreadWorkDurations = state.snapshotMainThreadDurations.map(
      (snapshotDuration, index) =>
        snapshotDuration +
        finiteNumber(state.metricDispatchMainThreadDurations[index], 0),
    );
    const samplerOverhead = {
      visualSampleAttempts: state.visualSampleAttempts,
      completedVisualSamples: state.visualSamples.length,
      skippedVisualSamples: state.skippedVisualSamples,
      missedVisualSampleSlots: state.missedVisualSampleSlots,
      pendingJobDepthMaximum: state.maximumQueuedMetricJobDepth,
      workerErrors: state.metricWorkerErrors,
      snapshotMainThreadMs: {
        p50: round(percentile(state.snapshotMainThreadDurations, 0.5), 3),
        p95: round(percentile(state.snapshotMainThreadDurations, 0.95), 3),
        maximum: round(
          Math.max(0, ...state.snapshotMainThreadDurations),
          3,
        ),
        total: round(snapshotMainThreadTotalMs, 3),
      },
      metricComputeMs: {
        p50: round(percentile(state.metricComputeDurations, 0.5), 3),
        p95: round(percentile(state.metricComputeDurations, 0.95), 3),
        maximum: round(Math.max(0, ...state.metricComputeDurations), 3),
        total: round(metricComputeTotalMs, 3),
      },
      metricDispatchMainThreadMs: {
        p50: round(
          percentile(state.metricDispatchMainThreadDurations, 0.5),
          3,
        ),
        p95: round(
          percentile(state.metricDispatchMainThreadDurations, 0.95),
          3,
        ),
        maximum: round(
          Math.max(0, ...state.metricDispatchMainThreadDurations),
          3,
        ),
        total: round(metricDispatchMainThreadTotalMs, 3),
      },
      pathObservationMs: {
        p50: round(percentile(state.pathObservationDurations, 0.5), 3),
        p95: round(percentile(state.pathObservationDurations, 0.95), 3),
        maximum: round(
          Math.max(0, ...state.pathObservationDurations),
          3,
        ),
        total: round(pathObservationTotalMs, 3),
      },
      frameObserverMs: {
        p50: round(percentile(state.frameObserverDurations, 0.5), 3),
        p95: round(percentile(state.frameObserverDurations, 0.95), 3),
        maximum: round(Math.max(0, ...state.frameObserverDurations), 3),
        total: round(frameObserverTotalMs, 3),
      },
      mainThreadWorkMs: {
        p50: round(percentile(mainThreadWorkDurations, 0.5), 3),
        p95: round(percentile(mainThreadWorkDurations, 0.95), 3),
        maximum: round(Math.max(0, ...mainThreadWorkDurations), 3),
      },
      mainThreadDutyRatio: round(
        (snapshotMainThreadTotalMs + metricDispatchMainThreadTotalMs) /
          durationMs,
        6,
      ),
      workerDutyRatio: round(metricComputeTotalMs / durationMs, 6),
      pathObservationDutyRatio: round(
        pathObservationTotalMs / durationMs,
        6,
      ),
      frameObserverDutyRatio: round(
        frameObserverTotalMs / durationMs,
        6,
      ),
    };
    const rtc = deriveRtcSummary(
      state.statsStart,
      statsEnd,
      durationMs,
      state.mediaPathBinding,
    );
    const firstPathObservation = state.pathObservations[0] ?? null;
    const lastPathObservation = state.pathObservations.at(-1) ?? null;
    const pathObservationBoundaryAuthority = {
      valid:
        state.pathObservationTargets.length > 0 &&
        state.pathObservations.length === state.pathObservationTargets.length &&
        state.pathObservationSkippedTickCount === 0 &&
        state.pathObservationLateTickCount === 0 &&
        state.pathObservationOverlapTickCount === 0 &&
        state.pathObservationCaptureErrors.length === 0 &&
        state.pathObservations.every(
          (observation, index) =>
            observation.measurementWindowId === measurementWindow.id &&
            observation.scheduledAtEpochMs ===
              state.pathObservationTargets[index]?.scheduledAtEpochMs &&
            observation.capturedAtEpochMs >=
              measurementWindow.startedAtEpochMs &&
            observation.capturedAtEpochMs <= measurementWindow.endedAtEpochMs,
        ) &&
        Number.isFinite(firstPathObservation?.capturedAtEpochMs) &&
        firstPathObservation.capturedAtEpochMs -
          measurementWindow.startedAtEpochMs <=
          MAX_WINDOW_BOUNDARY_SKEW_MS &&
        Number.isFinite(lastPathObservation?.capturedAtEpochMs) &&
        measurementWindow.endedAtEpochMs -
          lastPathObservation.capturedAtEpochMs <=
          MAX_WINDOW_BOUNDARY_SKEW_MS,
      observationIntervalMs: PATH_OBSERVATION_INTERVAL_MS,
      terminalLeadMs: PATH_TERMINAL_LEAD_MS,
      maximumTickLatenessMs: MAX_PATH_TICK_LATENESS_MS,
      observedMaximumTickLatenessMs: round(
        Math.max(
          0,
          ...state.pathObservationTickRecords.map(
            (tick) => tick.tickLatenessMs ?? 0,
          ),
        ),
        3,
      ),
      scheduledObservationCount: state.pathObservationTargets.length,
      completedObservationCount: state.pathObservations.length,
      skippedTickCount: state.pathObservationSkippedTickCount,
      lateTickCount: state.pathObservationLateTickCount,
      overlapTickCount: state.pathObservationOverlapTickCount,
      captureErrors: state.pathObservationCaptureErrors,
      observerStartedAtEpochMs: state.pathObserverStartedAtEpochMs,
      observerStoppedAtEpochMs: state.endedAtEpochMs,
      terminalTickInvokedAtEpochMs:
        state.pathObserverTerminalInvokedAtEpochMs,
      firstCapturedAtEpochMs:
        firstPathObservation?.capturedAtEpochMs ?? null,
      lastCapturedAtEpochMs: lastPathObservation?.capturedAtEpochMs ?? null,
      tickRecords: state.pathObservationTickRecords,
    };
    const mediaPathBinding = state.mediaPathBinding
      ? {
          expected: { ...state.mediaPathBinding },
          measurementWindowId: measurementWindow.id,
          observationIntervalMs: PATH_OBSERVATION_INTERVAL_MS,
          observerMetadata: pathObservationBoundaryAuthority,
          valid:
            pathObservationBoundaryAuthority.valid === true &&
            state.pathBindingViolations.length === 0 &&
            rtc.boundMediaPathMatched === true,
          observationCount: state.pathObservations.length,
          observations: state.pathObservations,
          violations: state.pathBindingViolations,
        }
      : null;
    const fixtureState = state.sourceFixture ?? getFixtureState();
    const sortedAuditFrames = state.auditFrameCandidates
      .slice()
      .sort((left, right) => left._rank - right._rank);
    const sortedAuditRanks = state.auditRankIndex
      .slice()
      .sort((left, right) => left.rank - right.rank);
    const p10Rank =
      sortedAuditRanks[
        Math.floor(Math.max(0, sortedAuditRanks.length - 1) * 0.1)
      ] ?? null;
    const p10Frame = p10Rank
      ? state.tailAuditFrames.find(
          (frame) => frame._sampleId === p10Rank.sampleId,
        ) ?? null
      : null;
    const medianRank =
      sortedAuditRanks[
        Math.floor(Math.max(0, sortedAuditRanks.length - 1) * 0.5)
      ]?.rank ?? null;
    const medianFrame = Number.isFinite(medianRank)
      ? sortedAuditFrames.reduce(
          (closest, frame) =>
            !closest ||
            Math.abs(frame._rank - medianRank) <
              Math.abs(closest._rank - medianRank)
              ? frame
              : closest,
          null,
        )
      : null;
    const auditFrames = {
      worst: exportAuditFrame(state.tailAuditFrames[0] ?? null, "worst"),
      p10: exportAuditFrame(p10Frame, "p10"),
      median: exportAuditFrame(medianFrame, "median"),
      best: exportAuditFrame(
        sortedAuditFrames[sortedAuditFrames.length - 1] ?? null,
        "best",
      ),
    };
    const worstFrame = auditFrames.worst
      ? { ...auditFrames.worst, quantile: undefined }
      : null;
    const result = {
      ok: true,
      version: VERSION,
      mode: state.mode,
      measurementWindow,
      measurementWindowAuthority: {
        valid:
          state.beganAtEpochMs !== null &&
          state.endedAtEpochMs !== null &&
          Math.abs(
            state.beganAtEpochMs - measurementWindow.startedAtEpochMs,
          ) <= MAX_WINDOW_BOUNDARY_SKEW_MS &&
          Math.abs(
            state.endedAtEpochMs - measurementWindow.endedAtEpochMs,
          ) <= MAX_WINDOW_BOUNDARY_SKEW_MS &&
          Number.isFinite(state.statsStart?.capturedAt) &&
          Math.abs(
            state.statsStart.capturedAt - measurementWindow.startedAtEpochMs,
          ) <= MAX_WINDOW_BOUNDARY_SKEW_MS &&
          Number.isFinite(statsEnd?.capturedAt) &&
          Math.abs(
            statsEnd.capturedAt - measurementWindow.endedAtEpochMs,
          ) <= MAX_WINDOW_BOUNDARY_SKEW_MS &&
          pathObservationBoundaryAuthority.valid === true &&
          state.pathObservations.every(
            (observation) =>
              observation.measurementWindowId === measurementWindow.id &&
              observation.capturedAtEpochMs >=
                measurementWindow.startedAtEpochMs &&
              observation.capturedAtEpochMs <= measurementWindow.endedAtEpochMs,
          ),
        maximumBoundarySkewMs: MAX_WINDOW_BOUNDARY_SKEW_MS,
        armedAtEpochMs: state.armedAtEpochMs,
        beganAtEpochMs: state.beganAtEpochMs,
        endedAtEpochMs: state.endedAtEpochMs,
        finalizedAtEpochMs,
        beginSkewMs: round(
          state.beganAtEpochMs - measurementWindow.startedAtEpochMs,
          3,
        ),
        endSkewMs: round(
          state.endedAtEpochMs - measurementWindow.endedAtEpochMs,
          3,
        ),
        statsStartCapturedAtEpochMs: state.statsStart?.capturedAt ?? null,
        statsEndCapturedAtEpochMs: statsEnd?.capturedAt ?? null,
        pathObservation: pathObservationBoundaryAuthority,
      },
      startedAt: state.startedAt,
      stoppedAt,
      durationMs: round(durationMs, 2),
      targetFps: fixtureState.fps,
      sampleIntervalMs: state.sampleIntervalMs,
      fixture: {
        width: fixtureState.width,
        height: fixtureState.height,
        targetFps: fixtureState.fps,
        active: fixtureState.active,
        sourceGeneration: fixtureState.sourceGeneration,
        marker:
          "compact-manchester-hamming-secded-rolling-sequence-x3-require2",
        markerSequenceModulus: MARKER_SEQUENCE_MODULUS,
        content: "meeting-camera-hybrid-photo-v2-rolling-sequence",
        scenes: ["daylight-portrait", "office-motion", "low-light-portrait"],
      },
      analysis: {
        maximumWidth: MAX_ANALYSIS_WIDTH,
        alignmentMaximumWidth: 320,
        channel: "bt709-luma-chroma-ms-ssim",
        reference: "source-frame-high-quality-downsample",
        markerPixelsExcluded: true,
        metricExecution:
          state.mode === "visual"
            ? "dedicated-web-worker"
            : "disabled-telemetry-only",
        quantileArtifacts:
          "exact-worst-and-p10-with-distributed-median-and-best",
        cadence: "request-video-frame-callback-presented-frames",
      },
      video: {
        width: state.video?.videoWidth ?? 0,
        height: state.video?.videoHeight ?? 0,
        readyState: state.video?.readyState ?? 0,
      },
      visualSamples: state.visualSamples,
      worstFrame,
      worstFrames: worstFrame ? [worstFrame] : [],
      auditFrames,
      cadence: { ...cadence, measurementWindowId: measurementWindow.id },
      captureToDisplayPresentation: {
        version: CAPTURE_TO_DISPLAY_VERSION,
        measurementWindowId: measurementWindow.id,
        markerSequenceModulus: MARKER_SEQUENCE_MODULUS,
        expectedSourceGeneration:
          state.sourceFixture?.sourceGeneration ?? null,
        timestampMode:
          "request-video-frame-callback-expected-display-time",
        startedAtEpochMs: state.startedPerformanceEpochMs,
        stoppedAtEpochMs: stoppedAtPerformanceEpochMs,
        clock: clockSnapshot(),
        sequenceAmbiguityCount: state.markerSequenceAmbiguityCount,
        observations: state.presentationObservations,
      },
      samplerOverhead,
      mediaPathBinding,
      rtc: { ...rtc, measurementWindowId: measurementWindow.id },
      peerConnectionStats: {
        measurementWindow,
        start: {
          ...state.statsStart,
          measurementWindowId: measurementWindow.id,
        },
        end: { ...statsEnd, measurementWindowId: measurementWindow.id },
      },
    };
    runtime.lastSamplerResult = result;
    runtime.sampler = null;
    return result;
  }

  function getFixtureState() {
    const lifecycle = runtime.fixtureLifecycle;
    const current = lifecycle?.getLatestActive() ?? null;
    const lifecycleState = lifecycle?.snapshot() ?? {
      current: null,
      openSourceCount: 0,
      sources: [],
    };
    const fixture = current?.source ?? null;
    const settings =
      current?.settings ??
      runtime.lastFixtureSettings ?? {
        width: runtime.config.width,
        height: runtime.config.height,
        frameRate: runtime.config.targetFps,
      };
    const activeTrackCount = lifecycleState.sources.reduce(
      (sum, source) => sum + source.leaseCount,
      0,
    );
    const renderDurations = fixture?.renderDurations ?? [];
    const renderIntervals = fixture?.renderIntervals ?? [];
    const expectedFrameIntervalMs = 1000 / Math.max(1, settings.frameRate);
    const renderTotalMs = renderDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    const renderElapsedMs = fixture
      ? Math.max(1, nowPerformanceMs() - fixture.startedPerformanceAt)
      : 0;
    return {
      active:
        activeTrackCount > 0 && fixture?.track?.readyState === "live",
      frameId: fixture?.frameId ?? runtime.lastFixtureFrameId,
      sourceSequence:
        fixture?.sourceSequence ?? runtime.lastFixtureSourceSequence,
      markerSequence:
        Number.isInteger(fixture?.sourceSequence)
          ? fixture.sourceSequence % MARKER_SEQUENCE_MODULUS
          : null,
      markerGeneration:
        Number.isInteger(fixture?.sourceSequence)
          ? Math.floor(fixture.sourceSequence / MARKER_SEQUENCE_MODULUS)
          : null,
      markerSequenceModulus: MARKER_SEQUENCE_MODULUS,
      width: settings.width,
      height: settings.height,
      fps: settings.frameRate,
      sourceGeneration: current?.generation ?? null,
      sourceTimestampMode: fixture?.manualFrames
        ? "performance-time-origin-before-request-frame"
        : "automatic-canvas-capture",
      activeTrackCount,
      openSourceCount: lifecycleState.openSourceCount,
      performance: {
        elapsedMs: round(renderElapsedMs, 3),
        renderedFrameCount: renderDurations.length,
        renderDurationMs: {
          p50: round(percentile(renderDurations, 0.5), 3),
          p95: round(percentile(renderDurations, 0.95), 3),
          maximum: round(Math.max(0, ...renderDurations), 3),
          total: round(renderTotalMs, 3),
        },
        renderIntervalMs: {
          p50: round(percentile(renderIntervals, 0.5), 3),
          p95: round(percentile(renderIntervals, 0.95), 3),
          maximum: round(Math.max(0, ...renderIntervals), 3),
        },
        renderDutyRatio:
          renderElapsedMs > 0 ? round(renderTotalMs / renderElapsedMs, 6) : null,
        missedRenderDeadlines: renderIntervals.filter(
          (duration) => duration > expectedFrameIntervalMs * 1.5,
        ).length,
      },
    };
  }

  function resetFixturePerformance() {
    const current = runtime.fixtureLifecycle?.getLatestActive() ?? null;
    const fixture = current?.source ?? null;
    if (!fixture || fixture.track?.readyState !== "live") {
      return { ok: false, reason: "active fixture is missing" };
    }
    const resetAt = nowPerformanceMs();
    const resetAtEpochMs = performanceEpochMs(resetAt);
    fixture.renderDurations = [];
    fixture.renderIntervals = [];
    fixture.sourceFrameTimeline = [];
    fixture.sourceTimelineResetAtEpochMs = resetAtEpochMs;
    fixture.requestFrameFailureCount = 0;
    runtime.nextFixtureSourceSequence = 0;
    runtime.fixtureSourcesByGeneration.clear();
    runtime.fixtureSourcesByGeneration.set(current.generation, fixture);
    runtime.fixtureTimelineResetAtEpochMs = resetAtEpochMs;
    fixture.startedPerformanceAt = resetAt;
    fixture.lastRenderStartedAt = resetAt;
    return {
      ok: true,
      sourceGeneration: current.generation,
      resetAt,
      resetAtEpochMs,
      markerSequenceModulus: MARKER_SEQUENCE_MODULUS,
    };
  }

  function getSourceLatencyEvidence() {
    const current = runtime.fixtureLifecycle?.getLatestActive() ?? null;
    const sources = Array.from(runtime.fixtureSourcesByGeneration.entries())
      .sort(([left], [right]) => left - right)
      .map(([sourceGeneration, fixture]) => ({
        sourceGeneration,
        timestampMode: fixture.manualFrames
          ? "performance-time-origin-before-request-frame"
          : "automatic-canvas-capture",
        manualFrames: fixture.manualFrames,
        resetAtEpochMs: fixture.sourceTimelineResetAtEpochMs,
        requestFrameFailureCount: fixture.requestFrameFailureCount,
        frames: fixture.sourceFrameTimeline.map((frame) => ({ ...frame })),
      }));
    if (sources.length === 0) {
      return {
        version: CAPTURE_TO_DISPLAY_VERSION,
        available: false,
        reason: "active fixture is missing",
      };
    }
    const currentSource = sources.find(
      (source) => source.sourceGeneration === current?.generation,
    );
    const selectedSource = currentSource ?? sources.at(-1);
    return {
      version: CAPTURE_TO_DISPLAY_VERSION,
      available: true,
      markerSequenceModulus: MARKER_SEQUENCE_MODULUS,
      sourceGeneration: selectedSource.sourceGeneration,
      timestampMode: selectedSource.timestampMode,
      manualFrames: selectedSource.manualFrames,
      resetAtEpochMs: selectedSource.resetAtEpochMs,
      requestFrameFailureCount: selectedSource.requestFrameFailureCount,
      clock: clockSnapshot(),
      sources,
      frames: selectedSource.frames,
      activeSourceGeneration: currentSource?.sourceGeneration ?? null,
    };
  }

  function getMediaCaptureAudit() {
    const calls = runtime.nativeMediaCaptureCalls.map((call) => ({ ...call }));
    const nativeAudioCallCount = calls.filter(
      (call) => call.requestedAudio,
    ).length;
    return {
      safe: nativeAudioCallCount === 0,
      nativeAudioCallCount,
      nativeVideoCallCount: calls.filter((call) => call.requestedVideo).length,
      calls,
    };
  }

  const api = {
    version: VERSION,
    configure(nextConfig) {
      runtime.config = normalizeConfig(nextConfig);
      runtime.referenceCanvas = null;
      runtime.referenceFrameId = null;
      return { ...runtime.config };
    },
    getConfig() {
      return { ...runtime.config };
    },
    armSampler,
    // Compatibility name with arm-only semantics; opening a window is explicit.
    startSampler: armSampler,
    beginSamplerWindow,
    stopSampler,
    collectPeerConnectionStats,
    getFixtureState,
    resetFixturePerformance,
    getSourceLatencyEvidence,
    getMediaCaptureAudit,
    getPeerConnectionRegistry() {
      return runtime.peerConnections.map(peerConnectionMetadata);
    },
    getLastSamplerResult() {
      return runtime.lastSamplerResult;
    },
    renderExpectedFrame(canvas, frameId) {
      renderExpectedFrame(canvas, frameId);
    },
    decodeMarkerFromVideo(video) {
      const canvas = document.createElement("canvas");
      canvas.width = MARKER_ANALYSIS_WIDTH;
      canvas.height = MARKER_ROW_HEIGHT * MARKER_REPETITIONS;
      return decodeMarkerFromVideo(
        {
          markerCanvas: canvas,
          markerContext: canvas.getContext("2d", {
            alpha: false,
            willReadFrequently: true,
          }),
        },
        video,
      );
    },
  };
  Object.freeze(api);

  Object.defineProperty(globalThis, GLOBAL_NAME, {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  const fixtureCompatibilityApi = {};
  for (const field of [
    "active",
    "frameId",
    "sourceSequence",
    "markerSequence",
    "markerGeneration",
    "markerSequenceModulus",
    "width",
    "height",
    "fps",
    "sourceGeneration",
    "activeTrackCount",
    "openSourceCount",
  ]) {
    Object.defineProperty(fixtureCompatibilityApi, field, {
      configurable: false,
      enumerable: true,
      get() {
        return getFixtureState()[field];
      },
    });
  }
  fixtureCompatibilityApi.getState = getFixtureState;
  Object.defineProperty(globalThis, "__conclaveQualityFixture", {
    value: fixtureCompatibilityApi,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  installPeerConnectionRegistry();
  installMediaDevicesOverride();
}
