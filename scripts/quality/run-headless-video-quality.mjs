#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { evaluate, waitForEvaluation } from "./cdp.mjs";
import { compareQualityMatrices } from "./comparison.mjs";
import { assessConsumerGenerationReset } from "./consumer-generation-reset.mjs";
import {
  buildArmSamplerExpression,
  buildBeginSamplerExpression,
  buildStopSamplerExpression,
  resolveSamplerBeginEvaluationTimeoutMs,
} from "./browser-fixture.mjs";
import {
  assessCodecNegotiation,
  buildCodecCapabilityOverrideScript,
  parseCodecScenario,
} from "./codec-negotiation.mjs";
import {
  DEFAULT_VIDEO_QUALITY_MATRIX,
  getVideoQualityProfile,
  resolveVideoCodecPerformanceLimits,
  resolveVideoProcessCpuLimit,
  resolveVideoQualityReceiverProfiles,
} from "./profiles.mjs";
import {
  assessMeetingPerformance,
  assessPublisherCodecPerformance,
  assessReceiverCodecPerformance,
  publisherSenderEncodingSignature,
} from "./codec-performance.mjs";
import { startPublisherCodecObserver } from "./publisher-codec-observer.mjs";
import {
  assessBrowserProcessPerformance,
  buildHardwareIdentity,
  startBrowserProcessObserver,
} from "./process-performance.mjs";
import { assessReceiverTelemetry } from "./receiver-telemetry.mjs";
import { buildMatrixMarkdown, buildRunMarkdown } from "./report.mjs";
import {
  bindPublisherVideoSender,
  summarizePublisherVideoSenderStats,
  summarizePublisherVideoStats,
} from "./rtc-summary.mjs";
import { assessNetworkRealization } from "./network-realization.mjs";
import {
  DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION,
  assessDynamicNetworkTransition,
} from "./dynamic-network-transition.mjs";
import {
  DYNAMIC_NETWORK_TRANSITION_RUN_MODE,
  assertDynamicNetworkTransitionRunConfiguration,
  buildDynamicNetworkSamplerFromAlignedObservations,
  buildDynamicNetworkTransitionEvidence,
  buildFutureDynamicNetworkTransitionPlan,
  normalizeDynamicNetworkEndpointCheckpoint,
  startDynamicNetworkTransitionController,
} from "./dynamic-network-runner.mjs";
import {
  advanceMediaPathStability,
  assessStableMediaPath,
} from "./media-path-stability.mjs";
import {
  buildMeasurementContract,
  VIDEO_QUALITY_HARNESS_VERSION,
} from "./measurement-contract.mjs";
import { summarizeCaptureToDisplayLatency } from "./media-latency.mjs";
import {
  scoreVideoQualityRun,
  summarizeMatrix,
  summarizeRepeatability,
} from "./scoring.mjs";
import {
  assessNativeVp8PublisherReadiness,
  expectedActiveVideoSenderEncodingCount,
  parseVideoQualityReceiverCount,
} from "./receiver-count.mjs";
import {
  buildStartStartupTrackerExpression,
  buildStopStartupTrackerExpression,
} from "./startup-tracker.mjs";
import {
  attemptEmergencySilentBrowserCleanup,
  closeSilentBrowser,
  createTrustedQualityFixtureBootstrap,
  launchSilentBrowser,
  navigateSilentBrowserPage,
} from "./silent-browser-contract.mjs";
import { closeBrowsersWithLifecycleEvidence } from "./silent-browser-evidence.mjs";
import { detectNextWebRuntime } from "./web-runtime.mjs";

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const MEASUREMENT_WINDOW_MAX_BOUNDARY_SKEW_MS = 150;

const parseInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
};

const args = process.argv.slice(2);
const readArgument = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const hasArgument = (name) => args.includes(name);
const dynamicNetworkTransitionEnabled = hasArgument(
  "--dynamic-network-transition",
);
const runMode = dynamicNetworkTransitionEnabled
  ? DYNAMIC_NETWORK_TRANSITION_RUN_MODE
  : "steady-profile";

const baseUrl = (
  readArgument("--base-url") ??
  process.env.CONCLAVE_QUALITY_WEB_URL ??
  "http://localhost:3000"
).replace(/\/$/, "");
const chromePath =
  readArgument("--chrome-path") ??
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const requestedDurationMs =
  readArgument("--duration-ms") ?? process.env.CONCLAVE_QUALITY_DURATION_MS;
const durationMs = dynamicNetworkTransitionEnabled
  ? 103_000
  : parseInteger(requestedDurationMs, 15_000, 5_000, 120_000);
if (
  dynamicNetworkTransitionEnabled &&
  requestedDurationMs != null &&
  Number(requestedDurationMs) !== durationMs
) {
  throw new RangeError(
    "--dynamic-network-transition requires --duration-ms 103000",
  );
}
if (durationMs % 500 !== 0) {
  throw new RangeError("--duration-ms must be divisible by 500ms");
}
const warmupMs = parseInteger(
  readArgument("--warmup-ms") ?? process.env.CONCLAVE_QUALITY_WARMUP_MS,
  4_000,
  1_000,
  30_000,
);
const targetFps = parseInteger(
  readArgument("--fps") ?? process.env.CONCLAVE_QUALITY_FPS,
  30,
  10,
  60,
);
const sampleIntervalMs = parseInteger(
  readArgument("--sample-interval-ms") ??
    process.env.CONCLAVE_QUALITY_SAMPLE_INTERVAL_MS,
  450,
  100,
  2_000,
);
const requestedRepetitions =
  readArgument("--repetitions") ?? process.env.CONCLAVE_QUALITY_REPETITIONS;
const repetitions = dynamicNetworkTransitionEnabled
  ? 1
  : parseInteger(requestedRepetitions, 1, 1, 10);
if (
  dynamicNetworkTransitionEnabled &&
  requestedRepetitions != null &&
  Number(requestedRepetitions) !== repetitions
) {
  throw new RangeError(
    "--dynamic-network-transition requires --repetitions 1",
  );
}
const requireUdp =
  dynamicNetworkTransitionEnabled ||
  hasArgument("--require-udp") ||
  /^(1|true)$/i.test(process.env.CONCLAVE_QUALITY_REQUIRE_UDP ?? "");
const requestedReceiverCount =
  readArgument("--receiver-count") ??
  process.env.CONCLAVE_QUALITY_RECEIVER_COUNT;
const receiverCount = dynamicNetworkTransitionEnabled
  ? 2
  : parseVideoQualityReceiverCount(requestedReceiverCount);
if (
  dynamicNetworkTransitionEnabled &&
  requestedReceiverCount != null &&
  Number(requestedReceiverCount) !== receiverCount
) {
  throw new RangeError(
    "--dynamic-network-transition requires --receiver-count 2",
  );
}
const requestedDevicePixelRatio = Number(
  readArgument("--dpr") ?? process.env.CONCLAVE_QUALITY_DPR,
);
const clientId = process.env.CONCLAVE_SFU_CLIENT_ID ?? "";
const requestedProfile =
  readArgument("--profile") ?? process.env.CONCLAVE_QUALITY_PROFILE;
const requestedPublisherNetworkProfile =
  readArgument("--publisher-network-profile") ??
  process.env.CONCLAVE_QUALITY_PUBLISHER_NETWORK_PROFILE ??
  null;
const requestedReceiverProfilesValue =
  readArgument("--receiver-profiles") ??
  process.env.CONCLAVE_QUALITY_RECEIVER_PROFILES ??
  null;
const requestedReceiverProfiles = dynamicNetworkTransitionEnabled
  ? requestedReceiverProfilesValue ?? "pristine,pristine"
  : requestedReceiverProfilesValue;
const codecScenario = parseCodecScenario(
  readArgument("--codec-scenario") ??
    process.env.CONCLAVE_QUALITY_CODEC_SCENARIO,
);
if (
  dynamicNetworkTransitionEnabled &&
  (hasArgument("--matrix") ||
    !["all-modern", "native-compat"].includes(codecScenario) ||
    (requestedProfile != null && requestedProfile !== "pristine") ||
    (requestedPublisherNetworkProfile != null &&
      requestedPublisherNetworkProfile !== "pristine") ||
    (requestedReceiverProfilesValue != null &&
      requestedReceiverProfilesValue !== "pristine,pristine"))
) {
  throw new RangeError(
    "--dynamic-network-transition requires a supported exact codec scenario and pristine publisher/receiver startup profiles",
  );
}
const profileNames = dynamicNetworkTransitionEnabled
  ? ["pristine"]
  : requestedProfile
    ? [requestedProfile]
    : hasArgument("--matrix")
      ? [...DEFAULT_VIDEO_QUALITY_MATRIX]
      : ["pristine"];
const runId =
  process.env.CONCLAVE_QUALITY_RUN_ID ??
  new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(
  readArgument("--output-dir") ??
    process.env.CONCLAVE_QUALITY_OUTPUT_DIR ??
    join("artifacts", "video-quality", runId),
);
const baselinePathValue =
  readArgument("--baseline") ?? process.env.CONCLAVE_QUALITY_BASELINE;
const baselinePath = baselinePathValue ? resolve(baselinePathValue) : null;
let webRuntime = "unknown";
const measurementContract = buildMeasurementContract();

if (dynamicNetworkTransitionEnabled) {
  assertDynamicNetworkTransitionRunConfiguration({
    profileNames,
    receiverCount,
    durationMs,
    repetitions,
    requireUdp,
    sampleIntervalMs,
    codecScenario,
  });
}

if (!existsSync(chromePath)) {
  throw new Error(`Chrome does not exist at ${chromePath}`);
}

mkdirSync(outputRoot, { recursive: true });

const emit = (event, payload = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
};

const buildDebugBootstrapScript = () => `(() => {
  try {
    window.localStorage.setItem("conclave:debug-video-effects", "1");
    window.localStorage.removeItem("conclave:debug-video-effects-verbose");
  } catch {}
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const input = args[0];
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? String(input) : input.url,
        window.location.href,
      );
      if (requestUrl.pathname === "/api/sfu/join") {
        void response
          .clone()
          .json()
          .then((payload) => {
            if (typeof payload?.sfuUrl !== "string") return;
            const origin = new URL(payload.sfuUrl, window.location.href).origin;
            window.__conclaveQualitySfuOrigin = origin;
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  };
})();`;

const buildNetworkHintScript = (profile) => {
  const network = profile.network;
  const effectiveType =
    !network || network.downloadKbps >= 4_000
      ? "4g"
      : network.downloadKbps >= 700
        ? "3g"
        : "2g";
  const hint = {
    effectiveType,
    saveData: false,
    downlink: (network?.downloadKbps ?? 10_000) / 1_000,
    rtt: network?.latencyMs ?? 20,
  };
  return `(() => {
    const hint = ${JSON.stringify(hint)};
    const listeners = new Set();
    const connection = {
      get effectiveType() { return hint.effectiveType; },
      get saveData() { return hint.saveData; },
      get downlink() { return hint.downlink; },
      get rtt() { return hint.rtt; },
      type: "wifi",
      addEventListener(type, listener) {
        if (type === "change") listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "change") listeners.delete(listener);
      },
      dispatchEvent(event) {
        if (event?.type !== "change") return true;
        for (const listener of listeners) {
          if (typeof listener === "function") listener.call(connection, event);
          else listener?.handleEvent?.(event);
        }
        return true;
      },
    };
    for (const key of ["connection", "mozConnection", "webkitConnection"]) {
      try {
        Object.defineProperty(navigator, key, {
          configurable: true,
          get: () => connection,
        });
      } catch {}
    }
  })();`;
};

const applyNetworkProfile = async (cdp, profile, endpoint) => {
  if (!profile.network) return;
  const network = profile.network;
  const bytesPerSecond = (kbps) => Math.max(1, Math.round((kbps * 1_000) / 8));
  const conditions = {
    urlPattern: "",
    offline: false,
    latency: Math.max(0, network.latencyMs / 2),
    downloadThroughput: bytesPerSecond(network.downloadKbps),
    uploadThroughput: bytesPerSecond(network.uploadKbps),
    connectionType: network.connectionType,
    packetLoss: network.packetLossPercent,
    packetQueueLength: network.packetQueueLength,
    packetReordering: network.packetReordering,
  };
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditionsByRule", {
    offline: false,
    matchedNetworkConditions: [conditions],
  });
  await cdp.send("Network.overrideNetworkState", {
    offline: false,
    latency: conditions.latency,
    downloadThroughput: conditions.downloadThroughput,
    uploadThroughput: conditions.uploadThroughput,
    connectionType: conditions.connectionType,
  });
  emit("network_profile_applied", { profile: profile.name, endpoint, conditions });
};

const buildRoomUrl = (roomId, name, { admin = false } = {}) => {
  const url = new URL(`/${encodeURIComponent(roomId)}`, baseUrl);
  url.searchParams.set("autojoin", "1");
  url.searchParams.set("recorder", "1");
  if (admin) url.searchParams.set("admin", "1");
  url.searchParams.set("name", name);
  if (clientId) url.searchParams.set("clientId", clientId);
  return String(url);
};

const launchBrowser = async ({
  label,
  url,
  profile,
  enableSyntheticCamera,
  enableSyntheticAudio = true,
  codecCapabilityScenario = null,
}) => {
  const devicePixelRatio =
    Number.isFinite(requestedDevicePixelRatio) && requestedDevicePixelRatio > 0
      ? Math.min(4, Math.max(1, requestedDevicePixelRatio))
      : profile.devicePixelRatio;
  const fixtureBootstrap = await createTrustedQualityFixtureBootstrap({
    enableSyntheticCamera,
    enableSyntheticAudio,
    targetFps,
    width: 1280,
    height: 720,
  });
  const consoleEvents = [];
  let session = null;
  try {
    session = await launchSilentBrowser({
      chromePath,
      label,
      windowSize: "1440,900",
      trustedPreSafetyBootstraps: [fixtureBootstrap],
    });
    const cdp = session.pageCdp;
    const browserCdp = session.systemCdp;
    const dynamicNetworkCdp = session.networkCdp;
    if (!cdp || !browserCdp || !dynamicNetworkCdp) {
      throw new Error(`${label} silent browser did not expose its safe CDP facades`);
    }
    const [browserVersion, systemInfo, initialProcessInfo] = await Promise.all([
      browserCdp.send("Browser.getVersion"),
      browserCdp.send("SystemInfo.getInfo"),
      browserCdp.send("SystemInfo.getProcessInfo"),
    ]);
    const expectedBrowserPid = session.authority?.childPid;
    const exactBrowserProcess = (initialProcessInfo?.processInfo ?? []).filter(
      (process) =>
        Number(process?.id) === expectedBrowserPid &&
        String(process?.type ?? "").toLowerCase() === "browser",
    );
    if (exactBrowserProcess.length !== 1) {
      throw new Error(
        `${label} browser-level CDP did not identify exact Chrome PID ${expectedBrowserPid}`,
      );
    }
    const hardwareIdentity = buildHardwareIdentity({
      browserVersion,
      systemInfo,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    });
    if (hardwareIdentity.complete !== true) {
      throw new Error(
        `${label} hardware identity is incomplete: ${hardwareIdentity.missingFields.join(", ")}`,
      );
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: devicePixelRatio,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 900,
    });
    cdp.on("Runtime.consoleAPICalled", (event) => {
      const text = (event.args ?? [])
        .map((entry) => entry.value ?? entry.description ?? "")
        .join(" ");
      consoleEvents.push({ type: event.type, text });
      if (consoleEvents.length > 500) consoleEvents.shift();
    });
    await applyNetworkProfile(dynamicNetworkCdp, profile, label);
    const codecCapabilityOverride = codecCapabilityScenario
      ? buildCodecCapabilityOverrideScript(codecCapabilityScenario)
      : "";
    for (const source of [
      codecCapabilityOverride,
      buildDebugBootstrapScript(),
      buildNetworkHintScript(profile),
    ].filter(Boolean)) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    }
    const navigationSafety = await navigateSilentBrowserPage(session, {
      url,
      label,
    });
    emit("browser_navigate", {
      label,
      profile: profile.name,
      url,
      muted: true,
      devicePixelRatio,
    });
    return {
      label,
      cdp,
      dynamicNetworkCdp,
      browserCdp,
      expectedBrowserPid,
      consoleEvents,
      session,
      silentAuthority: session.authority,
      silentBootstrap: session.bootstrap,
      navigationSafety,
      browserVersion,
      hardwareIdentity,
      gpuFingerprint: hardwareIdentity.gpu,
      devicePixelRatio,
      cleanupPromise: null,
      cleanupResult: null,
    };
  } catch (error) {
    if (session) {
      try {
        await closeSilentBrowser(session);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to launch ${label}: ${error instanceof Error ? error.message : String(error)}; cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw error;
  }
};

const closeBrowser = async (browser) => {
  if (!browser) return null;
  if (
    browser.cleanupResult &&
    browser.cleanupResult.cleanupAuthorityRetained === false
  ) {
    return browser.cleanupResult;
  }
  if (!browser.cleanupPromise) {
    browser.cleanupPromise = closeSilentBrowser(browser.session)
      .then((result) => {
        browser.cleanupResult = result;
        return result;
      })
      .catch((error) => {
        browser.cleanupResult = error?.result ?? browser.cleanupResult;
        if (browser.cleanupResult?.cleanupAuthorityRetained === true) {
          browser.cleanupPromise = null;
        }
        throw error;
      });
  }
  return browser.cleanupPromise;
};

const collectPublisherCodecPayload = async (browser, measurementWindowId) =>
  evaluate(
    browser.cdp,
    `(() => {
      const collect = window.__conclaveQualityHarness?.collectPeerConnectionStats;
      if (typeof collect !== "function") {
        return Promise.resolve({ snapshot: null, producerId: null, reason: "stats-collector-missing" });
      }
      return collect().then((snapshot) => {
        const debug = window.__conclaveGetMeetVideoDebug?.() ?? null;
        return {
          snapshot,
          producerId: debug?.videoProducer?.id ?? null,
          currentTrackId: debug?.videoProducer?.track?.id ?? null,
          measurementWindowId: ${JSON.stringify(measurementWindowId)},
          dynamicNetworkRaw: {
            capturedAtEpochMs: snapshot?.capturedAt ?? Date.now(),
            debug,
            hintRuntime:
              window.__conclaveQualityDynamicNetworkHint?.snapshot?.() ?? null,
            rtc: snapshot,
          },
        };
      });
    })()`,
    10_000,
  );

const clickButton = async (cdp, label) =>
  waitForEvaluation(
    cdp,
    `button ${label}`,
    `(() => {
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const target = ${JSON.stringify(label)}.toLowerCase();
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
        if (candidate.disabled) return false;
        const text = normalize(candidate.getAttribute("aria-label") || candidate.textContent || candidate.title).toLowerCase();
        return text === target || text.includes(target);
      });
      if (!button) return { ok: false };
      button.click();
      return { ok: true };
    })()`,
    20_000,
  );

const waitForPassiveReceiver = async (browser) => {
  await waitForEvaluation(
    browser.cdp,
    `${browser.label} joined`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      return {
        ok: debug?.connectionState === "joined",
        state: debug?.connectionState,
      };
    })()`,
    60_000,
  );
  await waitForEvaluation(
    browser.cdp,
    `${browser.label} decoded remote webcam`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const videos = Array.from(
        document.querySelectorAll('video[data-meet-video-stream-type="webcam"]'),
      );
      const decoded = videos.find(
        (video) =>
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          video.srcObject instanceof MediaStream,
      );
      return {
        ok: debug?.connectionState === "joined" && Boolean(decoded),
        state: debug?.connectionState,
        videoCount: videos.length,
        decodedWidth: decoded?.videoWidth ?? 0,
        decodedHeight: decoded?.videoHeight ?? 0,
      };
    })()`,
    60_000,
  );
};

const writeDataUrl = (dataUrl, filePath) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return null;
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  writeFileSync(filePath, Buffer.from(dataUrl.slice(comma + 1), "base64"));
  return basename(filePath);
};

const countConsoleErrors = (events) =>
  events.filter(
    (event) =>
      event.type === "error" &&
      !/favicon|posthog|analytics|ERR_BLOCKED_BY_CLIENT|Only admins can manage/i.test(
        event.text,
      ),
  ).length;

const countUnexpectedRecoveries = (events) =>
  events.filter((event) =>
    /unexpectedly|stalled|recovering camera|republished camera|transport failure/i.test(
      event.text,
    ),
  ).length;

const readHarnessState = (browser) =>
  evaluate(
    browser.cdp,
    `(() => ({
      fixture: window.__conclaveQualityHarness?.getFixtureState?.() ?? null,
      captureAudit: window.__conclaveQualityHarness?.getMediaCaptureAudit?.() ?? null,
      selectedSfuOrigin:
        typeof window.__conclaveQualitySfuOrigin === "string"
          ? window.__conclaveQualitySfuOrigin
          : null,
      codecCapabilities:
        window.__conclaveQualityCodecCapabilities ?? null,
    }))()`,
    10_000,
  );

const assertNoNativeAudioCapture = (states, phase) => {
  const offenders = states.filter(
    ({ state }) => (state?.captureAudit?.nativeAudioCallCount ?? 0) > 0,
  );
  if (offenders.length === 0) return;
  throw new Error(
    `Quality harness blocked native microphone capture during ${phase}: ${offenders
      .map(
        ({ label, state }) =>
          `${label}=${state.captureAudit.nativeAudioCallCount}`,
      )
      .join(", ")}`,
  );
};

const collectPublisherPeerConnectionStats = (browser) =>
  evaluate(
    browser.cdp,
    `window.__conclaveQualityHarness.collectPeerConnectionStats()`,
    10_000,
  );

const readPublisherProducerDebug = (browser) =>
  evaluate(
    browser.cdp,
    `(() => {
      const state = window.__conclaveGetMeetVideoDebug?.();
      const producer = state?.videoProducer;
      const webcam = state?.adaptivePublish?.producers?.webcam;
      return {
        id: typeof producer?.id === "string" ? producer.id : null,
        closed: producer?.closed ?? null,
        trackId: webcam?.trackId ?? null,
        encodings: webcam?.encodings ?? [],
      };
    })()`,
    10_000,
  );

const waitForPublisherOutboundEvidence = async (
  browser,
  {
    expectedMimeType = null,
    producerIdNot = null,
    timeoutMs = 15_000,
  } = {},
) => {
  const startedAt = Date.now();
  let previous = await collectPublisherPeerConnectionStats(browser);
  let lastEvidence = {
    matched: false,
    producer: await readPublisherProducerDebug(browser),
    rtc: null,
    pcWideRtc: null,
  };
  const expected = expectedMimeType?.toLowerCase() ?? null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(250);
    const current = await collectPublisherPeerConnectionStats(browser);
    const producer = await readPublisherProducerDebug(browser);
    const intervalMs = Math.max(
      1,
      (current?.capturedAt ?? Date.now()) -
        (previous?.capturedAt ?? Date.now() - 250),
    );
    const rtc = summarizePublisherVideoSenderStats(
      previous,
      current,
      intervalMs,
      {
        trackId: producer.trackId,
        expectedEncodings: producer.encodings,
      },
    );
    const pcWideRtc = summarizePublisherVideoStats(
      previous,
      current,
      intervalMs,
    );
    const active = (rtc.encodings ?? []).filter(
      (encoding) => encoding.active === true,
    );
    const producerMatches =
      typeof producer?.id === "string" &&
      producer.closed !== true &&
      (producerIdNot == null || producer.id !== producerIdNot);
    const codecMatches =
      rtc.binding?.matched === true &&
      active.length > 0 &&
      (expected == null ||
        active.every(
          (encoding) =>
            String(encoding.codecMimeType ?? "").toLowerCase() === expected,
        ));
    lastEvidence = {
      matched: producerMatches && codecMatches,
      producer,
      rtc,
      pcWideRtc,
      capturedAt: current?.capturedAt ?? Date.now(),
    };
    if (lastEvidence.matched) return lastEvidence;
    previous = current;
  }

  return {
    ...lastEvidence,
    matched: false,
    timedOut: true,
    timeoutMs,
  };
};

const readPublisherMediaPathDebug = (browser) =>
  evaluate(
    browser.cdp,
    `(() => {
      const state = window.__conclaveGetMeetVideoDebug?.();
      const webcam = state?.adaptivePublish?.producers?.webcam;
      return {
        connectionState: state?.connectionState ?? null,
        producerId: state?.videoProducer?.id ?? null,
        closed: state?.videoProducer?.closed ?? null,
        trackId: webcam?.trackId ?? null,
        codecs: webcam?.codecs ?? [],
        encodings: webcam?.encodings ?? [],
      };
    })()`,
    10_000,
  );

const waitForNativeVp8PublisherReadiness = async (
  browser,
  {
    receiverCount: expectedReceiverCount,
    initialProducerId,
    timeoutMs = 25_000,
  },
) => {
  const startedAt = Date.now();
  let assessment = null;
  let previousStats = await collectPublisherPeerConnectionStats(browser);
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(250);
    const [adaptivePublish, currentStats] = await Promise.all([
      evaluate(
        browser.cdp,
        `window.__conclaveGetMeetVideoDebug?.()?.adaptivePublish ?? null`,
        10_000,
      ),
      collectPublisherPeerConnectionStats(browser),
    ]);
    const intervalMs = Math.max(
      1,
      (currentStats?.capturedAt ?? Date.now()) -
        (previousStats?.capturedAt ?? Date.now() - 250),
    );
    const publisherRtc = summarizePublisherVideoSenderStats(
      previousStats,
      currentStats,
      intervalMs,
      {
        trackId:
          adaptivePublish?.producers?.webcam?.trackId ?? null,
        expectedEncodings:
          adaptivePublish?.producers?.webcam?.encodings ?? null,
      },
    );
    const pcWideRtc = summarizePublisherVideoStats(
      previousStats,
      currentStats,
      intervalMs,
    );
    assessment = {
      ...assessNativeVp8PublisherReadiness({
        receiverCount: expectedReceiverCount,
        adaptivePublish,
        publisherRtc,
        initialProducerId,
      }),
      diagnostics: { pcWideRtc },
    };
    if (assessment.ready) {
      const readyAt = Date.now();
      return {
        ...assessment,
        waitedMs: readyAt - startedAt,
        transition: {
          ...assessment.transition,
          readinessWaitStartedAt: startedAt,
          readyAt,
          readinessWaitMs: readyAt - startedAt,
        },
      };
    }
    previousStats = currentStats;
  }
  throw new Error(
    `Timed out waiting for native VP8 publisher topology: ${JSON.stringify({
      ...assessment,
      timeoutMs,
    })}`,
  );
};

const readViewerMediaPathDebug = (browser, expectedProducerId) =>
  evaluate(
    browser.cdp,
    `(() => {
      const state = window.__conclaveGetMeetVideoDebug?.();
      const consumers = state?.adaptiveConsumers?.entries ?? [];
      const boundConsumer = consumers.find(
        (consumer) => consumer?.producerId === ${JSON.stringify(expectedProducerId)},
      );
      const decoded = Array.from(
        document.querySelectorAll('video[data-meet-video-stream-type="webcam"]'),
      ).find(
        (video) =>
          video.srcObject instanceof MediaStream &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          video.srcObject
            .getVideoTracks()
            .some((track) => track.id === boundConsumer?.consumerId),
      );
      return {
        connectionState: state?.connectionState ?? null,
        consumers,
        renderedVideo: decoded
          ? { width: decoded.videoWidth, height: decoded.videoHeight }
          : null,
      };
    })()`,
    10_000,
  );

const readReceiverMeasurementDebug = (browser, binding) =>
  evaluate(
    browser.cdp,
    `(() => {
      const expectedConsumerId = ${JSON.stringify(binding?.consumerId ?? null)};
      const expectedProducerId = ${JSON.stringify(binding?.producerId ?? null)};
      const state = window.__conclaveGetMeetVideoDebug?.();
      const consumers = state?.adaptiveConsumers?.entries ?? [];
      const boundConsumer = consumers.find(
        (consumer) =>
          consumer?.consumerId === expectedConsumerId &&
          consumer?.producerId === expectedProducerId,
      );
      const decoded = Array.from(
        document.querySelectorAll('video[data-meet-video-stream-type="webcam"]'),
      ).find(
        (video) =>
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          video.srcObject instanceof MediaStream &&
          video.srcObject
            .getVideoTracks()
            .some((track) => track.id === expectedConsumerId),
      );
      const rect = decoded?.getBoundingClientRect();
      return {
        connectionState: state?.connectionState ?? null,
        network: state?.network ?? null,
        adaptiveConsumers: state?.adaptiveConsumers ?? null,
        boundConsumer: boundConsumer ?? null,
        consumerGenerationResetVersion:
          state?.consumerGenerationResetVersion ?? null,
        consumerGenerationResets:
          state?.consumerGenerationResets ?? null,
        renderedVideo: decoded ? {
          width: decoded.videoWidth,
          height: decoded.videoHeight,
          cssWidth: rect?.width ?? null,
          cssHeight: rect?.height ?? null,
          devicePixelRatio: window.devicePixelRatio,
        } : null,
      };
    })()`,
    10_000,
  );

const receiverPlayoutPolicy = (debug, binding) => {
  const exactBoundPlayoutPolicy = debug?.boundConsumer ?? null;
  return {
    evidencePresent: Boolean(exactBoundPlayoutPolicy),
    expectedConsumerId: binding?.consumerId ?? null,
    expectedProducerId: binding?.producerId ?? null,
    consumerId: exactBoundPlayoutPolicy?.consumerId ?? null,
    producerId: exactBoundPlayoutPolicy?.producerId ?? null,
    kind: exactBoundPlayoutPolicy?.kind ?? null,
    type: exactBoundPlayoutPolicy?.type ?? null,
    requestedTargetMs:
      exactBoundPlayoutPolicy?.requestedJitterBufferTargetMs ?? null,
    observedTargetMs: exactBoundPlayoutPolicy?.observedTargetMs ?? null,
    status: exactBoundPlayoutPolicy?.jitterBufferTargetStatus ?? null,
  };
};

const mediaPathBindingFromStability = (stability) => ({
  producerId: stability?.assessment?.expectedProducerId ?? null,
  consumerId: stability?.assessment?.consumer?.consumerId ?? null,
  connectionId: stability?.assessment?.inbound?.connectionId ?? null,
  statId: stability?.assessment?.inbound?.statId ?? null,
  ssrc: stability?.assessment?.inbound?.ssrc ?? null,
  codecMimeType: stability?.assessment?.inbound?.codecMimeType ?? null,
  frameWidth: stability?.assessment?.inbound?.frameWidth ?? null,
  frameHeight: stability?.assessment?.inbound?.frameHeight ?? null,
  spatialLayer:
    stability?.assessment?.consumer?.currentLayers?.spatialLayer ?? null,
  temporalLayer:
    stability?.assessment?.consumer?.currentLayers?.temporalLayer ?? null,
});

const waitForStableMediaPath = async ({
  publisher,
  viewer,
  expectedProducerId,
  expectedCodecMimeType,
  minimumDecodedHeight,
  requiredStableMs,
  minimumDecodedFrames,
  timeoutMs,
  expectedSenderEncodingCount,
  expectedActiveSenderEncodings,
  expectedSenderEncodings,
  expectedConsumerTemporalLayer,
}) => {
  const startedAt = Date.now();
  let stability = null;
  let previousPublisherStats = await collectPublisherPeerConnectionStats(
    publisher,
  );

  while (Date.now() - startedAt < timeoutMs) {
    const [publisherDebug, viewerDebug, viewerStats, currentPublisherStats] =
      await Promise.all([
        readPublisherMediaPathDebug(publisher),
        readViewerMediaPathDebug(viewer, expectedProducerId),
        collectPublisherPeerConnectionStats(viewer),
        collectPublisherPeerConnectionStats(publisher),
      ]);
    const publisherStatsIntervalMs = Math.max(
      1,
      (currentPublisherStats?.capturedAt ?? Date.now()) -
        (previousPublisherStats?.capturedAt ?? Date.now() - 250),
    );
    const publisherRtc = summarizePublisherVideoSenderStats(
      previousPublisherStats,
      currentPublisherStats,
      publisherStatsIntervalMs,
      {
        trackId: publisherDebug?.trackId ?? null,
        expectedEncodings: publisherDebug?.encodings ?? null,
      },
    );
    const assessment = assessStableMediaPath({
      publisher: publisherDebug,
      publisherRtc,
      viewer: viewerDebug,
      viewerStats,
      expectedProducerId,
      expectedCodecMimeType,
      expectedSenderEncodingCount,
      expectedActiveSenderEncodings,
      expectedSenderEncodings,
      expectedConsumerTemporalLayer,
      minimumDecodedHeight,
    });
    previousPublisherStats = currentPublisherStats;
    stability = advanceMediaPathStability(stability, assessment, {
      now: Date.now(),
      requiredStableMs,
      minimumDecodedFrames,
    });
    if (stability.ready) {
      return {
        ...stability,
        matched: true,
        waitedMs: Date.now() - startedAt,
        requiredStableMs,
        minimumDecodedFrames,
      };
    }
    await sleep(250);
  }

  return {
    ...stability,
    matched: false,
    timedOut: true,
    timeoutMs,
    waitedMs: Date.now() - startedAt,
    requiredStableMs,
    minimumDecodedFrames,
  };
};

const collectStartupFailureBrowserDiagnostics = async (browser) => {
  if (!browser?.cdp) return null;

  let page = null;
  let pageError = null;
  try {
    page = await evaluate(
      browser.cdp,
      `(() => {
        const debug = window.__conclaveGetMeetVideoDebug?.() ?? null;
        const videos = Array.from(document.querySelectorAll("video")).map((video) => ({
          streamType: video.dataset.meetVideoStreamType ?? null,
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
          paused: video.paused,
          muted: video.muted,
          tracks: video.srcObject instanceof MediaStream
            ? video.srcObject.getTracks().map((track) => ({
                id: track.id,
                kind: track.kind,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
              }))
            : [],
        }));
        return {
          href: location.href,
          title: document.title,
          visibilityState: document.visibilityState,
          debug,
          videos,
        };
      })()`,
      5_000,
    );
  } catch (error) {
    pageError = error instanceof Error ? error.message : String(error);
  }

  let peerConnections = null;
  let peerConnectionError = null;
  try {
    peerConnections = await collectPublisherPeerConnectionStats(browser);
  } catch (error) {
    peerConnectionError = error instanceof Error ? error.message : String(error);
  }

  return {
    label: browser.label,
    page,
    pageError,
    peerConnections,
    peerConnectionError,
    consoleEvents: browser.consoleEvents?.slice(-200) ?? [],
    stdioPolicy: "ignored",
  };
};

const runProfile = async (profile, repetition) => {
  const receiverProfiles = resolveVideoQualityReceiverProfiles(
    requestedReceiverProfiles,
    {
      receiverCount,
      primaryProfileName: profile.name,
      codecScenario,
    },
  );
  const receiverProfileNames = receiverProfiles.map(
    (receiverProfile) => receiverProfile.name,
  );
  const publisherNetworkProfile = requestedPublisherNetworkProfile
    ? getVideoQualityProfile(requestedPublisherNetworkProfile, codecScenario)
    : profile;
  const repetitionSuffix = repetitions > 1 ? `-r${repetition}` : "";
  const roomId =
    `quality-${runId}-${codecScenario}-${profile.name}${repetitionSuffix}`.slice(
      0,
      96,
    );
  const profileDirectory = join(
    outputRoot,
    repetitions > 1 ? `${profile.name}-run-${repetition}` : profile.name,
  );
  mkdirSync(profileDirectory, { recursive: true });
  let publisher = null;
  let viewer = null;
  const extraViewers = [];
  let profileCleanupPromise = null;
  const closeProfileBrowsers = () => {
    if (!profileCleanupPromise) {
      profileCleanupPromise = closeBrowsersWithLifecycleEvidence(
        [publisher, viewer, ...extraViewers],
        {
          attempts: 3,
          expectedBrowserCount: receiverCount + 1,
          closeBrowserImpl: closeBrowser,
        },
      );
    }
    return profileCleanupPromise;
  };
  emit("profile_start", {
    profile: profile.name,
    codecScenario,
    receiverCount,
    receiverProfiles: receiverProfileNames,
    roomId,
    repetition,
    repetitions,
  });

  try {
    publisher = await launchBrowser({
      label: "publisher",
      url: buildRoomUrl(roomId, `Quality Source ${profile.name}`, {
        admin: true,
      }),
      profile: publisherNetworkProfile,
      enableSyntheticCamera: true,
      enableSyntheticAudio: true,
    });
    await waitForEvaluation(
      publisher.cdp,
      "publisher debug state",
      `(() => ({
        ok: typeof window.__conclaveGetMeetVideoDebug === "function",
        title: document.title,
        path: location.pathname,
      }))()`,
      30_000,
    );
    await waitForEvaluation(
      publisher.cdp,
      "publisher joined",
      `(() => {
        const debug = window.__conclaveGetMeetVideoDebug?.();
        return { ok: debug?.connectionState === "joined", state: debug?.connectionState };
      })()`,
      60_000,
    );
    await clickButton(publisher.cdp, "Turn on camera");
    await waitForEvaluation(
      publisher.cdp,
      "synthetic camera producer",
      `(() => {
        const debug = window.__conclaveGetMeetVideoDebug?.();
        const fixture = window.__conclaveQualityFixture;
        return {
          ok: debug?.isCameraOff === false && Boolean(debug?.videoProducer && !debug.videoProducer.closed) && (fixture?.frameId ?? -1) > 3,
          state: debug?.connectionState,
          frameId: fixture?.frameId ?? null,
        };
      })()`,
      45_000,
    );
    const initialPublisherCodecEvidence =
      await waitForPublisherOutboundEvidence(publisher, { timeoutMs: 15_000 });
    const codecTransition = {
      required: codecScenario === "native-compat",
      initialProducerId: initialPublisherCodecEvidence.producer?.id ?? null,
      initialPublisherRtc: initialPublisherCodecEvidence.rtc,
      initialPublisherPcWideRtc: initialPublisherCodecEvidence.pcWideRtc,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      finalProducerId:
        codecScenario === "all-modern"
          ? initialPublisherCodecEvidence.producer?.id ?? null
          : null,
      measurementEndProducerId: null,
      stableMediaProducerId: null,
      finalPublisherPcWideRtc: null,
      observed: codecScenario === "all-modern",
    };
    if (codecScenario === "native-compat") codecTransition.startedAt = Date.now();

    const viewerLaunchStartedAt = Date.now();
    viewer = await launchBrowser({
      label: "viewer",
      url: buildRoomUrl(roomId, `Quality Viewer ${profile.name}`),
      profile: receiverProfiles[0],
      enableSyntheticCamera: false,
      enableSyntheticAudio: true,
      codecCapabilityScenario:
        codecScenario === "native-compat" ? codecScenario : null,
    });
    const startupTracker = await evaluate(
      viewer.cdp,
      buildStartStartupTrackerExpression({
        targetHeight: profile.minimumDecodedHeight,
        pollIntervalMs: 50,
      }),
      10_000,
    );
    if (startupTracker?.ok !== true) {
      throw new Error(
        `Unable to start resolution tracker: ${JSON.stringify(startupTracker)}`,
      );
    }

    // Establish the requested receiver topology before waiting for primary
    // decode. Waiting here would leave a nominal multi-receiver run at one
    // receiver long enough to trigger the one-to-one producer handoff, making
    // startup speed decide which topology the harness actually measured.
    for (
      let receiverIndex = 2;
      receiverIndex <= receiverCount;
      receiverIndex += 1
    ) {
      const passiveReceiver = await launchBrowser({
        label: `viewer-${receiverIndex}`,
        url: buildRoomUrl(
          roomId,
          `Quality Viewer ${receiverIndex} ${profile.name}`,
        ),
        profile: receiverProfiles[receiverIndex - 1],
        enableSyntheticCamera: false,
        enableSyntheticAudio: true,
        codecCapabilityScenario:
          codecScenario === "native-compat" ? codecScenario : null,
      });
      extraViewers.push(passiveReceiver);
    }

    if (codecScenario === "native-compat") {
      const transitionEvidence = await waitForPublisherOutboundEvidence(
        publisher,
        {
          expectedMimeType: "video/VP8",
          producerIdNot: codecTransition.initialProducerId,
          timeoutMs: 15_000,
        },
      );
      codecTransition.completedAt = Date.now();
      codecTransition.durationMs =
        codecTransition.completedAt - codecTransition.startedAt;
      codecTransition.finalProducerId = transitionEvidence.producer?.id ?? null;
      codecTransition.finalPublisherPcWideRtc =
        transitionEvidence.pcWideRtc ?? null;
      codecTransition.observed = transitionEvidence.matched === true;
    }
    await waitForEvaluation(
      viewer.cdp,
      "decoded remote webcam",
      `(() => {
        const debug = window.__conclaveGetMeetVideoDebug?.();
        const videos = Array.from(document.querySelectorAll('video[data-meet-video-stream-type="webcam"]'));
        const decoded = videos.find((video) => video.videoWidth > 0 && video.videoHeight > 0 && video.srcObject instanceof MediaStream);
        return {
          ok: debug?.connectionState === "joined" && Boolean(decoded),
          state: debug?.connectionState,
          videoCount: videos.length,
          decodedWidth: decoded?.videoWidth ?? 0,
          decodedHeight: decoded?.videoHeight ?? 0,
        };
      })()`,
      60_000,
    );

    for (const passiveReceiver of extraViewers) {
      await waitForPassiveReceiver(passiveReceiver);
    }
    const receivers = [viewer, ...extraViewers];
    const receiverRuns = receivers.map((browser, index) => ({
      browser,
      index,
      label: browser.label,
      profile: receiverProfiles[index],
    }));

    const publisherTopologyReadiness =
      codecScenario === "native-compat"
        ? await waitForNativeVp8PublisherReadiness(publisher, {
            receiverCount,
            initialProducerId: codecTransition.finalProducerId,
          })
        : null;
    if (publisherTopologyReadiness) {
      emit("publisher_topology_ready", {
        profile: profile.name,
        codecScenario,
        receiverCount,
        mode: publisherTopologyReadiness.expected.mode,
        waitedMs: publisherTopologyReadiness.waitedMs,
        encodings: publisherTopologyReadiness.expected.encodings,
        producerId: publisherTopologyReadiness.observed.producerId,
        transition: publisherTopologyReadiness.transition,
        publisherRtc: publisherTopologyReadiness.observed.publisherRtc,
      });
    }

    const expectedProducerId =
      codecScenario === "native-compat"
        ? publisherTopologyReadiness?.observed?.producerId
        : codecTransition.initialProducerId;
    const expectedCodecMimeType =
      codecScenario === "native-compat" ? "video/VP8" : "video/VP9";
    if (!expectedProducerId) {
      throw new Error("Unable to bind warmup to the final publisher producer");
    }
    codecTransition.stableMediaProducerId = expectedProducerId;
    emit("profile_warmup", {
      profile: profile.name,
      warmupMs,
      binding: "producer+consumer+codec+ssrc+resolution+layer",
      receivers: receiverRuns.map((receiverRun) => ({
        label: receiverRun.label,
        profile: receiverRun.profile.name,
        minimumStableFrames: Math.max(
          4,
          Math.floor(
            (receiverRun.profile.minimumDecodedFps * warmupMs * 0.8) /
              1000,
          ),
        ),
      })),
    });
    const expectedSenderEncodingCount =
      expectedActiveVideoSenderEncodingCount({
        codecScenario,
        receiverCount,
      });
    const receiverMediaPathStabilities = await Promise.all(
      receiverRuns.map((receiverRun) => {
        const minimumDecodedFrames = Math.max(
          4,
          Math.floor(
            (receiverRun.profile.minimumDecodedFps * warmupMs * 0.8) /
              1000,
          ),
        );
        return waitForStableMediaPath({
          publisher,
          viewer: receiverRun.browser,
          expectedProducerId,
          expectedCodecMimeType,
          minimumDecodedHeight: receiverRun.profile.minimumDecodedHeight,
          requiredStableMs: warmupMs,
          minimumDecodedFrames,
          timeoutMs: Math.max(20_000, warmupMs + 16_000),
          // Every receiver is bound independently while the shared publisher
          // must retain its exact configured and active topology.
          expectedActiveSenderEncodings: expectedSenderEncodingCount,
          expectedSenderEncodingCount,
          expectedSenderEncodings:
            codecScenario === "native-compat"
              ? publisherTopologyReadiness.expected.encodings
              : null,
          expectedConsumerTemporalLayer:
            codecScenario === "native-compat" && receiverCount > 1 ? 0 : null,
        });
      }),
    );
    const unstableReceiverIndex = receiverMediaPathStabilities.findIndex(
      (stability) => stability.matched !== true,
    );
    if (unstableReceiverIndex >= 0) {
      throw new Error(
        `Timed out waiting for stable media path on ${receiverRuns[unstableReceiverIndex].label}: ${JSON.stringify(receiverMediaPathStabilities[unstableReceiverIndex])}`,
      );
    }
    const mediaPathStability = receiverMediaPathStabilities[0];
    codecTransition.stabilizedAt = Date.now();
    codecTransition.stabilityDurationMs =
      codecTransition.stabilizedAt - viewerLaunchStartedAt;
    const fixturePerformanceReset = await evaluate(
      publisher.cdp,
      `window.__conclaveQualityHarness.resetFixturePerformance()`,
      10_000,
    );
    if (fixturePerformanceReset?.ok !== true) {
      throw new Error(
        `Unable to reset source fixture performance window: ${JSON.stringify(fixturePerformanceReset)}`,
      );
    }
    const publisherHarnessStart = await readHarnessState(publisher);
    const receiverHarnessStart = await Promise.all(
      receivers.map((receiver) =>
        readHarnessState(receiver).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
          fixture: null,
          captureAudit: null,
          selectedSfuOrigin: null,
          codecCapabilities: null,
        })),
      ),
    );
    assertNoNativeAudioCapture(
      [
        { label: "publisher", state: publisherHarnessStart },
        ...receivers.map((receiver, index) => ({
          label: receiver.label,
          state: receiverHarnessStart[index],
        })),
      ],
      "measurement setup",
    );
    if (publisherHarnessStart?.fixture?.active !== true) {
      throw new Error(
        `Synthetic publisher fixture is not active: ${JSON.stringify(publisherHarnessStart?.fixture)}`,
      );
    }
    const receiverBindings = receiverMediaPathStabilities.map(
      mediaPathBindingFromStability,
    );
    const samplerArmResults = await Promise.all(
      receiverRuns.map((receiverRun, index) =>
        evaluate(
          receiverRun.browser.cdp,
          buildArmSamplerExpression({
            mode: index === 0 ? "visual" : "telemetry",
            sampleIntervalMs,
            targetTrackId: receiverBindings[index].consumerId,
            sourceFixture: publisherHarnessStart.fixture,
            mediaPathBinding: receiverBindings[index],
          }),
          10_000,
        ).catch((error) => ({
          ok: false,
          reason: "sampler-arm-evaluation-failed",
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    const failedSamplerArmIndex = samplerArmResults.findIndex(
      (result) => result?.ok !== true || result?.armed !== true,
    );
    if (failedSamplerArmIndex >= 0) {
      throw new Error(
        `Unable to arm ${receiverRuns[failedSamplerArmIndex].label} sampler: ${JSON.stringify(samplerArmResults[failedSamplerArmIndex])}`,
      );
    }
    const publisherStatsPreflight = await evaluate(
      publisher.cdp,
      `window.__conclaveQualityHarness.collectPeerConnectionStats()`,
      10_000,
    );
    let publisherSenderBindingStart = bindPublisherVideoSender(
      publisherStatsPreflight,
      {
        trackId: mediaPathStability.assessment?.publisherTrackId ?? null,
        expectedEncodings:
          mediaPathStability.assessment?.senderEncodings ?? null,
      },
    );
    if (publisherSenderBindingStart.matched !== true) {
      throw new Error(
        `Unable to bind measurement to the current publisher sender: ${JSON.stringify(publisherSenderBindingStart)}`,
      );
    }
    const measurementWindowId = `${roomId}:${repetition}:${Date.now()}`;
    const dynamicNetworkPlan = dynamicNetworkTransitionEnabled
      ? buildFutureDynamicNetworkTransitionPlan({
          windowId: measurementWindowId,
          nowEpochMs: Date.now(),
        })
      : null;
    const steadyMeasurementWindowStartedAtEpochMs = Date.now() + 3_000;
    const measurementWindow =
      dynamicNetworkPlan?.measurementWindow ??
      Object.freeze({
        version: 1,
        id: measurementWindowId,
        startedAtEpochMs: steadyMeasurementWindowStartedAtEpochMs,
        endedAtEpochMs:
          steadyMeasurementWindowStartedAtEpochMs + durationMs,
        durationMs,
      });
    let dynamicNetworkController = null;
    if (dynamicNetworkPlan) {
      const endpointBrowsers = {
        publisher,
        primaryReceiver: receiverRuns[0].browser,
        controlReceiver: receiverRuns[1].browser,
      };
      dynamicNetworkController = await startDynamicNetworkTransitionController({
        plan: dynamicNetworkPlan,
        endpoints: Object.fromEntries(
          Object.entries(endpointBrowsers).map(([endpoint, browser]) => [
            endpoint,
            { cdp: browser.dynamicNetworkCdp },
          ]),
        ),
        evaluatePage: (endpoint, expression) =>
          evaluate(endpointBrowsers[endpoint].cdp, expression, 5_000),
        waitForProductObservation: (endpoint, expression) =>
          waitForEvaluation(
            endpointBrowsers[endpoint].cdp,
            `${endpoint} product network-policy observation`,
            expression,
            1_500,
          ),
      });
    }
    let publisherWindowStartPayloadPromise = null;
    const collectPublisherWindowStartPayload = () => {
      publisherWindowStartPayloadPromise ??= collectPublisherCodecPayload(
        publisher,
        measurementWindow.id,
      );
      return publisherWindowStartPayloadPromise;
    };
    let publisherWindowEndPayloadPromise = null;
    const collectPublisherWindowEndPayload = () => {
      publisherWindowEndPayloadPromise ??= collectPublisherCodecPayload(
        publisher,
        measurementWindow.id,
      );
      return publisherWindowEndPayloadPromise;
    };
    const processDescriptors = [
      {
        browser: publisher,
        label: "publisher",
        role: "publisher",
        profile: publisherNetworkProfile,
      },
      ...receiverRuns.map((receiverRun, index) => ({
        browser: receiverRun.browser,
        label: receiverRun.label,
        role:
          index === 0
            ? "primary-visual-receiver"
            : "passive-telemetry-receiver",
        profile: receiverRun.profile,
      })),
    ];
    const [processObservers, publisherCodecObserver] = await Promise.all([
      Promise.all(
        processDescriptors.map((descriptor) =>
          startBrowserProcessObserver(descriptor.browser.browserCdp, {
            label: descriptor.label,
            measurementWindow,
            expectedBrowserPid: descriptor.browser.expectedBrowserPid,
            hardwareIdentityId:
              descriptor.browser.hardwareIdentity.hardwareIdentityId,
          }),
        ),
      ),
      startPublisherCodecObserver({
        collectPayload: (tick) =>
          tick.phase === "start"
            ? collectPublisherWindowStartPayload()
            : tick.phase === "terminal"
              ? collectPublisherWindowEndPayload()
            : collectPublisherCodecPayload(publisher, measurementWindow.id),
        binding: publisherSenderBindingStart,
        producerId: expectedProducerId,
        codecMimeType: expectedCodecMimeType,
        expectedEncodingCount: expectedSenderEncodingCount,
        measurementWindow,
        allowTrackReplacement: dynamicNetworkTransitionEnabled,
        allowEncodingParameterChanges: dynamicNetworkTransitionEnabled,
        buildAdditionalObservation: dynamicNetworkTransitionEnabled
          ? (payload, _tick, observation) => ({
              dynamicNetworkCheckpoint:
                normalizeDynamicNetworkEndpointCheckpoint(
                  payload?.dynamicNetworkRaw,
                  "publisher",
                  {
                    mediaPathBinding: publisherSenderBindingStart,
                    publisherObservation: observation,
                  },
                ),
            })
          : null,
      }),
    ]);
    if (Date.now() > measurementWindow.startedAtEpochMs - 250) {
      throw new Error("Measurement observers were not armed before the shared barrier");
    }
    const samplerBeginEvaluationTimeoutMs =
      resolveSamplerBeginEvaluationTimeoutMs(measurementWindow);
    const [samplerBeginResults, publisherStatsStart] = await Promise.all([
      Promise.all(
        receiverRuns.map((receiverRun) =>
          evaluate(
            receiverRun.browser.cdp,
            buildBeginSamplerExpression(measurementWindow),
            samplerBeginEvaluationTimeoutMs,
          ).catch((error) => ({
            ok: false,
            reason: "sampler-begin-evaluation-failed",
            error: error instanceof Error ? error.message : String(error),
          })),
        ),
      ),
      (async () => {
        await sleep(
          Math.max(0, measurementWindow.startedAtEpochMs - Date.now()),
        );
        return (await collectPublisherWindowStartPayload()).snapshot;
      })(),
    ]);
    const failedSamplerBeginIndex = samplerBeginResults.findIndex(
      (result) =>
        result?.ok !== true ||
        result?.measurementWindow?.id !== measurementWindow.id ||
        result?.measurementWindow?.startedAtEpochMs !==
          measurementWindow.startedAtEpochMs ||
        result?.measurementWindow?.endedAtEpochMs !==
          measurementWindow.endedAtEpochMs,
    );
    if (failedSamplerBeginIndex >= 0) {
      throw new Error(
        `Unable to open the shared window on ${receiverRuns[failedSamplerBeginIndex].label}: ${JSON.stringify(samplerBeginResults[failedSamplerBeginIndex])}`,
      );
    }
    const publisherStatsStartSkewMs =
      publisherStatsStart?.capturedAt - measurementWindow.startedAtEpochMs;
    if (
      !Number.isFinite(publisherStatsStartSkewMs) ||
      Math.abs(publisherStatsStartSkewMs) >
        MEASUREMENT_WINDOW_MAX_BOUNDARY_SKEW_MS
    ) {
      throw new Error(
        `Publisher stats start missed the shared window boundary by ${String(publisherStatsStartSkewMs)}ms`,
      );
    }
    publisherStatsStart.measurementWindowId = measurementWindow.id;
    publisherStatsStart.measurementBoundary = "start";
    const publisherWindowBinding = bindPublisherVideoSender(
      publisherStatsStart,
      {
        trackId: publisherSenderBindingStart.trackId,
        senderId: publisherSenderBindingStart.senderId,
        expectedEncodings:
          mediaPathStability.assessment?.senderEncodings ?? null,
      },
    );
    if (
      publisherWindowBinding.matched !== true ||
      publisherWindowBinding.connectionId !==
        publisherSenderBindingStart.connectionId ||
      publisherSenderEncodingSignature(publisherWindowBinding.parameters) !==
        publisherSenderEncodingSignature(publisherSenderBindingStart.parameters)
    ) {
      throw new Error(
        `Publisher sender changed at the shared window boundary: ${JSON.stringify(publisherWindowBinding)}`,
      );
    }
    publisherSenderBindingStart = publisherWindowBinding;
    emit("profile_measure", {
      profile: profile.name,
      receiverProfiles: receiverProfileNames,
      samplerModes: receiverRuns.map((receiverRun, index) => ({
        label: receiverRun.label,
        mode: index === 0 ? "visual" : "telemetry",
        armed: samplerArmResults[index]?.armed === true,
        started: samplerBeginResults[index]?.ok === true,
      })),
      durationMs,
      measurementWindow,
    });
    await sleep(Math.max(0, measurementWindow.endedAtEpochMs - Date.now()));
    const publisherStatsEnd =
      (await collectPublisherWindowEndPayload()).snapshot;
    const publisherStatsEndSkewMs =
      publisherStatsEnd?.capturedAt - measurementWindow.endedAtEpochMs;
    if (
      !Number.isFinite(publisherStatsEndSkewMs) ||
      Math.abs(publisherStatsEndSkewMs) >
        MEASUREMENT_WINDOW_MAX_BOUNDARY_SKEW_MS
    ) {
      throw new Error(
        `Publisher stats end missed the shared window boundary by ${String(publisherStatsEndSkewMs)}ms`,
      );
    }
    publisherStatsEnd.measurementWindowId = measurementWindow.id;
    publisherStatsEnd.measurementBoundary = "end";
    // Ordered teardown: receiver sampling and its worker drain finish first,
    // publisher codec observation remains live through that boundary, and the
    // continuous process envelope is always the final observer to stop.
    const receiverSamplerMeasurements = await Promise.all(
      receiverRuns.map((receiverRun) =>
        evaluate(
          receiverRun.browser.cdp,
          buildStopSamplerExpression(measurementWindow),
          30_000,
        ).catch((error) => ({
          ok: false,
          reason: "sampler-stop-evaluation-failed",
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    const publisherCodecObservationWindow =
      await publisherCodecObserver.stop();
    const dynamicNetworkAlignedSampler = dynamicNetworkPlan
      ? buildDynamicNetworkSamplerFromAlignedObservations({
          plan: dynamicNetworkPlan,
          publisherObservationWindow: publisherCodecObservationWindow,
          primaryReceiverMeasurement: receiverSamplerMeasurements[0],
          controlReceiverMeasurement: receiverSamplerMeasurements[1],
        })
      : null;
    const dynamicNetworkControllerEvidence = dynamicNetworkController
      ? await dynamicNetworkController.stop({
          sampler: dynamicNetworkAlignedSampler,
        })
      : null;
    const processObservationWindows = await Promise.all(
      processObservers.map((observer) => observer.stop()),
    );
    const measurement = receiverSamplerMeasurements[0];
    if (!measurement || measurement.ok !== true) {
      throw new Error(`Visual sampler failed: ${JSON.stringify(measurement)}`);
    }
    const invalidWindowReceiverIndex = receiverSamplerMeasurements.findIndex(
      (receiverMeasurement) =>
        receiverMeasurement?.ok !== true ||
        receiverMeasurement?.measurementWindow?.id !== measurementWindow.id ||
        receiverMeasurement?.measurementWindow?.startedAtEpochMs !==
          measurementWindow.startedAtEpochMs ||
        receiverMeasurement?.measurementWindow?.endedAtEpochMs !==
          measurementWindow.endedAtEpochMs ||
        receiverMeasurement?.durationMs !== measurementWindow.durationMs ||
        receiverMeasurement?.measurementWindowAuthority?.valid !== true,
    );
    if (invalidWindowReceiverIndex >= 0) {
      throw new Error(
        `Receiver sampler window authority failed for ${receiverRuns[invalidWindowReceiverIndex].label}: ${JSON.stringify(receiverSamplerMeasurements[invalidWindowReceiverIndex]?.measurementWindowAuthority ?? receiverSamplerMeasurements[invalidWindowReceiverIndex])}`,
      );
    }
    measurement.mediaPathStability = mediaPathStability;
    measurement.receiverMediaPathStability = receiverMediaPathStabilities;
    measurement.publisherTopologyReadiness = publisherTopologyReadiness;
    measurement.startup = await evaluate(
      viewer.cdp,
      buildStopStartupTrackerExpression(),
      10_000,
    );
    const publisherHarnessEnd = await readHarnessState(publisher);
    const publisherSourceLatencyEvidence = await evaluate(
      publisher.cdp,
      `window.__conclaveQualityHarness.getSourceLatencyEvidence()`,
      10_000,
    );
    const receiverHarnessEnd = await Promise.all(
      receivers.map((receiver) =>
        readHarnessState(receiver).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
          fixture: null,
          captureAudit: null,
          selectedSfuOrigin: null,
          codecCapabilities: null,
        })),
      ),
    );
    const viewerHarnessEnd = receiverHarnessEnd[0];
    assertNoNativeAudioCapture(
      [
        { label: "publisher", state: publisherHarnessEnd },
        ...receivers.map((receiver, index) => ({
          label: receiver.label,
          state: receiverHarnessEnd[index],
        })),
      ],
      "measurement",
    );
    const publisherDebug = await evaluate(
      publisher.cdp,
      `(() => {
        const state = window.__conclaveGetMeetVideoDebug?.();
        return {
          connectionState: state?.connectionState ?? null,
          network: state?.network ?? null,
          adaptivePublish: state?.adaptivePublish ?? null,
          videoProducer: state?.videoProducer ?? null,
        };
      })()`,
    );
    codecTransition.measurementEndProducerId =
      publisherDebug?.videoProducer?.id ?? null;
    if (
      codecTransition.required &&
      codecTransition.durationMs == null &&
      codecTransition.startedAt != null
    ) {
      codecTransition.completedAt = Date.now();
      codecTransition.durationMs =
        codecTransition.completedAt - codecTransition.startedAt;
    }
    const publisherPcWideRtc = summarizePublisherVideoStats(
      publisherStatsStart,
      publisherStatsEnd,
      measurement.durationMs ?? durationMs,
    );
    const publisherRtc = summarizePublisherVideoSenderStats(
      publisherStatsStart,
      publisherStatsEnd,
      measurement.durationMs ?? durationMs,
      {
        trackId: publisherSenderBindingStart.trackId,
        senderId: publisherSenderBindingStart.senderId,
        expectedEncodings: dynamicNetworkTransitionEnabled
          ? null
          : mediaPathStability.assessment?.senderEncodings ?? null,
        allowTrackReplacement: dynamicNetworkTransitionEnabled,
      },
    );
    const finalPublisherTopologyAssessment =
      codecScenario === "native-compat"
        ? assessNativeVp8PublisherReadiness({
            receiverCount,
            adaptivePublish: publisherDebug?.adaptivePublish ?? null,
            publisherRtc,
            initialProducerId: codecTransition.finalProducerId,
          })
        : null;
    if (publisherTopologyReadiness) {
      measurement.publisherTopologyReadiness = {
        ...publisherTopologyReadiness,
        finalAssessment: finalPublisherTopologyAssessment,
        remainedReady:
          finalPublisherTopologyAssessment?.ready === true &&
          finalPublisherTopologyAssessment.observed?.producerId ===
            expectedProducerId,
      };
      measurement.publisherTopologyTransition = {
        readiness: publisherTopologyReadiness.transition,
        measurementEnd: finalPublisherTopologyAssessment?.transition ?? null,
        boundProducerId: expectedProducerId,
      };
    }
    measurement.publisher = {
      debug: publisherDebug,
      fixture: {
        start: publisherHarnessStart.fixture,
        end: publisherHarnessEnd.fixture,
        performanceWindowReset: fixturePerformanceReset,
        captureToDisplaySource: publisherSourceLatencyEvidence,
        stable:
          publisherHarnessStart.fixture?.width ===
            publisherHarnessEnd.fixture?.width &&
          publisherHarnessStart.fixture?.height ===
            publisherHarnessEnd.fixture?.height &&
          publisherHarnessStart.fixture?.fps === publisherHarnessEnd.fixture?.fps,
      },
      rtc: publisherRtc,
      pcWideRtcDiagnostics: publisherPcWideRtc,
      senderBinding: {
        start: publisherSenderBindingStart,
        end: publisherRtc.binding,
      },
      peerConnectionStats: {
        measurementWindowId: measurementWindow.id,
        start: publisherStatsStart,
        end: publisherStatsEnd,
      },
    };
    const receiverDebugEnd = await Promise.all(
      receiverRuns.map((receiverRun, index) =>
        readReceiverMeasurementDebug(
          receiverRun.browser,
          receiverBindings[index],
        ).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
          connectionState: null,
          network: null,
          adaptiveConsumers: null,
          boundConsumer: null,
          consumerGenerationResetVersion: null,
          consumerGenerationResets: null,
          renderedVideo: null,
        })),
      ),
    );
    const receiverCaptureSafety = receivers.map((receiver, index) => ({
      label: receiver.label,
      captureAudit: receiverHarnessEnd[index].captureAudit,
    }));
    const captureAudits = [
      publisherHarnessEnd.captureAudit,
      ...receiverCaptureSafety.map((entry) => entry.captureAudit),
    ];
    measurement.captureSafety = {
      publisher: publisherHarnessEnd.captureAudit,
      viewer: viewerHarnessEnd.captureAudit,
      receivers: receiverCaptureSafety,
      safe: captureAudits.every((audit) => audit?.safe === true),
      nativeAudioCaptureCalls: captureAudits.reduce(
        (total, audit) => total + (audit?.nativeAudioCallCount ?? 0),
        0,
      ),
    };
    measurement.selectedSfuOrigin =
      publisherHarnessEnd.selectedSfuOrigin ??
      publisherHarnessStart.selectedSfuOrigin ??
      receiverHarnessEnd.find((state) => state.selectedSfuOrigin)
        ?.selectedSfuOrigin ??
      receiverHarnessStart.find((state) => state.selectedSfuOrigin)
        ?.selectedSfuOrigin ??
      null;
    measurement.receivers = receiverRuns.map((receiverRun, index) => {
      const sampler = receiverSamplerMeasurements[index] ?? null;
      const binding = receiverBindings[index];
      const debug = receiverDebugEnd[index];
      const rtc = sampler?.rtc
        ? {
            ...sampler.rtc,
            receiverVideoBitrateBps:
              sampler.rtc.averageVideoBitrateBps ?? null,
            publisherVideoBitrateBps:
              publisherRtc.averageVideoBitrateBps ?? null,
          }
        : null;
      const captureToDisplayLatency = summarizeCaptureToDisplayLatency({
        sourceEvidence: publisherSourceLatencyEvidence,
        presentationEvidence: sampler?.captureToDisplayPresentation ?? null,
        cadence: sampler?.cadence ?? null,
      });
      const playout = receiverPlayoutPolicy(debug, binding);
      const network = assessNetworkRealization(
        receiverRun.profile,
        {
          rtc,
          publisher: measurement.publisher,
        },
        { publisherNetworkProfile, requireUdp },
      );
      const receiver = {
        index,
        label: receiverRun.label,
        primary: index === 0,
        profile: receiverRun.profile,
        ok: sampler?.ok === true,
        samplerVersion: sampler?.version ?? null,
        mode: sampler?.mode ?? null,
        expectedSamplerMode: index === 0 ? "visual" : "telemetry",
        samplerArm: samplerArmResults[index] ?? null,
        samplerStart: samplerBeginResults[index] ?? null,
        measurementWindow: sampler?.measurementWindow ?? null,
        measurementWindowAuthority:
          sampler?.measurementWindowAuthority ?? null,
        durationMs: sampler?.durationMs ?? null,
        targetFps: sampler?.targetFps ?? null,
        binding: sampler?.mediaPathBinding ?? null,
        stability: receiverMediaPathStabilities[index],
        rtc,
        cadence: sampler?.cadence ?? null,
        captureToDisplayPresentation:
          sampler?.captureToDisplayPresentation ?? null,
        captureToDisplayLatency,
        playout,
        network,
        connection: {
          finalState: debug?.connectionState ?? null,
          pathContinuous:
            sampler?.mediaPathBinding?.valid === true &&
            debug?.boundConsumer?.consumerId === binding.consumerId &&
            debug?.boundConsumer?.producerId === binding.producerId,
          videoSwitches: sampler?.cadence?.videoSwitches ?? null,
        },
        renderedVideo: debug?.renderedVideo ?? null,
        captureAudit: receiverHarnessEnd[index]?.captureAudit ?? null,
        samplerOverhead: sampler?.samplerOverhead ?? null,
        peerConnectionStats: sampler?.peerConnectionStats ?? null,
        consoleErrorCount: countConsoleErrors(
          receiverRun.browser.consoleEvents,
        ),
        unexpectedRecoveryCount: countUnexpectedRecoveries(
          receiverRun.browser.consoleEvents,
        ),
        sourceEvidenceReference:
          "measurement.publisher.fixture.captureToDisplaySource",
      };
      receiver.assessment = assessReceiverTelemetry({
        receiver,
        sourceEvidence: publisherSourceLatencyEvidence,
        profile: receiverRun.profile,
        durationMs: sampler?.durationMs ?? durationMs,
        targetFps: publisherHarnessStart.fixture.fps,
      });
      return receiver;
    });
    const publisherCodecPerformance = assessPublisherCodecPerformance({
      observations: publisherCodecObservationWindow.observations,
      measurementWindow,
      observerMetadata: {
        measurementWindowId: measurementWindow.id,
        armedAtEpochMs: publisherCodecObservationWindow.armedAtEpochMs,
        observerStartedAtEpochMs:
          publisherCodecObservationWindow.observerStartedAtEpochMs,
        observerStoppedAtEpochMs:
          publisherCodecObservationWindow.observerStoppedAtEpochMs,
        firstTickSkewMs:
          publisherCodecObservationWindow.firstTickSkewMs,
        terminalBoundarySkewMs:
          publisherCodecObservationWindow.terminalBoundarySkewMs,
        terminalLeadMs: publisherCodecObservationWindow.terminalLeadMs,
        lateTickCount: publisherCodecObservationWindow.lateTickCount,
        overlapTickCount:
          publisherCodecObservationWindow.overlapTickCount,
        slowSampleCount: publisherCodecObservationWindow.slowSampleCount,
        captureErrorCount:
          publisherCodecObservationWindow.captureErrorCount,
        outOfWindowCaptureCount:
          publisherCodecObservationWindow.outOfWindowCaptureCount,
        schedulerErrors: publisherCodecObservationWindow.schedulerErrors,
        observationIntervalMs:
          publisherCodecObservationWindow.observationIntervalMs,
        skippedTickCount: publisherCodecObservationWindow.skippedTickCount,
      },
      durationMs: measurementWindow.durationMs,
      limits: resolveVideoCodecPerformanceLimits(
        publisherNetworkProfile,
        "encode",
      ),
      observationIntervalMs:
        publisherCodecObservationWindow.observationIntervalMs,
      skippedTickCount: publisherCodecObservationWindow.skippedTickCount,
    });
    const receiverCodecPerformance = measurement.receivers.map(
      (receiver, index) =>
        assessReceiverCodecPerformance({
          label: receiver.label,
          observations: receiver.binding?.observations,
          binding: receiver.binding,
          startSnapshot: receiver.peerConnectionStats?.start,
          endSnapshot: receiver.peerConnectionStats?.end,
          measurementWindow,
          durationMs: measurementWindow.durationMs,
          limits: resolveVideoCodecPerformanceLimits(
            receiverRuns[index].profile,
            "decode",
          ),
        }),
    );
    for (let index = 0; index < measurement.receivers.length; index += 1) {
      measurement.receivers[index].codecPerformance =
        receiverCodecPerformance[index];
    }
    const browserProcessPerformance = processDescriptors.map(
      (descriptor, index) =>
        assessBrowserProcessPerformance({
          label: descriptor.label,
          role: descriptor.role,
          observations: processObservationWindows[index].observations,
          measurementWindow,
          observationIntervalMs:
            processObservationWindows[index].observationIntervalMs,
          scheduledObservationCount:
            processObservationWindows[index].scheduledObservationCount,
          completedObservationCount:
            processObservationWindows[index].completedObservationCount,
          skippedTickCount:
            processObservationWindows[index].skippedTickCount,
          lateTickCount: processObservationWindows[index].lateTickCount,
          overlapTickCount:
            processObservationWindows[index].overlapTickCount,
          slowCaptureCount:
            processObservationWindows[index].slowCaptureCount,
          captureErrorCount:
            processObservationWindows[index].captureErrorCount,
          maximumConcurrentCaptures:
            processObservationWindows[index].maximumConcurrentCaptures,
          maximumCoreEquivalents: resolveVideoProcessCpuLimit(
            descriptor.profile,
            descriptor.role,
            { receiverCount },
          ),
        }),
    );
    measurement.publisher.codecPerformance = publisherCodecPerformance;
    measurement.performance = assessMeetingPerformance({
      publisherCodec: publisherCodecPerformance,
      receiverCodecs: receiverCodecPerformance,
      browserProcesses: browserProcessPerformance,
      hardwareIdentities: processDescriptors.map(
        (descriptor) => descriptor.browser.hardwareIdentity,
      ),
      primarySamplerOverhead: measurement.samplerOverhead,
      measurementWindow,
      expectedReceiverCount: receiverCount,
    });
    measurement.performance.measurementWindow = {
      ...measurementWindow,
      publisherObservationIntervalMs:
        publisherCodecObservationWindow.observationIntervalMs,
      publisherSkippedTickCount:
        publisherCodecObservationWindow.skippedTickCount,
    };
    measurement.hardwareIdentity = publisher.hardwareIdentity;
    const primaryReceiver = measurement.receivers[0];
    const debug = receiverDebugEnd[0];
    measurement.clientDebug = debug;
    measurement.rtc.receiverVideoBitrateBps =
      measurement.rtc.averageVideoBitrateBps;
    measurement.rtc.publisherVideoBitrateBps =
      publisherRtc.averageVideoBitrateBps;
    measurement.captureToDisplayLatency =
      primaryReceiver.captureToDisplayLatency;
    measurement.receiverPlayoutPolicy = primaryReceiver.playout;
    measurement.networkRealization = primaryReceiver.network;
    measurement.networkProfiles = {
      publisher: publisherNetworkProfile.name,
      viewer: profile.name,
      receivers: receiverProfileNames,
    };
    measurement.receiverCount = receiverCount;
    measurement.codecNegotiation = assessCodecNegotiation({
      scenario: codecScenario,
      receiverRtc: measurement.rtc,
      publisherRtc,
      publisherSnapshot: publisherStatsEnd,
      viewerCapabilities: viewerHarnessEnd.codecCapabilities,
      transition: codecTransition,
      receiverCount,
      receiverConsumer: mediaPathStability.assessment?.consumer ?? null,
    });
    measurement.consumerGenerationReset = assessConsumerGenerationReset({
      codecScenario,
      receiverCount,
      expectedProducerId,
      receiverConsumer: mediaPathStability.assessment?.consumer ?? null,
      publisherTopologyMode:
        publisherTopologyReadiness?.expected?.mode ?? null,
      debugVersion: debug.consumerGenerationResetVersion,
      resetEntries: debug.consumerGenerationResets,
      startup: measurement.startup,
      maximumVisibleInterruptionMs:
        profile.maximumConsumerGenerationResetInterruptionMs,
      producerTopologyTransition:
        publisherTopologyReadiness?.transition ?? null,
    });
    let dynamicNetworkTransitionAssessment = null;
    if (dynamicNetworkTransitionEnabled) {
      if (!dynamicNetworkControllerEvidence) {
        throw new Error("dynamic-network controller evidence is missing");
      }
      measurement.dynamicNetworkTransition =
        buildDynamicNetworkTransitionEvidence({
          controllerEvidence: dynamicNetworkControllerEvidence,
          measurement,
          bindings: {
            publisher: {
              targetId: publisher.dynamicNetworkCdp.targetId,
              sessionId: publisher.dynamicNetworkCdp.sessionId,
            },
            primaryReceiver: {
              targetId: receiverRuns[0].browser.dynamicNetworkCdp.targetId,
              sessionId: receiverRuns[0].browser.dynamicNetworkCdp.sessionId,
            },
            controlReceiver: {
              targetId: receiverRuns[1].browser.dynamicNetworkCdp.targetId,
              sessionId: receiverRuns[1].browser.dynamicNetworkCdp.sessionId,
            },
          },
        });
      dynamicNetworkTransitionAssessment = assessDynamicNetworkTransition(
        measurement.dynamicNetworkTransition,
      );
      measurement.dynamicNetworkTransitionAssessment =
        dynamicNetworkTransitionAssessment;
    }
    const consoleErrorCount = receivers.reduce(
      (total, receiver) => total + countConsoleErrors(receiver.consoleEvents),
      0,
    );
    const unexpectedRecoveryCount = countUnexpectedRecoveries([
      ...publisher.consoleEvents,
      ...receivers.flatMap((receiver) => receiver.consoleEvents),
    ]);
    const scoringInput = {
      ...measurement,
      durationMs: measurement.durationMs ?? durationMs,
      targetFps: publisherHarnessStart.fixture.fps,
      connectionState: debug.connectionState,
      consoleErrorCount,
      unexpectedRecoveryCount,
      enforceNavigationStartup: webRuntime === "production",
      enforceFixturePhaseCoverage: true,
      enforceAlignmentCanary: true,
      enforceSceneCoverage: true,
      enforceSamplerOverhead: true,
      enforceSourceFixtureOverhead: true,
      enforcePlayoutLatency: true,
      enforceCaptureToDisplayLatency: true,
      enforceFrameCadenceGates: true,
      enforceConsumerGenerationReset: true,
      enforceAllReceiverTelemetry: true,
      enforcePerformanceEvidence: true,
      enforcePublisherBandwidthAuthority: true,
      codecScenario,
      sourceFixturePerformance: publisherHarnessEnd.fixture?.performance ?? null,
    };
    const scoring = scoreVideoQualityRun(scoringInput, profile);
    if (dynamicNetworkTransitionAssessment) {
      scoring.assessmentMode = DYNAMIC_NETWORK_TRANSITION_RUN_MODE;
      scoring.standardProfileAssessment = {
        harnessValid: scoring.harnessValid,
        passed: scoring.passed,
        failures: [...scoring.failures],
        harnessFailures: [...scoring.harnessFailures],
        productFailures: [...scoring.productFailures],
      };
      scoring.harnessFailures = [
        ...dynamicNetworkTransitionAssessment.harnessFailures,
      ];
      scoring.productFailures = [
        ...dynamicNetworkTransitionAssessment.productFailures,
      ];
      scoring.failures = [
        ...scoring.harnessFailures,
        ...scoring.productFailures,
      ];
      scoring.harnessValid = dynamicNetworkTransitionAssessment.valid;
      scoring.passed = dynamicNetworkTransitionAssessment.passed;
    }
    const addHarnessFailure = (failure) => {
      scoring.harnessFailures.push(failure);
      scoring.failures.push(failure);
      scoring.harnessValid = false;
    };
    const addProductFailure = (failure) => {
      scoring.productFailures.push(failure);
      scoring.failures.push(failure);
    };
    if (measurement.captureSafety.safe !== true) {
      addHarnessFailure(
        "publisher/receiver capture-safety evidence is missing or unsafe",
      );
    }
    if (
      !dynamicNetworkTransitionEnabled &&
      measurement.mediaPathBinding?.valid !== true
    ) {
      addHarnessFailure(
        "bound producer/consumer/codec/SSRC/layer changed during measurement",
      );
    }
    if (!dynamicNetworkTransitionEnabled) {
      for (const failure of measurement.codecNegotiation.failures) {
        addProductFailure(failure);
      }
    }
    if (
      !dynamicNetworkTransitionEnabled &&
      finalPublisherTopologyAssessment &&
      (finalPublisherTopologyAssessment.ready !== true ||
        finalPublisherTopologyAssessment.observed?.producerId !==
          expectedProducerId)
    ) {
      for (const failure of finalPublisherTopologyAssessment.reasons) {
        addProductFailure(`final native VP8 topology: ${failure}`);
      }
      if (
        finalPublisherTopologyAssessment.observed?.producerId !==
        expectedProducerId
      ) {
        addProductFailure(
          `final native VP8 topology: producer changed from bound ${expectedProducerId} to ${finalPublisherTopologyAssessment.observed?.producerId ?? "missing"}`,
        );
      }
    }
    const silentBrowserLifecycle = await closeProfileBrowsers();
    if (silentBrowserLifecycle.safe !== true) {
      addHarnessFailure(
        "silent-browser lifecycle did not prove exact-headless zero-output operation and complete cleanup",
      );
    }
    scoring.passed = scoring.failures.length === 0;

    const worstRemoteFrame = writeDataUrl(
      measurement.worstFrame?.remoteDataUrl,
      join(profileDirectory, "worst-remote.png"),
    );
    const worstExpectedFrame = writeDataUrl(
      measurement.worstFrame?.expectedDataUrl,
      join(profileDirectory, "worst-expected.png"),
    );
    const worstDifferenceFrame = writeDataUrl(
      measurement.worstFrame?.differencePngDataUrl,
      join(profileDirectory, "worst-difference.png"),
    );
    const quantileArtifacts = {};
    for (const quantile of ["worst", "p10", "median", "best"]) {
      const frame = measurement.auditFrames?.[quantile];
      const label = quantile.toLowerCase();
      quantileArtifacts[`${quantile}RemoteFrame`] = writeDataUrl(
        frame?.remoteDataUrl,
        join(profileDirectory, `${label}-quantile-remote.png`),
      );
      quantileArtifacts[`${quantile}ExpectedFrame`] = writeDataUrl(
        frame?.expectedDataUrl,
        join(profileDirectory, `${label}-quantile-expected.png`),
      );
      quantileArtifacts[`${quantile}DifferenceFrame`] = writeDataUrl(
        frame?.differencePngDataUrl,
        join(profileDirectory, `${label}-quantile-difference.png`),
      );
      if (frame) {
        delete frame.remoteDataUrl;
        delete frame.expectedDataUrl;
        delete frame.differencePngDataUrl;
      }
    }
    if (measurement.worstFrame) {
      delete measurement.worstFrame.remoteDataUrl;
      delete measurement.worstFrame.expectedDataUrl;
      delete measurement.worstFrame.differencePngDataUrl;
    }
    for (const frame of measurement.worstFrames ?? []) {
      delete frame.receivedPngDataUrl;
      delete frame.expectedPngDataUrl;
      delete frame.differencePngDataUrl;
    }

    const reproduceCommand = dynamicNetworkTransitionEnabled
      ? "pnpm quality:video:transition"
      : `pnpm quality:video -- --profile ${profile.name} --codec-scenario ${codecScenario} --receiver-count ${receiverCount} --receiver-profiles ${receiverProfileNames.join(",")} --duration-ms ${durationMs}${requireUdp ? " --require-udp" : ""}${repetitions > 1 ? ` --repetitions ${repetitions}` : ""}`;
    const result = {
      generatedAt: new Date().toISOString(),
      harnessVersion: VIDEO_QUALITY_HARNESS_VERSION,
      runMode,
      dynamicNetworkTransitionSchemaVersion:
        dynamicNetworkTransitionEnabled
          ? DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
          : null,
      measurementContract,
      measurementContractId: measurementContract.measurementContractId,
      runId,
      roomId,
      codecScenario,
      receiverCount,
      receiverProfiles: receiverProfileNames,
      repetition,
      repetitions,
      profile,
      valid:
        scoring.harnessValid === true &&
        (dynamicNetworkTransitionEnabled
          ? dynamicNetworkTransitionAssessment?.valid === true
          : measurement.networkRealization.valid),
      safety: {
        safe:
          silentBrowserLifecycle.safe === true &&
          measurement.captureSafety.safe === true,
        headless: silentBrowserLifecycle.exactHeadless,
        chromeMuted: silentBrowserLifecycle.chromeMuted,
        pageAudioOutputSuppressed:
          silentBrowserLifecycle.pageAudioOutputSuppressed,
        microphoneUnmuted:
          silentBrowserLifecycle.zeroAudioInput === true &&
          measurement.captureSafety.nativeAudioCaptureCalls === 0
            ? false
            : null,
        syntheticAudio: silentBrowserLifecycle.zeroAudioInput,
        hardwareCaptureBlocked:
          silentBrowserLifecycle.hardwareCaptureBlocked,
        nativeAudioCaptureCalls:
          measurement.captureSafety.nativeAudioCaptureCalls,
        lifecycle: silentBrowserLifecycle,
      },
      environment: {
        webRuntime,
        navigationStartupGateEnforced: webRuntime === "production",
        selectedSfuOrigin: measurement.selectedSfuOrigin,
        browserVersion: publisher.browserVersion?.product ?? null,
        browserVersionDetails: publisher.browserVersion,
        gpuFingerprint: publisher.gpuFingerprint,
        hardwareIdentity: publisher.hardwareIdentity,
        hardwareIdentityId:
          publisher.hardwareIdentity?.hardwareIdentityId ?? null,
        browserHardwareIdentities: processDescriptors.map((descriptor) => ({
          label: descriptor.label,
          hardwareIdentityId:
            descriptor.browser.hardwareIdentity?.hardwareIdentityId ?? null,
        })),
        runtimeParameters: {
          runMode,
          dynamicNetworkTransitionSchemaVersion:
            dynamicNetworkTransitionEnabled
              ? DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
              : null,
          durationMs,
          warmupMs,
          targetFps,
          sampleIntervalMs,
          devicePixelRatio: publisher.devicePixelRatio,
          publisherNetworkProfile: publisherNetworkProfile.name,
          receiverNetworkProfile: profile.name,
          receiverProfiles: receiverProfileNames,
          receiverCount,
          requireUdp,
          platform: platform(),
          architecture: arch(),
          osRelease: release(),
        },
      },
      measurement,
      scoring,
      artifacts: {
        worstRemoteFrame,
        worstExpectedFrame,
        worstDifferenceFrame,
        ...quantileArtifacts,
      },
      browserDiagnostics: {
        publisherConsoleErrors: countConsoleErrors(publisher.consoleEvents),
        viewerConsoleErrors: countConsoleErrors(viewer.consoleEvents),
        receiverConsoleErrors: receivers.map((receiver) => ({
          label: receiver.label,
          count: countConsoleErrors(receiver.consoleEvents),
        })),
        totalReceiverConsoleErrors: consoleErrorCount,
        browserStdio: [publisher, ...receivers].map((receiver) => ({
          label: receiver.label,
          policy: "ignored",
        })),
      },
      reproduceCommand,
    };
    writeFileSync(
      join(profileDirectory, "report.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    writeFileSync(join(profileDirectory, "report.md"), buildRunMarkdown(result));
    emit("profile_result", {
      profile: profile.name,
      codecScenario,
      valid: result.valid,
      passed: result.valid && scoring.passed,
      scoringPassed: scoring.passed,
      score: scoring.score,
      grade: scoring.grade,
      failures: scoring.failures,
      realizationWarnings: measurement.networkRealization.warnings,
      repetition,
      repetitions,
    });
    if (
      silentBrowserLifecycle.processesTerminated !== true ||
      silentBrowserLifecycle.profilesRemoved !== true ||
      silentBrowserLifecycle.cleanupAuthorityReleased !== true
    ) {
      const error = new Error(
        "Silent-browser cleanup authority remains active after the profile report",
      );
      error.profileResultWritten = true;
      error.cleanupEvidence = silentBrowserLifecycle;
      throw error;
    }
    return result;
  } catch (error) {
    if (error?.profileResultWritten === true) {
      emit("profile_failure", {
        profile: profile.name,
        codecScenario,
        receiverCount,
        repetition,
        error: error.message,
        cleanupEvidence: error.cleanupEvidence,
      });
      throw error;
    }
    const receivers = [viewer, ...extraViewers].filter(Boolean);
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      roomId,
      profile: profile.name,
      codecScenario,
      receiverCount,
      repetition,
      error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? null : null,
      },
      publisher: await collectStartupFailureBrowserDiagnostics(publisher),
      receivers: await Promise.all(
        receivers.map(collectStartupFailureBrowserDiagnostics),
      ),
    };
    diagnostics.silentBrowserLifecycle = await closeProfileBrowsers();
    writeFileSync(
      join(profileDirectory, "startup-failure.json"),
      `${JSON.stringify(diagnostics, null, 2)}\n`,
    );
    emit("profile_failure", {
      profile: profile.name,
      codecScenario,
      receiverCount,
      repetition,
      error: diagnostics.error.message,
      diagnostics: join(profileDirectory, "startup-failure.json"),
    });
    if (
      diagnostics.silentBrowserLifecycle.processesTerminated !== true ||
      diagnostics.silentBrowserLifecycle.profilesRemoved !== true ||
      diagnostics.silentBrowserLifecycle.cleanupAuthorityReleased !== true
    ) {
      const cleanupError = new Error(
        "Silent-browser cleanup remained unproven after startup failure",
      );
      cleanupError.cleanupEvidence = diagnostics.silentBrowserLifecycle;
      throw new AggregateError([error, cleanupError], diagnostics.error.message);
    }
    throw error;
  } finally {
    await closeProfileBrowsers();
  }
};

const run = async () => {
  const response = await fetch(baseUrl);
  if (!response.ok) {
    throw new Error(`Web app is not reachable at ${baseUrl}`);
  }
  webRuntime = detectNextWebRuntime(await response.text());
  emit("web_runtime", {
    webRuntime,
    navigationStartupGateEnforced: webRuntime === "production",
  });
  const results = [];
  for (const profileName of profileNames) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      results.push(
        await runProfile(
          getVideoQualityProfile(profileName, codecScenario),
          repetition,
        ),
      );
    }
  }
  const repeatability = summarizeRepeatability(results);
  const repeatabilityHardwareValid = repeatability.every(
    (entry) => entry.runs <= 1 || entry.hardwareConsistent === true,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    harnessVersion: VIDEO_QUALITY_HARNESS_VERSION,
    runMode,
    dynamicNetworkTransitionSchemaVersion: dynamicNetworkTransitionEnabled
      ? DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
      : null,
    measurementContract,
    measurementContractId: measurementContract.measurementContractId,
    runId,
    baseUrl,
    codecScenario,
    receiverCount,
    requestedReceiverProfiles,
    requireUdp,
    durationMs,
    warmupMs,
    targetFps,
    sampleIntervalMs,
    repetitions,
    safety: {
      safe: results.every((result) => result.safety?.safe === true),
      headless: results.every((result) => result.safety?.headless === true),
      chromeMuted: results.every(
        (result) => result.safety?.chromeMuted === true,
      ),
      pageAudioOutputSuppressed: results.every(
        (result) => result.safety?.pageAudioOutputSuppressed === true,
      ),
      microphoneUnmuted: results.every(
        (result) => result.safety?.microphoneUnmuted === false,
      )
        ? false
        : null,
      syntheticAudio: results.every(
        (result) => result.safety?.syntheticAudio === true,
      ),
      hardwareCaptureBlocked: results.every(
        (result) => result.safety?.hardwareCaptureBlocked === true,
      ),
      finalAttestationsPassed: results.every(
        (result) =>
          result.safety?.lifecycle?.finalAttestationsPassed === true,
      ),
      processesTerminated: results.every(
        (result) => result.safety?.lifecycle?.processesTerminated === true,
      ),
      profilesRemoved: results.every(
        (result) => result.safety?.lifecycle?.profilesRemoved === true,
      ),
      cleanupAuthorityReleased: results.every(
        (result) =>
          result.safety?.lifecycle?.cleanupAuthorityReleased === true,
      ),
      stdioPolicy: "ignored",
      nativeAudioCaptureCalls: results.reduce(
        (total, result) =>
          total + (result.safety?.nativeAudioCaptureCalls ?? 0),
        0,
      ),
    },
    environment: {
      webRuntime,
      navigationStartupGateEnforced: webRuntime === "production",
      browserVersion: results[0]?.environment?.browserVersion ?? null,
      browserVersionDetails:
        results[0]?.environment?.browserVersionDetails ?? null,
      gpuFingerprint: results[0]?.environment?.gpuFingerprint ?? null,
      hardwareIdentity: results[0]?.environment?.hardwareIdentity ?? null,
      hardwareIdentityId:
        results[0]?.environment?.hardwareIdentityId ?? null,
      runtimeParameters: {
        runMode,
        dynamicNetworkTransitionSchemaVersion: dynamicNetworkTransitionEnabled
          ? DYNAMIC_NETWORK_TRANSITION_SCHEMA_VERSION
          : null,
        durationMs,
        warmupMs,
        targetFps,
        sampleIntervalMs,
        requestedDevicePixelRatio:
          Number.isFinite(requestedDevicePixelRatio) &&
          requestedDevicePixelRatio > 0
            ? requestedDevicePixelRatio
            : null,
        publisherNetworkProfile: requestedPublisherNetworkProfile,
        requestedReceiverProfiles,
        receiverCount,
        requireUdp,
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
      },
    },
    summary: summarizeMatrix(results),
    repeatability,
    repeatabilityHardwareValid,
    results,
  };
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    report.comparison = {
      baselinePath,
      ...compareQualityMatrices(report, baseline),
    };
  }
  writeFileSync(join(outputRoot, "matrix.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputRoot, "matrix.md"), buildMatrixMarkdown(report));
  emit("matrix_result", { ...report.summary, outputRoot });
  if (
    report.summary.failed > 0 ||
    report.summary.invalid > 0 ||
    report.repeatabilityHardwareValid !== true ||
    report.comparison?.regressed ||
    (baselinePath && report.comparison?.validComparison !== true)
  ) {
    process.exitCode = 1;
  }
};

const exitAfterStdoutFlush = (code) => {
  // Chromium/CDP or fetch implementations can leave keep-alive handles behind
  // after every browser process is gone. This is a CLI: once synchronous
  // reports are written and stdout is flushed, no background work is valid.
  process.stdout.write("", () => process.exit(code));
};

let retainedFatalCleanupAuthority = null;
const retainFatalCleanupAuthority = () => {
  if (!retainedFatalCleanupAuthority) {
    retainedFatalCleanupAuthority = setInterval(() => {}, 60_000);
  }
};

const handleFatalRunError = async (error) => {
  emit("fatal", { error: error.message, stack: error.stack, outputRoot });
  let cleanupOutcome = null;
  try {
    cleanupOutcome = await attemptEmergencySilentBrowserCleanup();
  } catch (cleanupError) {
    process.exitCode = 1;
    retainFatalCleanupAuthority();
    emit("fatal_cleanup_unproven", {
      error:
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
    });
    return;
  }
  if (cleanupOutcome.safeToExit !== true) {
    process.exitCode = 1;
    retainFatalCleanupAuthority();
    emit("fatal_cleanup_unproven", {
      attempts: cleanupOutcome.attempts,
      error: cleanupOutcome.lastError?.message ?? "process death is unproven",
    });
    return;
  }
  exitAfterStdoutFlush(1);
};

run().then(
  () => exitAfterStdoutFlush(process.exitCode ?? 0),
  (error) => {
    void handleFatalRunError(error).catch((cleanupError) => {
      process.exitCode = 1;
      retainFatalCleanupAuthority();
      process.stderr.write(
        `[quality-harness] fatal cleanup failed without an exit proof: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`,
      );
    });
  },
);
