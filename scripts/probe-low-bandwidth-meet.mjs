#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeHeadlessFlag =
  process.env.CONCLAVE_CHROME_HEADLESS_FLAG ?? "--headless";
const baseUrl = process.env.CONCLAVE_WEB_URL ?? "http://localhost:3000";
const roomId =
  process.env.CONCLAVE_ROOM_ID ?? `low-bandwidth-probe-${Date.now()}`;
const displayName =
  process.env.CONCLAVE_PROBE_NAME ?? "Low Bandwidth Probe";
const clientId = process.env.CONCLAVE_SFU_CLIENT_ID ?? "";
const chromePort = Number(
  process.env.CONCLAVE_CHROME_DEBUG_PORT ??
    String(9800 + Math.floor(Math.random() * 500)),
);
const scenarioNameForTimeout = (
  process.env.CONCLAVE_LOW_BANDWIDTH_SCENARIO ?? "publish"
).toLowerCase();
const timeoutMs = Number(
  process.env.CONCLAVE_LOW_BANDWIDTH_TIMEOUT_MS ??
    (scenarioNameForTimeout === "receive-many" ||
    scenarioNameForTimeout === "receive-transition"
      ? 180000
      : 90000),
);
const settleMs = Number(process.env.CONCLAVE_LOW_BANDWIDTH_SETTLE_MS ?? 22000);
const profileName = (
  process.env.CONCLAVE_LOW_BANDWIDTH_PROFILE ?? "edge"
).toLowerCase();
const scenario = scenarioNameForTimeout;
const requireCamera = !/^(0|false|no|off)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_REQUIRE_CAMERA ?? "1",
);
const requireAudio = !/^(0|false|no|off)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_REQUIRE_AUDIO ?? "1",
);
const seedStoredVideoEffects = /^(1|true|yes|on)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_RESTORE_EFFECTS ?? "0",
);
const openEffectsPanelDuringPublish = /^(1|true|yes|on)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_OPEN_EFFECTS_PANEL ?? "0",
);
const installBrowserNetworkInformation = !/^(0|false|no|off)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_INSTALL_NETWORK_INFORMATION ?? "1",
);
const expectMobileNoNetworkInformationStartup = /^(1|true|yes|on)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_EXPECT_MOBILE_NO_NETINFO_STARTUP ?? "0",
);
const publisherName =
  process.env.CONCLAVE_PUBLISHER_NAME ?? "Low Bandwidth Publisher";
const viewerName = process.env.CONCLAVE_VIEWER_NAME ?? "Low Bandwidth Viewer";

const integerEnv = (name, fallback, { min = 1, max = 12 } = {}) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}. Expected integer ${min}-${max}`,
    );
  }
  return value;
};

const profiles = {
  good: {
    expectedQuality: "good",
    connectionType: "cellular4g",
    effectiveType: "4g",
    latencyMs: 45,
    downloadKbps: 10000,
    uploadKbps: 4000,
    packetLossPercent: 0,
    packetQueueLength: 64,
    packetReordering: false,
  },
  fair: {
    expectedQuality: "fair",
    connectionType: "cellular3g",
    effectiveType: "3g",
    latencyMs: 280,
    downloadKbps: 1200,
    uploadKbps: 450,
    packetLossPercent: 2,
    packetQueueLength: 24,
    packetReordering: false,
  },
  edge: {
    expectedQuality: "poor",
    connectionType: "cellular2g",
    effectiveType: "2g",
    latencyMs: 650,
    downloadKbps: 450,
    uploadKbps: 160,
    packetLossPercent: 5,
    packetQueueLength: 12,
    packetReordering: false,
  },
  emergency: {
    expectedQuality: "poor",
    connectionType: "cellular2g",
    effectiveType: "slow-2g",
    latencyMs: 900,
    downloadKbps: 220,
    uploadKbps: 80,
    packetLossPercent: 8,
    packetQueueLength: 8,
    packetReordering: true,
  },
};

const profile = profiles[profileName];
if (!profile) {
  throw new Error(
    `Unknown CONCLAVE_LOW_BANDWIDTH_PROFILE=${profileName}. Expected one of: ${Object.keys(
      profiles,
    ).join(", ")}`,
  );
}
const validScenarios = [
  "publish",
  "receive",
  "receive-many",
  "receive-transition",
  "screen-publish",
  "screen-receive",
  "transition",
];

if (!validScenarios.includes(scenario)) {
  throw new Error(
    `Unknown CONCLAVE_LOW_BANDWIDTH_SCENARIO=${scenario}. Expected one of: ${validScenarios.join(
      ", ",
    )}`,
  );
}
const requireScreenAudio = !/^(0|false|no|off)$/i.test(
  process.env.CONCLAVE_LOW_BANDWIDTH_REQUIRE_SCREEN_AUDIO ?? "1",
);
const transitionTargetName = (
  process.env.CONCLAVE_LOW_BANDWIDTH_TRANSITION_TARGET ?? "good"
).toLowerCase();
const transitionTargetProfile = profiles[transitionTargetName];
if (
  (scenario === "transition" || scenario === "receive-transition") &&
  !transitionTargetProfile
) {
  throw new Error(
    `Unknown CONCLAVE_LOW_BANDWIDTH_TRANSITION_TARGET=${transitionTargetName}. Expected one of: ${Object.keys(
      profiles,
    ).join(", ")}`,
  );
}
const transitionSettleMs = Number(
  process.env.CONCLAVE_LOW_BANDWIDTH_TRANSITION_SETTLE_MS ?? 18000,
);
const expectStandardVideoRestore =
  transitionTargetProfile?.expectedQuality === "good" &&
  transitionSettleMs >= 50000;
const receivePublisherCount = integerEnv(
  "CONCLAVE_RECEIVE_PUBLISHERS",
  scenario === "receive-many" || scenario === "receive-transition" ? 3 : 1,
  { min: 1, max: 6 },
);
const viewportName = (
  process.env.CONCLAVE_LOW_BANDWIDTH_VIEWPORT ?? "desktop"
).toLowerCase();
const viewportPresets = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  "mobile-landscape": {
    width: 844,
    height: 390,
    deviceScaleFactor: 3,
    mobile: true,
  },
};
const viewportPreset = viewportPresets[viewportName];
if (!viewportPreset) {
  throw new Error(
    `Unknown CONCLAVE_LOW_BANDWIDTH_VIEWPORT=${viewportName}. Expected one of: ${Object.keys(
      viewportPresets,
    ).join(", ")}`,
  );
}
const viewport = {
  ...viewportPreset,
  width: integerEnv("CONCLAVE_LOW_BANDWIDTH_VIEWPORT_WIDTH", viewportPreset.width, {
    min: 240,
    max: 4096,
  }),
  height: integerEnv(
    "CONCLAVE_LOW_BANDWIDTH_VIEWPORT_HEIGHT",
    viewportPreset.height,
    { min: 240, max: 4096 },
  ),
  deviceScaleFactor: Number(
    process.env.CONCLAVE_LOW_BANDWIDTH_VIEWPORT_DPR ??
      String(viewportPreset.deviceScaleFactor),
  ),
};
if (
  !Number.isFinite(viewport.deviceScaleFactor) ||
  viewport.deviceScaleFactor <= 0
) {
  throw new Error(
    `Invalid CONCLAVE_LOW_BANDWIDTH_VIEWPORT_DPR=${JSON.stringify(
      process.env.CONCLAVE_LOW_BANDWIDTH_VIEWPORT_DPR,
    )}. Expected a positive number.`,
  );
}
const mobileUserAgent =
  process.env.CONCLAVE_LOW_BANDWIDTH_MOBILE_USER_AGENT ??
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const emit = (event, payload = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
};

const expectedAdaptiveProfile =
  profileName === "emergency" ? "emergency" : profile.expectedQuality;
const expectEmergencyMode = profileName === "emergency";
const expectedOpusPacketTimeMs = 20;
const opusMaxAverageBitrateByProfile = {
  good: 96000,
  fair: 48000,
  poor: 32000,
  emergency: 24000,
};
const microphoneOpusMaxAverageBitrateFor = ({ emergency, quality }) =>
  emergency
    ? opusMaxAverageBitrateByProfile.emergency
    : (opusMaxAverageBitrateByProfile[quality] ??
      opusMaxAverageBitrateByProfile.good);
const screenAudioOpusMaxAverageBitrateFor = ({ emergency, quality }) =>
  emergency
    ? opusMaxAverageBitrateByProfile.emergency
    : (opusMaxAverageBitrateByProfile[quality] ??
      opusMaxAverageBitrateByProfile.good);
const maxAllowedAudioBitrateFor = (maxAverageBitrate) =>
  maxAverageBitrate + 2000;
const expectedMicrophoneOpusMaxAverageBitrate =
  microphoneOpusMaxAverageBitrateFor({
    emergency: profileName === "emergency",
    quality: profile.expectedQuality,
  });
const expectedScreenAudioOpusMaxAverageBitrate =
  screenAudioOpusMaxAverageBitrateFor({
    emergency: profileName === "emergency",
    quality: profile.expectedQuality,
  });
const expectedPublishQuality = expectMobileNoNetworkInformationStartup
  ? "fair"
  : profile.expectedQuality;
const expectPublishEmergencyMode =
  !expectMobileNoNetworkInformationStartup && expectEmergencyMode;
const expectedPublishAdaptiveProfile = expectPublishEmergencyMode
  ? "emergency"
  : expectedPublishQuality;
const expectedPublishMicrophoneOpusMaxAverageBitrate =
  microphoneOpusMaxAverageBitrateFor({
    emergency: expectPublishEmergencyMode,
    quality: expectedPublishQuality,
  });
const expectedPublishScreenAudioOpusMaxAverageBitrate =
  screenAudioOpusMaxAverageBitrateFor({
    emergency: expectPublishEmergencyMode,
    quality: expectedPublishQuality,
  });
const minCrispReceiveWebcamWidth = 300;
const minCrispReceiveWebcamHeight = 160;
const adaptiveNetworkProfiles = new Set(["good", "fair", "poor", "emergency"]);

const extractAdaptiveNetworkProfile = (signature) => {
  if (typeof signature !== "string") return null;
  return (
    signature.split(":").find((part) => adaptiveNetworkProfiles.has(part)) ??
    null
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const bytesPerSecond = (kbps) => Math.max(1, Math.round((kbps * 1024) / 8));

const buildNetworkHint = (selectedProfile) => ({
  effectiveType: selectedProfile.effectiveType,
  saveData: selectedProfile.expectedQuality === "poor",
  downlink: Number((selectedProfile.downloadKbps / 1000).toFixed(2)),
  rtt: selectedProfile.latencyMs,
});

const networkHint = buildNetworkHint(profile);
const restoredVideoEffectsState = {
  background: "blur-strong",
  filter: "none",
  style: "none",
  studioLighting: false,
  studioLook: false,
  framing: false,
  customBackgroundId: null,
  customBackgroundDataUrl: null,
  customBackgroundName: null,
};
const restoredVideoEffectsStateJson = JSON.stringify(restoredVideoEffectsState);

const shellEscape = (value) => {
  const text = String(value);
  if (/^[a-zA-Z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
};

const waitForJson = async (url, label, timeout = 30000) => {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError}`);
};

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
      this.ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id && this.pending.has(message.id)) {
          const { resolve: done, reject: fail } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            fail(new Error(message.error.message));
          } else {
            done(message.result);
          }
        } else if (message.method && this.listeners.has(message.method)) {
          for (const listener of this.listeners.get(message.method)) {
            listener(message.params ?? {});
          }
        }
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.ws.close();
  }
}

const evalValue = async (cdp, expression, timeout = 5000) => {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ??
        result.exceptionDetails.exception?.description ??
        "Runtime.evaluate failed",
    );
  }
  return result.result.value;
};

const waitForEval = async (cdp, label, expression, timeout = 30000) => {
  const started = Date.now();
  let lastValue = null;
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await evalValue(cdp, expression, 3000);
      lastValue = value;
      if (value?.ok === true) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(lastValue)} ${
      lastError ? lastError.message : ""
    }`,
  );
};

const clickButton = async (cdp, label, timeout = 10000) => {
  const value = await waitForEval(
    cdp,
    `button ${label}`,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const simplify = (value) =>
        normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const readLabel = (candidate) =>
        normalize(candidate.getAttribute("aria-label")) ||
        normalize(candidate.textContent) ||
        normalize(candidate.title);
      const label = ${JSON.stringify(label)};
      const simplifiedLabel = simplify(label);
      const buttons = Array.from(document.querySelectorAll("button"));
      const findButton = (mode) => buttons.find((candidate) => {
        if (candidate.disabled) return false;
        const candidateLabel = readLabel(candidate);
        if (mode === "exact") return candidateLabel === label;
        const simplifiedCandidate = simplify(candidateLabel);
        return simplifiedCandidate === simplifiedLabel ||
          simplifiedCandidate.includes(simplifiedLabel);
      });
      const button = findButton("exact") ?? findButton("loose");
      if (!button) return { ok: false, buttons: buttons.map(readLabel).slice(0, 50) };
      button.click();
      return { ok: true, matchedLabel: readLabel(button) };
    })()`,
    timeout,
  ).catch((error) => {
    emit("click_button_skipped", { label, error: error.message });
    return { ok: false };
  });
  if (value.ok === true) {
    emit("click_button", { label, matchedLabel: value.matchedLabel ?? null });
  }
  return value.ok === true;
};

const openVideoEffectsPanel = async (cdp) => {
  let opened = await clickButton(cdp, "Backgrounds and effects", 4000);
  if (!opened) {
    const openedMenu =
      (await clickButton(cdp, "More options", 6000)) ||
      (await clickButton(cdp, "More actions", 6000));
    if (openedMenu) {
      opened = await clickButton(cdp, "Backgrounds and effects", 10000);
    }
  }
  if (!opened) {
    throw new Error("Unable to open video effects panel");
  }
  await waitForEval(
    cdp,
    "video effects panel",
    `(() => ({
      ok: Boolean(document.querySelector('[data-testid="video-effects-panel"]')),
      panelVisible: Boolean(document.querySelector('[data-testid="video-effects-panel"]')),
    }))()`,
    15000,
  );
  emit("video_effects_panel_opened", {});
};

const createPageConsoleRecorder = (label = null, events = []) => {
  return {
    events,
    record(params) {
      const text = (params.args ?? [])
        .map(
          (arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "",
        )
        .join(" ");
      if (!text) return;
      if (
        /adaptive|network|webrtc|producer|consumer|screen|display|media/i.test(
          text,
        )
      ) {
        const event = {
          ts: new Date().toISOString(),
          label,
          type: params.type,
          text,
        };
        events.push(event);
        if (events.length > 500) events.splice(0, events.length - 500);
        emit("page_console", event);
      }
    },
  };
};

const getConsoleRegressionErrors = (events, context) => {
  const clearRegressions = [
    {
      label: "direct camera republish",
      pattern: /Republished camera producer/i,
    },
    {
      label: "publish rate limit",
      pattern: /Too many media publish requests/i,
    },
    {
      label: "SDP renegotiation failure",
      pattern: /InvalidModificationError|order of m-lines|Failed to publish media/i,
    },
    {
      label: "bundled codec collision",
      pattern:
        /BUNDLE group contains a codec collision|Bundled payload type collision|codec collision.*INVALID_PARAMETER/i,
    },
  ];

  return clearRegressions.flatMap(({ label, pattern }) => {
    const matches = events.filter((event) => pattern.test(event.text));
    if (matches.length === 0) return [];
    const sample = matches
      .slice(0, 3)
      .map((event) => `${event.type ?? "log"}:${event.text}`)
      .join(" | ");
    return [
      `${context} saw ${matches.length} ${label} console event(s): ${sample}`,
    ];
  });
};

const getReceiveConsoleRegressionErrors = (events, context) => [
  ...getConsoleRegressionErrors(events, context),
  ...events
    .filter((event) => /Too many consumer control requests/i.test(event.text))
    .map(
      (event) =>
        `${context} saw consumer control rate limiting: ${event.type ?? "log"}:${event.text}`,
    ),
];

const getProbeSnapshotExpression = `(() => {
  const debug =
    typeof window.__conclaveGetMeetVideoDebug === "function"
      ? window.__conclaveGetMeetVideoDebug()
      : window.__conclaveMeetVideoDebug ?? null;
  const network = debug?.network ?? null;
	  const adaptivePublish = debug?.adaptivePublish ?? null;
	  const adaptiveConsumers = debug?.adaptiveConsumers ?? null;
	  const consumerTelemetry = Array.isArray(debug?.consumerTelemetry)
	    ? debug.consumerTelemetry
	    : [];
	  const rtcSdpDebug =
	    typeof window.__conclaveGetRtcSdpDebug === "function"
	      ? window.__conclaveGetRtcSdpDebug()
	      : { entries: [] };
	  const webcamProducer = adaptivePublish?.producers?.webcam ?? null;
  const audioProducer = adaptivePublish?.producers?.audio ?? null;
  const screenProducer = adaptivePublish?.producers?.screen ?? null;
  const screenAudioProducer = adaptivePublish?.producers?.screenAudio ?? null;
  const videoEncodings = webcamProducer?.encodings ?? [];
  const audioEncodings = audioProducer?.encodings ?? [];
  const screenEncodings = screenProducer?.encodings ?? [];
  const screenAudioEncodings = screenAudioProducer?.encodings ?? [];
  const renderedVideos =
    typeof document !== "undefined"
      ? Array.from(document.querySelectorAll("video"))
          .map((video, index) => {
            const rect = video.getBoundingClientRect();
            const style = window.getComputedStyle(video);
            const stream = video.srcObject instanceof MediaStream
              ? video.srcObject
              : null;
            const tracks = stream
              ? stream.getTracks().map((track) => {
                  let settings = {};
                  try {
                    settings = track.getSettings();
                  } catch {}
                  return {
                    id: track.id,
                    kind: track.kind,
                    label: track.label,
                    enabled: track.enabled,
                    muted: track.muted,
                    readyState: track.readyState,
                    settings,
                  };
                })
              : [];
            const visible =
              rect.width > 1 &&
              rect.height > 1 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0.01;
            const inViewport =
              visible &&
              rect.right > 0 &&
              rect.bottom > 0 &&
              rect.left < window.innerWidth &&
              rect.top < window.innerHeight;
            return {
              index,
              meetVideoStreamType: video.dataset.meetVideoStreamType ?? null,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              readyState: video.readyState,
              paused: video.paused,
              muted: video.muted,
              ended: video.ended,
              visible,
              inViewport,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              objectFit: style.objectFit,
              tracks,
            };
          })
          .filter((video) => video.tracks.length > 0)
      : [];
  const adaptivePausedVideoTiles =
    typeof document !== "undefined"
      ? Array.from(
          document.querySelectorAll('[data-meet-video-adaptively-paused="true"]'),
        ).map((tile, index) => {
          const tileRect = tile.getBoundingClientRect();
          const tileStyle = window.getComputedStyle(tile);
          const videos = Array.from(tile.querySelectorAll("video")).map(
            (video, videoIndex) => {
              const rect = video.getBoundingClientRect();
              const style = window.getComputedStyle(video);
              const stream = video.srcObject instanceof MediaStream
                ? video.srcObject
                : null;
              const tracks = stream ? stream.getTracks() : [];
              const visible =
                rect.width > 1 &&
                rect.height > 1 &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") > 0.01;
              return {
                index: videoIndex,
                attachedTrackCount: tracks.length,
                liveVideoTrackCount: tracks.filter(
                  (track) =>
                    track.kind === "video" && track.readyState === "live",
                ).length,
                readyState: video.readyState,
                videoWidth: video.videoWidth,
                videoHeight: video.videoHeight,
                visible,
                inViewport:
                  visible &&
                  rect.right > 0 &&
                  rect.bottom > 0 &&
                  rect.left < window.innerWidth &&
                  rect.top < window.innerHeight,
              };
            },
          );
          return {
            index,
            visible:
              tileRect.width > 1 &&
              tileRect.height > 1 &&
              tileStyle.display !== "none" &&
              tileStyle.visibility !== "hidden" &&
              Number(tileStyle.opacity || "1") > 0.01,
            inViewport:
              tileRect.right > 0 &&
              tileRect.bottom > 0 &&
              tileRect.left < window.innerWidth &&
              tileRect.top < window.innerHeight,
            videos,
          };
        })
      : [];
  const videoEffectsResourceNeedles = [
    "/mediapipe/tasks-vision/",
    "/mediapipe/models/",
    "/_/rtcvidproc/",
    "storage.googleapis.com/mediapipe-models",
    "@mediapipe/tasks-vision",
    "@mediapipe/selfie_segmentation",
    "@mediapipe/face_mesh",
    "face_landmarker",
    "selfie_segmenter",
    "videopipe",
    "mediapipe_simd.wasm",
    "mediapipe_jspi_simd.wasm",
  ];
  const videoEffectsNetworkResources =
    typeof performance !== "undefined" &&
    typeof performance.getEntriesByType === "function"
      ? performance
          .getEntriesByType("resource")
          .filter((entry) => {
            const name = String(entry.name ?? "");
            return videoEffectsResourceNeedles.some((needle) =>
              name.includes(needle),
            );
          })
          .map((entry) => ({
            name: String(entry.name ?? ""),
            initiatorType: entry.initiatorType ?? null,
            transferSize: Number.isFinite(entry.transferSize)
              ? entry.transferSize
              : null,
            encodedBodySize: Number.isFinite(entry.encodedBodySize)
              ? entry.encodedBodySize
              : null,
            decodedBodySize: Number.isFinite(entry.decodedBodySize)
              ? entry.decodedBodySize
              : null,
            durationMs: Number.isFinite(entry.duration)
              ? Math.round(entry.duration)
              : null,
          }))
          .slice(0, 40)
      : [];
  const displayMediaDebug =
    typeof window !== "undefined" &&
    typeof window.__conclaveGetDisplayMediaDebug === "function"
      ? window.__conclaveGetDisplayMediaDebug()
      : null;
  return {
    debugReady: Boolean(debug),
    connectionState: debug?.connectionState ?? null,
    meetError: debug?.meetError ?? null,
    isCameraOff: debug?.isCameraOff ?? null,
    activeVideoEffectsCount: debug?.activeVideoEffectsCount ?? null,
    shouldSuppressVideoEffectsForBandwidth:
      debug?.shouldSuppressVideoEffectsForBandwidth ?? null,
    shouldRunVideoEffects: debug?.shouldRunVideoEffects ?? null,
    videoEffects: debug?.videoEffects ?? null,
    publish: debug?.publish ?? null,
    videoProducer: debug?.videoProducer ?? null,
    renderedVideos,
    adaptivePausedVideoTiles,
    displayMediaDebug,
    videoEffectsNetworkResources,
    rtcSdpDebug,
    network: network
      ? {
          quality: network.quality,
          publishQuality: network.publishQuality,
          receiveQuality: network.receiveQuality,
          rtcPublishQuality: network.rtcPublishQuality,
          rtcReceiveQuality: network.rtcReceiveQuality,
          emergencyMode: network.emergencyMode,
          publishEmergencyMode: network.publishEmergencyMode,
          receiveEmergencyMode: network.receiveEmergencyMode,
          rttMs: network.rttMs,
          packetLoss: network.packetLoss,
          jitterMs: network.jitterMs,
          availableOutgoingBitrate: network.availableOutgoingBitrate,
          availableIncomingBitrate: network.availableIncomingBitrate,
          browserNetwork: network.browserNetwork,
          publishMedia: network.publishMedia,
          receiveMedia: network.receiveMedia,
        }
      : null,
    adaptiveConsumers: adaptiveConsumers
      ? {
          enabled: adaptiveConsumers.enabled,
          connectionQuality: adaptiveConsumers.connectionQuality,
          emergencyMode: adaptiveConsumers.emergencyMode,
          activeSpeakerId: adaptiveConsumers.activeSpeakerId,
          socketConnected: adaptiveConsumers.socketConnected,
          layoutHintsAvailable: adaptiveConsumers.layoutHintsAvailable,
          webcamVideoCount: adaptiveConsumers.webcamVideoCount,
          appliedCount: adaptiveConsumers.appliedCount,
          pausedCount: adaptiveConsumers.pausedCount,
          fallbackCount: adaptiveConsumers.fallbackCount,
          errorCount: adaptiveConsumers.errorCount,
          deferredCount: adaptiveConsumers.deferredCount,
          adaptivelyPausedProducerIds:
            adaptiveConsumers.adaptivelyPausedProducerIds,
          unsupportedLayerProducerIds:
            adaptiveConsumers.unsupportedLayerProducerIds,
          entries: adaptiveConsumers.entries ?? [],
        }
      : null,
    consumerTelemetry: consumerTelemetry.map((entry) => ({
      event: entry.event ?? null,
      consumerId: entry.consumerId ?? null,
      producerId: entry.producerId ?? null,
      kind: entry.kind ?? null,
      score: entry.score ?? null,
      paused: entry.paused ?? null,
      producerPaused: entry.producerPaused ?? null,
      priority: entry.priority ?? null,
      preferredLayers: entry.preferredLayers ?? null,
      currentLayers: entry.currentLayers ?? null,
      receivedAt: entry.receivedAt ?? null,
    })),
    adaptivePublish: adaptivePublish
      ? {
          enabled: adaptivePublish.enabled,
          connectionQuality: adaptivePublish.connectionQuality,
          capRecoveryQuality: adaptivePublish.capRecoveryQuality,
          emergencyMode: adaptivePublish.emergencyMode,
          videoQuality: adaptivePublish.videoQuality,
          networkManagedVideoQuality:
            adaptivePublish.networkManagedVideoQuality,
          autoDowngraded: adaptivePublish.autoDowngraded,
          updateInFlight: adaptivePublish.updateInFlight,
          lastAppliedProfiles: adaptivePublish.lastAppliedProfiles,
          qualityWindow: adaptivePublish.qualityWindow,
          capRecoveryWindow: adaptivePublish.capRecoveryWindow,
          webcamProducer,
          audioProducer,
          screenProducer,
          screenAudioProducer,
          videoEncodings,
          audioEncodings,
          screenEncodings,
          screenAudioEncodings,
        }
      : null,
  };
})()`;

const collectSnapshot = (cdp) => evalValue(cdp, getProbeSnapshotExpression);

const getRenderedVideoSummaries = (snapshot) =>
  (snapshot.renderedVideos ?? []).map((video) => ({
    index: video.index,
    meetVideoStreamType: video.meetVideoStreamType ?? null,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
    paused: video.paused,
    visible: video.visible,
    inViewport: video.inViewport,
    rect: video.rect,
    tracks: (video.tracks ?? []).map((track) => ({
      kind: track.kind,
      readyState: track.readyState,
      muted: track.muted,
      settings: track.settings,
    })),
  }));

const getVisibleRenderedVideos = (snapshot) =>
  (snapshot.renderedVideos ?? []).filter(
    (video) =>
      video.visible === true &&
      video.inViewport === true &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      (video.tracks ?? []).some(
        (track) => track.kind === "video" && track.readyState === "live",
      ),
  );

const getVisibleAdaptivePausedRenderedVideos = (snapshot) =>
  (snapshot.adaptivePausedVideoTiles ?? []).flatMap((tile) =>
    (tile.videos ?? [])
      .filter(
        (video) =>
          tile.visible === true &&
          tile.inViewport === true &&
          video.visible === true &&
          video.inViewport === true &&
          video.liveVideoTrackCount > 0,
      )
      .map((video) => ({
        tileIndex: tile.index,
        ...video,
      })),
  );

const validConsumerScoreQualities = new Set([
  "good",
  "fair",
  "poor",
  "unknown",
]);

const getScoreAwareEntryErrors = (entries) =>
  entries
    .filter(
      (entry) =>
        !Object.hasOwn(entry, "consumerScore") ||
        !validConsumerScoreQualities.has(entry.consumerScoreQuality),
    )
    .map(
      (entry) =>
        `${entry.producerId}:score=${String(
          entry.consumerScore,
        )}:quality=${String(entry.consumerScoreQuality)}`,
    );

const summarizeConsumerScoreQualities = (entries) =>
  entries.reduce(
    (counts, entry) => {
      const quality = validConsumerScoreQualities.has(
        entry.consumerScoreQuality,
      )
        ? entry.consumerScoreQuality
        : "invalid";
      counts[quality] = (counts[quality] ?? 0) + 1;
      return counts;
    },
    { good: 0, fair: 0, poor: 0, unknown: 0, invalid: 0 },
  );

const sameConsumerLayers = (left, right) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.spatialLayer === right.spatialLayer &&
    (left.temporalLayer ?? null) === (right.temporalLayer ?? null)
  );
};

const assertConsumerTelemetryEchoesPreferences = (
  snapshot,
  entries,
  errors,
  context,
) => {
  const telemetryByProducerId = new Map(
    (snapshot.consumerTelemetry ?? []).map((entry) => [entry.producerId, entry]),
  );

  for (const entry of entries) {
    const telemetry = telemetryByProducerId.get(entry.producerId);
    if (!telemetry) {
      errors.push(
        `${context} missing SFU consumer telemetry echo for ${entry.producerId}`,
      );
      continue;
    }

    if (telemetry.consumerId !== entry.consumerId) {
      errors.push(
        `${context} telemetry consumer mismatch for ${entry.producerId}: ${telemetry.consumerId} != ${entry.consumerId}`,
      );
    }
    if (telemetry.priority !== entry.priority) {
      errors.push(
        `${context} telemetry priority mismatch for ${entry.producerId}: ${telemetry.priority} != ${entry.priority}`,
      );
    }
    if (telemetry.paused !== entry.paused) {
      errors.push(
        `${context} telemetry paused mismatch for ${entry.producerId}: ${telemetry.paused} != ${entry.paused}`,
      );
    }
    if (
      entry.preferredLayers &&
      !sameConsumerLayers(telemetry.preferredLayers, entry.preferredLayers)
    ) {
      errors.push(
        `${context} telemetry preferred layers mismatch for ${entry.producerId}: ${JSON.stringify(
          telemetry.preferredLayers,
        )} != ${JSON.stringify(entry.preferredLayers)}`,
      );
    }
  }
};

const summarizeVideoEffectsNetworkResources = (snapshot) =>
  (snapshot.videoEffectsNetworkResources ?? []).map((resource) => {
    try {
      const url = new URL(resource.name);
      return url.pathname;
    } catch {
      return resource.name;
    }
  });

const assertNoVideoEffectsNetworkResources = (
  snapshot,
  errors,
  context,
  { expectedQuality = profile.expectedQuality } = {},
) => {
  if (expectedQuality === "good") return;
  const resources = snapshot.videoEffectsNetworkResources ?? [];
  if (resources.length === 0) return;
  const summary = summarizeVideoEffectsNetworkResources(snapshot)
    .slice(0, 6)
    .join(", ");
  errors.push(
    `${context} loaded video-effects assets on a constrained link without explicit effects: ${summary}`,
  );
};

const getRtpCongestionFeedbackType = (section) => {
  if ((section.ccfbCount ?? 0) > 0) return "ccfb";
  if ((section.transportCcCount ?? 0) > 0) return "transport-cc";
  return "none";
};

const getInconsistentRtpCongestionFeedbackErrors = (snapshot, context) =>
  (snapshot.rtcSdpDebug?.entries ?? [])
    .filter((entry) => entry.source === "remote")
    .flatMap((entry) => {
      const sections = (entry.sections ?? []).filter((section) =>
        ["audio", "video"].includes(section.kind),
      );
      if (sections.length < 2) return [];

      const feedbackTypes = sections.map(getRtpCongestionFeedbackType);
      const hasCongestionFeedback = feedbackTypes.some((type) => type !== "none");
      const uniqueTypes = new Set(feedbackTypes);
      if (!hasCongestionFeedback || uniqueTypes.size <= 1) return [];

      const summary = sections
        .map((section, index) => {
          const mid = section.mid ?? `section-${index}`;
          return `${section.kind}:${mid}:${feedbackTypes[index]}`;
        })
        .join(", ");

      return [
        `${context} has mixed RTP congestion feedback on pc ${entry.pcId}: ${summary}`,
      ];
    });

const findProducerOpusCodec = (producer) =>
  (producer?.codecs ?? []).find(
    (codec) => String(codec.mimeType ?? "").toLowerCase() === "audio/opus",
  ) ?? null;

const getCodecParameter = (codec, name) => {
  const parameters = codec?.parameters ?? {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(parameters)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
};

const getSdpCodecParameter = (codec, name) =>
  getCodecParameter({ parameters: codec?.fmtpParameters ?? {} }, name);

const numberCodecParameter = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
};

const isTruthyCodecParameter = (value) =>
  value === true || value === 1 || value === "1" || value === "true";

const summarizeProducerOpusCodec = (producer) => {
  const opusCodec = findProducerOpusCodec(producer);
  if (!opusCodec) return null;
  return {
    mimeType: opusCodec.mimeType,
    clockRate: opusCodec.clockRate,
    channels: opusCodec.channels ?? null,
    parameters: opusCodec.parameters ?? {},
  };
};

const findProducerPrimaryVideoCodec = (producer) =>
  (producer?.codecs ?? []).find((codec) => {
    const mimeType = String(codec?.mimeType ?? "").toLowerCase();
    return mimeType.startsWith("video/") && mimeType !== "video/rtx";
  }) ?? null;

const summarizeProducerPrimaryVideoCodec = (producer) => {
  const videoCodec = findProducerPrimaryVideoCodec(producer);
  if (!videoCodec) return null;
  return {
    mimeType: videoCodec.mimeType,
    clockRate: videoCodec.clockRate,
    channels: videoCodec.channels ?? null,
    parameters: videoCodec.parameters ?? {},
  };
};

const assertPreferredVp8ProducerCodec = (producer, errors, context) => {
  if (!producer || producer.closed) return;
  const videoCodec = findProducerPrimaryVideoCodec(producer);
  const mimeType = videoCodec?.mimeType ?? null;
  if (typeof mimeType !== "string") {
    errors.push(`${context} missing primary video codec`);
    return;
  }
  if (mimeType.toLowerCase() !== "video/vp8") {
    errors.push(`${context} expected video/VP8, got ${mimeType}`);
  }
};

const getLatestRemoteAnswerOpusAudioCodecs = (snapshot) => {
  let selected = null;
  for (const entry of snapshot.rtcSdpDebug?.entries ?? []) {
    if (entry.source !== "remote" || entry.type !== "answer") continue;
    const codecs = (entry.sections ?? [])
      .filter((section) => section.kind === "audio")
      .flatMap((section) =>
        (section.codecs ?? [])
          .filter(
            (codec) =>
              String(codec.mimeType ?? "").toLowerCase() === "audio/opus",
          )
          .map((codec) => ({
            ...codec,
            mid: section.mid ?? null,
            pcId: entry.pcId ?? null,
            at: entry.at ?? null,
          })),
      );
    if (codecs.length === 0) continue;
    if (
      !selected ||
      codecs.length > selected.codecs.length ||
      (codecs.length === selected.codecs.length &&
        Number(entry.at ?? 0) >= Number(selected.entry.at ?? 0))
    ) {
      selected = { entry, codecs };
    }
  }
  return selected?.codecs ?? [];
};

const assertNegotiatedOpusMaxAverageBitrate = (
  snapshot,
  errors,
  context,
  expectedMaxAverageBitrate,
  {
    maxAllowedForEveryAudioSection = expectedMaxAverageBitrate,
    minSections = 1,
  } = {},
) => {
  const codecs = getLatestRemoteAnswerOpusAudioCodecs(snapshot);
  if (codecs.length < minSections) {
    errors.push(
      `${context} negotiated SDP missing Opus audio sections: expected at least ${minSections}, got ${codecs.length}`,
    );
    return codecs;
  }

  const summaries = codecs.map((codec) => {
    const maxAverageBitrate = numberCodecParameter(
      getSdpCodecParameter(codec, "maxaveragebitrate"),
    );
    return {
      mid: codec.mid ?? null,
      payloadType: codec.payloadType ?? null,
      maxAverageBitrate,
    };
  });
  const missing = summaries.filter(
    (summary) => summary.maxAverageBitrate === null,
  );
  if (missing.length > 0) {
    errors.push(
      `${context} negotiated SDP missing Opus maxaveragebitrate for mids: ${missing
        .map((summary) => String(summary.mid ?? summary.payloadType ?? "unknown"))
        .join(", ")}`,
    );
  }

  if (
    !summaries.some(
      (summary) =>
        summary.maxAverageBitrate !== null &&
        summary.maxAverageBitrate <= expectedMaxAverageBitrate,
    )
  ) {
    errors.push(
      `${context} negotiated SDP has no Opus maxaveragebitrate <=${expectedMaxAverageBitrate}: ${summaries
        .map((summary) => String(summary.maxAverageBitrate))
        .join(", ")}`,
    );
  }

  const tooHigh = summaries.filter(
    (summary) =>
      summary.maxAverageBitrate !== null &&
      summary.maxAverageBitrate > maxAllowedForEveryAudioSection,
  );
  if (tooHigh.length > 0) {
    errors.push(
      `${context} negotiated SDP Opus maxaveragebitrate too high: ${tooHigh
        .map(
          (summary) =>
            `${String(summary.mid ?? summary.payloadType ?? "unknown")}=${summary.maxAverageBitrate}`,
        )
        .join(", ")}`,
    );
  }

  return codecs;
};

const assertLowBandwidthOpusCodecOptions = (
  producer,
  errors,
  context,
  expectedMaxAverageBitrate,
) => {
  if (!producer || producer.closed) return;
  const opusCodec = findProducerOpusCodec(producer);
  if (!opusCodec) {
    errors.push(`${context} missing audio/opus codec parameters`);
    return;
  }

  const fec = getCodecParameter(opusCodec, "useinbandfec");
  if (!isTruthyCodecParameter(fec)) {
    errors.push(`${context} Opus FEC not enabled: ${String(fec)}`);
  }

  const dtx = getCodecParameter(opusCodec, "usedtx");
  if (!isTruthyCodecParameter(dtx)) {
    errors.push(`${context} Opus DTX not enabled: ${String(dtx)}`);
  }

  const ptime = numberCodecParameter(getCodecParameter(opusCodec, "ptime"));
  if (ptime !== expectedOpusPacketTimeMs) {
    errors.push(
      `${context} Opus ptime expected ${expectedOpusPacketTimeMs}, got ${String(
        ptime,
      )}`,
    );
  }

  const maxAverageBitrate = numberCodecParameter(
    getCodecParameter(opusCodec, "maxaveragebitrate"),
  );
  if (
    maxAverageBitrate !== null &&
    maxAverageBitrate > expectedMaxAverageBitrate
  ) {
    errors.push(
      `${context} Opus maxaveragebitrate expected <=${expectedMaxAverageBitrate}, got ${String(
        maxAverageBitrate,
      )}`,
    );
  }

  const stereo = getCodecParameter(opusCodec, "stereo");
  const spropStereo = getCodecParameter(opusCodec, "sprop-stereo");
  if (isTruthyCodecParameter(stereo) || isTruthyCodecParameter(spropStereo)) {
    errors.push(
      `${context} Opus stereo should be disabled: stereo=${String(
        stereo,
      )} sprop-stereo=${String(spropStereo)}`,
    );
  }
};

const applyNetworkProfile = async (
  cdp,
  selectedProfileName = profileName,
  selectedProfile = profile,
) => {
  const conditions = {
    urlPattern: "",
    offline: false,
    latency: selectedProfile.latencyMs,
    downloadThroughput: bytesPerSecond(selectedProfile.downloadKbps),
    uploadThroughput: bytesPerSecond(selectedProfile.uploadKbps),
    connectionType: selectedProfile.connectionType,
    packetLoss: selectedProfile.packetLossPercent,
    packetQueueLength: selectedProfile.packetQueueLength,
    packetReordering: selectedProfile.packetReordering,
  };

  await cdp.send("Network.enable");
  try {
    const result = await cdp.send("Network.emulateNetworkConditionsByRule", {
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
    emit("network_profile_applied", {
      profileName: selectedProfileName,
      profile: selectedProfile,
      method: "Network.emulateNetworkConditionsByRule",
      ruleIds: result.ruleIds ?? [],
    });
    return;
  } catch (error) {
    emit("network_profile_modern_failed", { error: error.message });
  }

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: conditions.latency,
    downloadThroughput: conditions.downloadThroughput,
    uploadThroughput: conditions.uploadThroughput,
    connectionType: conditions.connectionType,
    packetLoss: conditions.packetLoss,
    packetQueueLength: conditions.packetQueueLength,
    packetReordering: conditions.packetReordering,
  });
  emit("network_profile_applied", {
    profileName: selectedProfileName,
    profile: selectedProfile,
    method: "Network.emulateNetworkConditions",
  });
};

const installNetworkInformationOverride = async (
  cdp,
  initialNetworkHint = networkHint,
) => {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      let hint = ${JSON.stringify(initialNetworkHint)};
      const listeners = new Set();
      const connection = {
        get effectiveType() { return hint.effectiveType; },
        get saveData() { return hint.saveData; },
        get downlink() { return hint.downlink; },
        get rtt() { return hint.rtt; },
        type: "cellular",
        addEventListener(type, listener) {
          if (type === "change" && typeof listener === "function") {
            listeners.add(listener);
          }
        },
        removeEventListener(type, listener) {
          if (type === "change") listeners.delete(listener);
        },
        dispatchEvent(event) {
          if (event?.type !== "change") return true;
          for (const listener of Array.from(listeners)) {
            try {
              listener.call(connection, event);
            } catch (error) {
              queueMicrotask(() => { throw error; });
            }
          }
          return true;
        },
      };
      const define = (target, key, value) => {
        try {
          Object.defineProperty(target, key, {
            configurable: true,
            get: () => value,
          });
          return true;
        } catch {
          return false;
        }
      };
      define(navigator, "connection", connection) ||
        define(Navigator.prototype, "connection", connection);
      define(navigator, "mozConnection", connection) ||
        define(Navigator.prototype, "mozConnection", connection);
      define(navigator, "webkitConnection", connection) ||
        define(Navigator.prototype, "webkitConnection", connection);
      define(navigator, "onLine", true) ||
        define(Navigator.prototype, "onLine", true);
      window.__conclaveSetLowBandwidthNetworkHint = (nextHint) => {
        hint = { ...hint, ...nextHint };
        window.__conclaveLowBandwidthNetworkHint = hint;
        connection.dispatchEvent(new Event("change"));
        return hint;
      };
      window.__conclaveLowBandwidthNetworkHint = hint;
    })();`,
  });
  emit("network_information_override_installed", {
    networkHint: initialNetworkHint,
  });
};

const installNetworkInformationUnavailableOverride = async (cdp) => {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const define = (target, key, value) => {
        try {
          Object.defineProperty(target, key, {
            configurable: true,
            get: () => value,
          });
          return true;
        } catch {
          return false;
        }
      };
      for (const key of ["connection", "mozConnection", "webkitConnection"]) {
        define(navigator, key, undefined) ||
          define(Navigator.prototype, key, undefined);
      }
      define(navigator, "onLine", true) ||
        define(Navigator.prototype, "onLine", true);
      window.__conclaveLowBandwidthNetworkHint = null;
    })();`,
  });
  emit("network_information_override_skipped", {
    reason: "disabled",
  });
};

const updateNetworkInformationOverride = async (
  cdp,
  selectedProfileName,
  selectedProfile,
) => {
  const nextNetworkHint = buildNetworkHint(selectedProfile);
  await evalValue(
    cdp,
    `(() => {
      if (typeof window.__conclaveSetLowBandwidthNetworkHint !== "function") {
        return { ok: false, error: "network hint setter missing" };
      }
      return {
        ok: true,
        hint: window.__conclaveSetLowBandwidthNetworkHint(${JSON.stringify(
          nextNetworkHint,
        )}),
      };
    })()`,
  );
  emit("network_information_override_updated", {
    profileName: selectedProfileName,
    networkHint: nextNetworkHint,
  });
};

const switchNetworkProfile = async (
  cdp,
  selectedProfileName,
  selectedProfile,
) => {
  await applyNetworkProfile(cdp, selectedProfileName, selectedProfile);
  await updateNetworkInformationOverride(
    cdp,
    selectedProfileName,
    selectedProfile,
  );
};

const applyProbeViewport = async (cdp, label = null) => {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  emit("viewport_applied", { label, viewportName, viewport });
};

const applyProbeUserAgent = async (cdp, label = null) => {
  if (!viewport.mobile) return;
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: mobileUserAgent,
    platform: "iPhone",
  });
  emit("user_agent_applied", { label, userAgent: mobileUserAgent });
};

const getWebcamEncodingRank = (encoding, index) => {
  const rid = typeof encoding?.rid === "string" ? encoding.rid : null;
  if (rid === "q") return 0;
  if (rid === "h") return 1;
  if (rid === "f") return 2;
  return index;
};

const getMaxActiveWebcamEncodingRankForProfile = (profile) => {
  if (profile === "good") return Number.POSITIVE_INFINITY;
  if (profile === "fair") return 1;
  return 0;
};

const getExpectedNegotiatedQuality = (browserNetworkQuality, fallback) =>
  browserNetworkQuality && browserNetworkQuality !== "unknown"
    ? browserNetworkQuality
    : fallback;

const validateMobileNoNetworkInformationStartupSnapshot = (
  snapshot,
  { consoleEvents = [] } = {},
) => {
  const errors = [];
  const network = snapshot.network;
  const browserNetwork = network?.browserNetwork ?? null;
  const adaptivePublish = snapshot.adaptivePublish;
  const webcamEncodings = adaptivePublish?.videoEncodings ?? [];
  const activeWebcamEncodingRanks = webcamEncodings
    .map((encoding, index) => ({
      index,
      rank: getWebcamEncodingRank(encoding, index),
      active: encoding.active !== false,
      rid: encoding.rid ?? null,
    }))
    .filter((encoding) => encoding.active);
  const webcamMaxBitrate = Math.max(
    0,
    ...webcamEncodings
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxBitrate) || 0),
  );
  const webcamTrackSettings = snapshot.videoProducer?.track?.settings ?? null;
  const webcamCaptureWidth = Number(webcamTrackSettings?.width) || null;
  const webcamCaptureHeight = Number(webcamTrackSettings?.height) || null;
  const webcamCaptureFrameRate = Number(webcamTrackSettings?.frameRate) || null;

  if (!viewport.mobile) {
    errors.push("startup fallback probe must use a mobile viewport");
  }
  if (installBrowserNetworkInformation) {
    errors.push("startup fallback probe must disable Network Information");
  }
  if (snapshot.connectionState !== "joined") {
    errors.push(`expected joined state, got ${snapshot.connectionState}`);
  }
  if (browserNetwork?.supported !== false) {
    errors.push(
      `expected Network Information to be unavailable, got supported=${String(
        browserNetwork?.supported,
      )}`,
    );
  }
  if (browserNetwork?.quality !== "unknown") {
    errors.push(
      `expected browser quality unknown without Network Information, got ${browserNetwork?.quality}`,
    );
  }
  if (browserNetwork?.startupQuality !== "fair") {
    errors.push(
      `expected mobile no-NetInfo startup quality fair, got ${browserNetwork?.startupQuality}`,
    );
  }
  if (browserNetwork?.emergency !== false) {
    errors.push(
      `expected no browser emergency without Network Information, got ${String(
        browserNetwork?.emergency,
      )}`,
    );
  }
  if (snapshot.shouldSuppressVideoEffectsForBandwidth !== true) {
    errors.push("expected bandwidth-heavy preloads to be suppressed");
  }
  if (snapshot.shouldRunVideoEffects !== false) {
    errors.push("video-effects pipeline ran during no-NetInfo startup");
  }
  if (!snapshot.videoProducer || snapshot.videoProducer.closed) {
    errors.push("missing live webcam producer");
  }
  if (adaptivePublish?.videoQuality !== "low") {
    errors.push(
      `expected low video quality for mobile no-NetInfo startup, got ${adaptivePublish?.videoQuality}`,
    );
  }

  if (webcamCaptureWidth !== null && webcamCaptureWidth > 700) {
    errors.push(
      `webcam startup width should be fair/low, got ${webcamCaptureWidth}`,
    );
  }
  if (webcamCaptureHeight !== null && webcamCaptureHeight > 420) {
    errors.push(
      `webcam startup height should be fair/low, got ${webcamCaptureHeight}`,
    );
  }
  if (webcamCaptureFrameRate !== null && webcamCaptureFrameRate > 22) {
    errors.push(
      `webcam startup frame rate should be capped near 20fps, got ${webcamCaptureFrameRate}`,
    );
  }

  const tooHighRank = activeWebcamEncodingRanks.filter(
    (encoding) => encoding.rank > getMaxActiveWebcamEncodingRankForProfile("fair"),
  );
  if (tooHighRank.length > 0) {
    errors.push(
      `webcam kept high startup simulcast encodings active without Network Information: ${tooHighRank
        .map((encoding) => `${encoding.rid ?? encoding.index}:${encoding.rank}`)
        .join(", ")}`,
    );
  }
  if (webcamMaxBitrate > 240000) {
    errors.push(
      `webcam startup cap too high for fair no-NetInfo profile: ${webcamMaxBitrate}`,
    );
  }

  assertNoVideoEffectsNetworkResources(
    snapshot,
    errors,
    "mobile no-NetInfo startup probe",
  );
  errors.push(
    ...getConsoleRegressionErrors(
      consoleEvents,
      "mobile no-NetInfo startup probe",
    ),
  );

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      browserNetwork,
      publishQuality: network?.publishQuality ?? null,
      rtcPublishQuality: network?.rtcPublishQuality ?? null,
      videoQuality: adaptivePublish?.videoQuality ?? null,
      webcamMaxBitrate,
      activeWebcamEncodingRanks,
      webcamTrackSettings,
      shouldSuppressVideoEffectsForBandwidth:
        snapshot.shouldSuppressVideoEffectsForBandwidth ?? null,
      shouldRunVideoEffects: snapshot.shouldRunVideoEffects ?? null,
      videoEffectsNetworkResourceCount:
        snapshot.videoEffectsNetworkResources?.length ?? 0,
      consoleRegressionEventCount: getConsoleRegressionErrors(
        consoleEvents,
        "mobile no-NetInfo startup probe",
      ).length,
    },
  };
};

const validateFinalSnapshot = (snapshot, { consoleEvents = [] } = {}) => {
  const errors = [];
  const expected = profile.expectedQuality;
  const network = snapshot.network;
  const adaptivePublish = snapshot.adaptivePublish;
  const webcamEncodings = adaptivePublish?.videoEncodings ?? [];
  const webcamProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.webcam);
  const audioProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.audio);
  const audioProducer = adaptivePublish?.audioProducer ?? null;
  const audioOpusCodec = summarizeProducerOpusCodec(audioProducer);
  const webcamVideoCodec = summarizeProducerPrimaryVideoCodec(
    adaptivePublish?.webcamProducer ?? snapshot.videoProducer ?? null,
  );
  const negotiatedOpusAudioCodecs =
    getLatestRemoteAnswerOpusAudioCodecs(snapshot);
  const webcamMaxBitrate = Math.max(
    0,
    ...webcamEncodings
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxBitrate) || 0),
  );
  const activeWebcamEncodingRanks = webcamEncodings
    .map((encoding, index) => ({
      index,
      rank: getWebcamEncodingRank(encoding, index),
      active: encoding.active !== false,
      rid: encoding.rid ?? null,
      scaleResolutionDownBy:
        typeof encoding.scaleResolutionDownBy === "number"
          ? encoding.scaleResolutionDownBy
          : null,
    }))
    .filter((encoding) => encoding.active);
  const webcamTrackSettings = snapshot.videoProducer?.track?.settings ?? null;
  const webcamCaptureWidth = Number(webcamTrackSettings?.width) || null;
  const webcamCaptureHeight = Number(webcamTrackSettings?.height) || null;
  const webcamCaptureFrameRate = Number(webcamTrackSettings?.frameRate) || null;
  const webcamEncodedWidth = Number(network?.publishMedia?.video?.frameWidth) || null;
  const webcamEncodedHeight =
    Number(network?.publishMedia?.video?.frameHeight) || null;
  const audioMaxBitrate = Math.max(
    0,
    ...(adaptivePublish?.audioEncodings ?? [])
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxBitrate) || 0),
  );
  const browserNetworkQuality = network?.browserNetwork?.quality ?? null;
  const rtcPublishQuality = network?.rtcPublishQuality ?? null;
  const publishQuality = network?.publishQuality ?? null;
  const browserNetworkMatched = browserNetworkQuality === expected;
  const rtcPublishMatched = rtcPublishQuality === expected;
  const effectiveEmergencyMode =
    network?.publishEmergencyMode === true || network?.emergencyMode === true;
  const effectiveAdaptiveProfile = effectiveEmergencyMode
    ? "emergency"
    : expectedPublishAdaptiveProfile;
  const expectedNegotiatedQuality = getExpectedNegotiatedQuality(
    browserNetworkQuality,
    expected,
  );
  const expectedNegotiatedMicrophoneOpusMaxAverageBitrate =
    microphoneOpusMaxAverageBitrateFor({
      emergency: network?.browserNetwork?.emergency === true,
      quality: expectedNegotiatedQuality,
    });

  if (snapshot.connectionState !== "joined") {
    errors.push(`expected joined state, got ${snapshot.connectionState}`);
  }
  if (!network) {
    errors.push("missing network debug snapshot");
  }
  if (!adaptivePublish?.enabled) {
    errors.push("adaptive publish hook did not enable");
  }
  if (
    !browserNetworkMatched &&
    !rtcPublishMatched &&
    publishQuality !== expected
  ) {
    errors.push(
      `expected ${expected} link from browser or RTC stats, got browser=${browserNetworkQuality} rtcPublish=${rtcPublishQuality} publish=${publishQuality}`,
    );
  }
  if (publishQuality !== expected) {
    errors.push(`expected publish quality ${expected}, got ${publishQuality}`);
  }
  if (requireCamera) {
    if (snapshot.isCameraOff !== false) {
      errors.push("camera did not turn on");
    }
    if (!snapshot.videoProducer || snapshot.videoProducer.closed) {
      errors.push("missing live webcam producer");
    }
    assertPreferredVp8ProducerCodec(
      adaptivePublish?.webcamProducer ?? snapshot.videoProducer,
      errors,
      "webcam",
    );
    if (expected === "good") {
      if (adaptivePublish?.videoQuality !== "standard") {
        errors.push(
          `expected standard video quality under ${profileName}, got ${adaptivePublish?.videoQuality}`,
        );
      }
    } else if (adaptivePublish?.videoQuality !== "low") {
      errors.push(
        `expected low video quality under ${profileName}, got ${adaptivePublish?.videoQuality}`,
      );
    }
    if (expected !== "good" && webcamProfile !== effectiveAdaptiveProfile) {
      errors.push(
        `expected ${effectiveAdaptiveProfile} webcam profile, got ${webcamProfile}`,
      );
    }
    if (expected !== "good") {
      const maxAllowedEncodingRank =
        getMaxActiveWebcamEncodingRankForProfile(effectiveAdaptiveProfile);
      const tooHighRank = activeWebcamEncodingRanks.filter(
        (encoding) => encoding.rank > maxAllowedEncodingRank,
      );
      if (tooHighRank.length > 0) {
        errors.push(
          `webcam kept high simulcast encodings active for ${effectiveAdaptiveProfile}: ${tooHighRank
            .map((encoding) => `${encoding.rid ?? encoding.index}:${encoding.rank}`)
            .join(", ")}`,
        );
      }
      const activeBaseEncoding = activeWebcamEncodingRanks.find(
        (encoding) => encoding.rank === 0,
      );
      if (
        typeof activeBaseEncoding?.scaleResolutionDownBy === "number" &&
        activeBaseEncoding?.scaleResolutionDownBy > 1
      ) {
        errors.push(
          `webcam active low-bandwidth layer is double-scaled: ${activeBaseEncoding.scaleResolutionDownBy}`,
        );
      }
    }
    if (
      expected === "poor" &&
      webcamMaxBitrate > (effectiveEmergencyMode ? 80000 : 180000)
    ) {
      errors.push(`webcam cap too high for poor profile: ${webcamMaxBitrate}`);
    } else if (expected === "fair" && webcamMaxBitrate > 240000) {
      errors.push(`webcam cap too high for fair profile: ${webcamMaxBitrate}`);
    }
    if (expected === "poor") {
      const maxCaptureWidth = effectiveEmergencyMode ? 360 : 500;
      const maxCaptureHeight = effectiveEmergencyMode ? 240 : 300;
      const maxCaptureFrameRate = effectiveEmergencyMode ? 15 : 18;
      if (
        webcamCaptureWidth !== null &&
        webcamCaptureWidth > maxCaptureWidth
      ) {
        errors.push(
          `webcam capture width too high for ${effectiveAdaptiveProfile} profile: ${webcamCaptureWidth}`,
        );
      }
      if (
        webcamCaptureHeight !== null &&
        webcamCaptureHeight > maxCaptureHeight
      ) {
        errors.push(
          `webcam capture height too high for ${effectiveAdaptiveProfile} profile: ${webcamCaptureHeight}`,
        );
      }
      if (
        webcamCaptureFrameRate !== null &&
        webcamCaptureFrameRate > maxCaptureFrameRate
      ) {
        errors.push(
          `webcam capture frame rate too high for ${effectiveAdaptiveProfile} profile: ${webcamCaptureFrameRate}`,
        );
      }
      const minEncodedWidth = effectiveEmergencyMode ? 300 : 360;
      const minEncodedHeight = effectiveEmergencyMode ? 160 : 200;
      if (
        webcamEncodedWidth !== null &&
        webcamEncodedWidth < minEncodedWidth
      ) {
        errors.push(
          `webcam encoded width too low for crisp ${effectiveAdaptiveProfile} profile: ${webcamEncodedWidth}`,
        );
      }
      if (
        webcamEncodedHeight !== null &&
        webcamEncodedHeight < minEncodedHeight
      ) {
        errors.push(
          `webcam encoded height too low for crisp ${effectiveAdaptiveProfile} profile: ${webcamEncodedHeight}`,
        );
      }
    }
  }
  if (requireAudio) {
    if (!audioProducer || audioProducer.closed) {
      errors.push("missing live audio producer");
    }
    assertLowBandwidthOpusCodecOptions(
      audioProducer,
      errors,
      "microphone",
      expectedPublishMicrophoneOpusMaxAverageBitrate,
    );
    assertNegotiatedOpusMaxAverageBitrate(
      snapshot,
      errors,
      "microphone",
      expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
      {
        maxAllowedForEveryAudioSection:
          expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
        minSections: 1,
      },
    );
    if (expected !== "good" && audioProfile !== effectiveAdaptiveProfile) {
      errors.push(
        `expected ${effectiveAdaptiveProfile} audio profile, got ${audioProfile}`,
      );
    }
    if (
      expected !== "good" &&
      audioMaxBitrate >
        maxAllowedAudioBitrateFor(expectedPublishMicrophoneOpusMaxAverageBitrate)
    ) {
      errors.push(
        `audio cap too high for ${effectiveAdaptiveProfile} profile: ${audioMaxBitrate}`,
      );
    }
  }
  if (
    expectPublishEmergencyMode &&
    network?.browserNetwork?.emergency !== true &&
    network?.emergencyMode !== true
  ) {
    errors.push("expected browser or RTC emergency mode");
  }
  if (expectPublishEmergencyMode && adaptivePublish?.emergencyMode !== true) {
    errors.push("expected adaptive publish emergency mode");
  }
  if (seedStoredVideoEffects && expected !== "good") {
    if ((snapshot.activeVideoEffectsCount ?? 0) <= 0) {
      errors.push("expected seeded stored video effect state to be active");
    }
    if (snapshot.shouldSuppressVideoEffectsForBandwidth !== true) {
      errors.push("expected restored effects to be suppressed for bandwidth");
    }
    if (snapshot.shouldRunVideoEffects !== false) {
      errors.push("restored effects pipeline ran on a constrained link");
    }
    if (snapshot.publish?.shouldPublishProcessedVideo !== false) {
      errors.push("restored effects publish path was not disabled");
    }
  }
  assertNoVideoEffectsNetworkResources(snapshot, errors, "publish probe");
  errors.push(...getConsoleRegressionErrors(consoleEvents, "publish probe"));

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      browserNetwork: network?.browserNetwork ?? null,
      networkEmergencyMode: network?.emergencyMode ?? null,
      browserNetworkMatched,
      publishQuality,
      rtcPublishQuality,
      rtcPublishMatched,
      effectiveAdaptiveProfile,
      videoQuality: adaptivePublish?.videoQuality ?? null,
      webcamProfile,
      audioProfile,
      webcamVideoCodec,
      webcamMaxBitrate,
      activeWebcamEncodingRanks,
      webcamEncodedWidth,
      webcamEncodedHeight,
      webcamTrackSettings,
      audioMaxBitrate,
      audioOpusCodec,
      negotiatedOpusAudioCodecs,
      expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
      seededStoredVideoEffects: seedStoredVideoEffects,
      activeVideoEffectsCount: snapshot.activeVideoEffectsCount ?? null,
      shouldSuppressVideoEffectsForBandwidth:
        snapshot.shouldSuppressVideoEffectsForBandwidth ?? null,
      shouldRunVideoEffects: snapshot.shouldRunVideoEffects ?? null,
      shouldPublishProcessedVideo:
        snapshot.publish?.shouldPublishProcessedVideo ?? null,
      videoEffectsNetworkResourceCount:
        snapshot.videoEffectsNetworkResources?.length ?? 0,
      videoEffectsNetworkResources:
        summarizeVideoEffectsNetworkResources(snapshot).slice(0, 6),
      consoleRegressionEventCount: getConsoleRegressionErrors(
        consoleEvents,
        "publish probe",
      ).length,
      consoleRegressionEvents: consoleEvents
        .filter((event) =>
          /Republished camera producer|Too many media publish requests|InvalidModificationError|order of m-lines|Failed to publish media/i.test(
            event.text,
          ),
        )
        .slice(0, 8),
    },
  };
};

const buildRoomUrl = (name) => {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const url = new URL(`/${encodeURIComponent(roomId)}`, normalizedBaseUrl);
  url.searchParams.set("autojoin", "1");
  url.searchParams.set("admin", "1");
  url.searchParams.set("name", name);
  if (clientId) url.searchParams.set("clientId", clientId);
  return String(url);
};

const buildDebugStorageScript = () => `(() => {
  try {
    window.localStorage.setItem("conclave:debug-video-effects", "1");
    window.localStorage.removeItem("conclave:debug-video-effects-verbose");
    ${
      seedStoredVideoEffects
        ? `window.localStorage.setItem("conclave:video-effects", ${JSON.stringify(
            restoredVideoEffectsStateJson,
          )});`
        : ""
    }
  } catch {}
})();`;

const installDebugStorage = (cdp) =>
  cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: buildDebugStorageScript(),
  });

const installRtcSdpDebug = (cdp) =>
  cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      if (window.__conclaveRtcSdpDebugInstalled) return;
      window.__conclaveRtcSdpDebugInstalled = true;
      const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (typeof PeerConnection !== "function") return;

      const peerConnectionIds = new WeakMap();
      const entries = [];
      let nextPeerConnectionId = 1;
	      const getPeerConnectionId = (pc) => {
	        if (!peerConnectionIds.has(pc)) {
	          peerConnectionIds.set(pc, nextPeerConnectionId++);
	        }
	        return peerConnectionIds.get(pc);
	      };
	      const parseFmtpParameters = (line) => {
	        const value = String(line || "").replace(/^a=fmtp:\\d+\\s*/, "");
	        return Object.fromEntries(
	          value
	            .split(";")
	            .map((part) => part.trim())
	            .filter(Boolean)
	            .map((part) => {
	              const separatorIndex = part.indexOf("=");
	              if (separatorIndex === -1) return [part.toLowerCase(), true];
	              return [
	                part.slice(0, separatorIndex).trim().toLowerCase(),
	                part.slice(separatorIndex + 1).trim(),
	              ];
	            }),
	        );
	      };
	      const summarizeSdp = (sdp) => {
	        if (typeof sdp !== "string" || sdp.length === 0) return [];
	        return sdp
	          .split(/\\r?\\nm=/)
	          .slice(1)
	          .map((rawSection) => {
            const text = "m=" + rawSection;
            const lines = text.split(/\\r?\\n/).filter(Boolean);
            const mediaLine = lines[0] || "";
            const kind = mediaLine.slice(2).split(/\\s+/)[0] || "unknown";
            const midLine = lines.find((line) => line.startsWith("a=mid:"));
	            const feedbackLines = lines.filter((line) =>
	              line.startsWith("a=rtcp-fb:"),
	            );
	            const extmapLines = lines.filter((line) => line.startsWith("a=extmap:"));
	            const fmtpLines = lines.filter((line) => line.startsWith("a=fmtp:"));
	            const codecs = lines
	              .filter((line) => line.startsWith("a=rtpmap:"))
	              .map((line) => {
	                const match = /^a=rtpmap:(\\d+)\\s+([^/\\s]+)\\/(\\d+)(?:\\/(\\d+))?/i.exec(line);
	                if (!match) return null;
	                const payloadType = Number(match[1]);
	                const fmtpLine =
	                  fmtpLines.find((candidate) =>
	                    candidate.startsWith(\`a=fmtp:\${payloadType} \`),
	                  ) ?? null;
	                return {
	                  payloadType,
	                  mimeType: \`\${kind}/\${match[2]}\`.toLowerCase(),
	                  clockRate: Number(match[3]),
	                  channels: match[4] ? Number(match[4]) : null,
	                  fmtpParameters: fmtpLine ? parseFmtpParameters(fmtpLine) : {},
	                };
	              })
	              .filter(Boolean);
	            const contains = (needle) =>
	              feedbackLines.filter((line) => line.includes(needle)).length;
	            return {
	              kind,
	              mid: midLine ? midLine.slice("a=mid:".length) : null,
              ccfbCount: contains("ack ccfb"),
              transportCcCount: contains("transport-cc"),
              googRembCount: contains("goog-remb"),
	              transportWideCcExtCount: extmapLines.filter((line) =>
	                line.includes("transport-wide-cc"),
	              ).length,
	              feedbackLines: feedbackLines.slice(0, 24),
	              fmtpLines: fmtpLines.slice(0, 16),
	              codecs,
	            };
	          });
	      };
      const recordDescription = (pc, source) => {
        try {
          const description =
            source === "local" ? pc.localDescription : pc.remoteDescription;
          if (!description?.sdp) return;
          entries.push({
            at: Date.now(),
            pcId: getPeerConnectionId(pc),
            source,
            type: description.type,
            sections: summarizeSdp(description.sdp),
          });
          if (entries.length > 60) entries.splice(0, entries.length - 60);
        } catch {}
      };

      const originalSetLocalDescription = PeerConnection.prototype.setLocalDescription;
      const originalSetRemoteDescription = PeerConnection.prototype.setRemoteDescription;
      if (typeof originalSetLocalDescription === "function") {
        PeerConnection.prototype.setLocalDescription = async function (...args) {
          const result = await originalSetLocalDescription.apply(this, args);
          recordDescription(this, "local");
          return result;
        };
      }
      if (typeof originalSetRemoteDescription === "function") {
        PeerConnection.prototype.setRemoteDescription = async function (...args) {
          const result = await originalSetRemoteDescription.apply(this, args);
          recordDescription(this, "remote");
          return result;
        };
      }

      window.__conclaveGetRtcSdpDebug = () => ({
        entries: entries.slice(),
      });
    })();`,
  });

const installFakeDisplayMediaOverride = async (cdp) => {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const install = () => {
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices || mediaDevices.__conclaveFakeDisplayMediaInstalled) {
          return Boolean(mediaDevices?.__conclaveFakeDisplayMediaInstalled);
        }

        Object.defineProperty(mediaDevices, "__conclaveFakeDisplayMediaInstalled", {
          configurable: true,
          value: true,
        });

        const displayMediaCalls = [];
        const sanitizeDisplayMediaOptions = (value, depth = 0) => {
          if (depth > 6) return "[max-depth]";
          if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            return value;
          }
          if (Array.isArray(value)) {
            return value.map((entry) =>
              sanitizeDisplayMediaOptions(entry, depth + 1),
            );
          }
          if (typeof value !== "object") return String(typeof value);
          const output = {};
          for (const [key, entry] of Object.entries(value)) {
            if (key === "controller") continue;
            output[key] = sanitizeDisplayMediaOptions(entry, depth + 1);
          }
          return output;
        };
        const readConstraintNumber = (constraint, preferredKey) => {
          if (typeof constraint === "number" && Number.isFinite(constraint)) {
            return constraint;
          }
          if (!constraint || typeof constraint !== "object") return null;
          const preferred = constraint[preferredKey];
          if (typeof preferred === "number" && Number.isFinite(preferred)) {
            return preferred;
          }
          for (const key of ["max", "ideal"]) {
            const value = constraint[key];
            if (typeof value === "number" && Number.isFinite(value)) {
              return value;
            }
          }
          return null;
        };
        window.__conclaveGetDisplayMediaDebug = () => ({
          callCount: displayMediaCalls.length,
          calls: displayMediaCalls.slice(-5),
        });

        Object.defineProperty(mediaDevices, "getDisplayMedia", {
          configurable: true,
          value: async (options = {}) => {
            displayMediaCalls.push(sanitizeDisplayMediaOptions(options));
            const canvas = document.createElement("canvas");
            canvas.width = 1920;
            canvas.height = 1080;
            const context = canvas.getContext("2d", { alpha: false });
            const requestedFrameRate = Math.max(
              1,
              Math.min(
                30,
                readConstraintNumber(options?.video?.frameRate, "max") ?? 15,
              ),
            );
            let frame = 0;
            const paint = () => {
              if (!context) return;
              const now = new Date();
              context.fillStyle = "#f8fafc";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.strokeStyle = "#0f172a";
              context.lineWidth = 2;
              for (let x = 0; x <= canvas.width; x += 120) {
                context.beginPath();
                context.moveTo(x, 0);
                context.lineTo(x, canvas.height);
                context.stroke();
              }
              for (let y = 0; y <= canvas.height; y += 90) {
                context.beginPath();
                context.moveTo(0, y);
                context.lineTo(canvas.width, y);
                context.stroke();
              }
              context.fillStyle = "#111827";
              context.font = "700 76px system-ui, sans-serif";
              context.fillText("Conclave screen share fixture", 80, 150);
              context.font = "500 42px system-ui, sans-serif";
              context.fillText("Small text should remain readable at low bandwidth.", 80, 235);
              context.font = "500 32px ui-monospace, SFMono-Regular, Menlo, monospace";
              context.fillText("Frame " + String(frame).padStart(5, "0") + " " + now.toISOString(), 80, 320);
              const left = 80 + ((frame * 18) % 1200);
              context.fillStyle = "#2563eb";
              context.fillRect(left, 390, 260, 140);
              context.fillStyle = "#16a34a";
              context.fillRect(80, 610, 360, 180);
              context.fillStyle = "#dc2626";
              context.fillRect(520, 610, 360, 180);
              context.fillStyle = "#ca8a04";
              context.fillRect(960, 610, 360, 180);
              context.fillStyle = "#111827";
              context.font = "600 28px ui-monospace, SFMono-Regular, Menlo, monospace";
              for (let index = 0; index < 12; index += 1) {
                context.fillText(
                  "row " + String(index + 1).padStart(2, "0") + "  ABCDEFGHIJKLMNOPQRSTUVWXYZ  0123456789",
                  80,
                  860 + index * 18,
                );
              }
              frame += 1;
            };

            paint();
            const interval = window.setInterval(
              paint,
              Math.max(16, Math.round(1000 / requestedFrameRate)),
            );
            const stream = canvas.captureStream(requestedFrameRate);
            const [videoTrack] = stream.getVideoTracks();
            if (videoTrack && "contentHint" in videoTrack) {
              videoTrack.contentHint = "detail";
            }

            const cleanups = [() => window.clearInterval(interval)];
            try {
              const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
              if (AudioContextCtor) {
                const audioContext = new AudioContextCtor();
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                const destination = audioContext.createMediaStreamDestination();
                oscillator.type = "sine";
                oscillator.frequency.value = 440;
                gain.gain.value = 0.015;
                oscillator.connect(gain);
                gain.connect(destination);
                oscillator.start();
                const [audioTrack] = destination.stream.getAudioTracks();
                if (audioTrack) {
                  if ("contentHint" in audioTrack) audioTrack.contentHint = "music";
                  stream.addTrack(audioTrack);
                  cleanups.push(() => {
                    try {
                      audioTrack.stop();
                    } catch {}
                  });
                }
                cleanups.push(() => {
                  try {
                    oscillator.stop();
                  } catch {}
                  void audioContext.close().catch(() => {});
                });
              }
            } catch {}

            if (videoTrack) {
              const originalStop = videoTrack.stop.bind(videoTrack);
              let stopped = false;
              const cleanup = () => {
                if (stopped) return;
                stopped = true;
                for (const fn of cleanups) {
                  try {
                    fn();
                  } catch {}
                }
              };
              videoTrack.stop = () => {
                cleanup();
                originalStop();
              };
              videoTrack.addEventListener("ended", cleanup, { once: true });
            }

            window.__conclaveFakeDisplayMediaStream = stream;
            return stream;
          },
        });
        return true;
      };

      window.__conclaveInstallFakeDisplayMedia = install;
      install();
      document.addEventListener("DOMContentLoaded", install, { once: true });
    })();`,
  });
  emit("fake_display_media_override_installed");
};

const launchProbePage = async ({
  label,
  url,
  port,
  throttled,
  fakeDisplayMedia = false,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), "conclave-low-bandwidth-"));
  const args = [
    chromeHeadlessFlag,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=MediaRouter",
    `--window-size=${viewport.width},${viewport.height}`,
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ...(fakeDisplayMedia
      ? [
          "--allow-http-screen-capture",
          "--auto-select-desktop-capture-source=Entire screen",
          "--enable-usermedia-screen-capturing",
        ]
      : []),
    "about:blank",
  ];

  emit("chrome_launch", {
    label,
    chromePath,
    chromePort: port,
    url,
    throttled,
    profileName,
    profile,
    fakeDisplayMedia,
    viewportName,
    viewport,
    command: `${shellEscape(chromePath)} ${args.map(shellEscape).join(" ")}`,
  });

  const consoleRecorder = createPageConsoleRecorder(label);
  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let chromeExited = false;
  const chromeExitPromise = new Promise((resolve) => {
    chrome.once("exit", () => {
      chromeExited = true;
      resolve();
    });
  });
  chrome.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) emit("chrome_stdout", { label, text });
  });
  chrome.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text && !text.includes("INFO:CONSOLE")) {
      const event = {
        ts: new Date().toISOString(),
        label,
        type: "stderr",
        text,
      };
      consoleRecorder.events.push(event);
      if (consoleRecorder.events.length > 500) {
        consoleRecorder.events.splice(0, consoleRecorder.events.length - 500);
      }
      emit("chrome_stderr", { label, text });
    }
  });

  let cdp = null;
  try {
    const targets = await waitForJson(
      `http://127.0.0.1:${port}/json/list`,
      `${label} Chrome target list`,
      45000,
    );
    const target = targets.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`No debuggable Chrome page target found for ${label}`);
    }

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await applyProbeViewport(cdp, label);
    await applyProbeUserAgent(cdp, label);
    cdp.on("Runtime.consoleAPICalled", (params) => {
      consoleRecorder.record(params);
    });

    if (throttled) {
      await applyNetworkProfile(cdp);
      if (installBrowserNetworkInformation) {
        await installNetworkInformationOverride(cdp);
      } else {
        await installNetworkInformationUnavailableOverride(cdp);
      }
    }
    await installRtcSdpDebug(cdp);
    await installDebugStorage(cdp);
    if (fakeDisplayMedia) {
      await installFakeDisplayMediaOverride(cdp);
    }
    await cdp.send("Page.navigate", { url });
    emit("navigate", { label, url });
    if (fakeDisplayMedia) {
      await waitForEval(
        cdp,
        `${label} fake display media override`,
        `(() => {
          const installed = window.__conclaveInstallFakeDisplayMedia?.();
          const canvas = document.createElement("canvas");
          return {
            ok: installed === true &&
              navigator.mediaDevices?.__conclaveFakeDisplayMediaInstalled === true &&
              typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
              typeof canvas.captureStream === "function",
            installed,
            hasMediaDevices: Boolean(navigator.mediaDevices),
            hasGetDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia,
            hasCaptureStream: typeof canvas.captureStream,
          };
        })()`,
        timeoutMs,
      );
    }

    return {
      label,
      cdp,
      chrome,
      chromeExited: () => chromeExited,
      chromeExitPromise,
      consoleEvents: consoleRecorder.events,
      userDataDir,
    };
  } catch (error) {
    emit("chrome_launch_failed", { label, error: error.message });
    try {
      cdp?.close();
    } catch {}
    if (!chromeExited) {
      try {
        chrome.kill("SIGTERM");
        await Promise.race([chromeExitPromise, sleep(1500)]);
        if (!chromeExited) {
          chrome.kill("SIGKILL");
          await Promise.race([chromeExitPromise, sleep(1000)]);
        }
      } catch {}
    }
    try {
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch {}
    throw error;
  }
};

const closeProbePage = async (session) => {
  if (!session) return;
  try {
    session.cdp?.close();
  } catch {}
  if (!session.chromeExited()) {
    try {
      session.chrome.kill("SIGTERM");
      await Promise.race([session.chromeExitPromise, sleep(1500)]);
      if (!session.chromeExited()) {
        session.chrome.kill("SIGKILL");
        await Promise.race([session.chromeExitPromise, sleep(1000)]);
      }
    } catch (error) {
      emit("chrome_shutdown_failed", {
        label: session.label,
        error: error.message,
      });
    }
  }
  try {
    rmSync(session.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    emit("profile_cleanup_failed", {
      label: session.label,
      path: session.userDataDir,
      error: error.message,
    });
  }
};

const waitForJoined = (cdp, label) =>
  waitForEval(
    cdp,
    `${label} meeting joined`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      return {
        ok: debug?.connectionState === "joined",
        state: debug?.connectionState ?? null,
        meetError: debug?.meetError ?? null,
      };
    })()`,
    timeoutMs,
  );

const waitForCameraProducer = (cdp, label) =>
  waitForEval(
    cdp,
    `${label} camera producer`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      return {
        ok: debug?.connectionState === "joined" &&
          debug?.isCameraOff === false &&
          Boolean(debug?.videoProducer && !debug.videoProducer.closed),
        isCameraOff: debug?.isCameraOff ?? null,
        videoProducer: debug?.videoProducer ?? null,
      };
    })()`,
    30000,
  );

const waitForScreenProducer = (cdp, label) =>
  waitForEval(
    cdp,
    `${label} screen producer`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const screen = debug?.adaptivePublish?.producers?.screen ?? null;
      const screenAudio = debug?.adaptivePublish?.producers?.screenAudio ?? null;
      return {
        ok: debug?.connectionState === "joined" &&
          Boolean(screen && !screen.closed),
        connectionState: debug?.connectionState ?? null,
        screen,
        screenAudio,
      };
    })()`,
    timeoutMs,
  );

const waitForRemoteConsumerPreferences = (
  cdp,
  expectedRemotePublisherCount,
) =>
  waitForEval(
    cdp,
    "remote adaptive consumer preferences",
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const entries = debug?.adaptiveConsumers?.entries ?? [];
      const videoEntries = entries.filter((entry) =>
        entry.kind === "video" && entry.type === "webcam"
      );
      const audioEntries = entries.filter((entry) => entry.kind === "audio");
      return {
        ok: debug?.connectionState === "joined" &&
          videoEntries.length >= ${JSON.stringify(expectedRemotePublisherCount)} &&
          audioEntries.length >= ${JSON.stringify(expectedRemotePublisherCount)},
        connectionState: debug?.connectionState ?? null,
        adaptiveConsumers: debug?.adaptiveConsumers ?? null,
        videoEntries,
        audioEntries,
      };
    })()`,
    timeoutMs,
  );

const waitForRemoteConsumerQuality = (
  cdp,
  {
    expectedRemotePublisherCount,
    expectedQuality,
    expectedEmergencyMode,
    label,
  },
) =>
  waitForEval(
    cdp,
    label,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const entries = debug?.adaptiveConsumers?.entries ?? [];
      const usableVideoEntries = entries.filter((entry) =>
        entry.kind === "video" &&
        entry.type === "webcam" &&
        (entry.status === "applied" || entry.status === "fallback")
      );
      const usableAudioEntries = entries.filter((entry) =>
        entry.kind === "audio" &&
        (entry.status === "applied" || entry.status === "fallback")
      );
      return {
        ok: debug?.connectionState === "joined" &&
          debug?.adaptiveConsumers?.connectionQuality === ${JSON.stringify(expectedQuality)} &&
          (${JSON.stringify(expectedEmergencyMode)}
            ? debug?.adaptiveConsumers?.emergencyMode === true
            : debug?.adaptiveConsumers?.emergencyMode !== true) &&
          usableVideoEntries.length >= ${JSON.stringify(expectedRemotePublisherCount)} &&
          usableAudioEntries.length >= ${JSON.stringify(expectedRemotePublisherCount)},
        connectionState: debug?.connectionState ?? null,
        adaptiveConsumers: debug?.adaptiveConsumers ?? null,
        usableVideoEntries,
        usableAudioEntries,
      };
    })()`,
    timeoutMs,
  );

const waitForRemoteScreenConsumerPreferences = (cdp) =>
  waitForEval(
    cdp,
    "remote screen adaptive consumer preferences",
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const entries = debug?.adaptiveConsumers?.entries ?? [];
      const screenVideoEntries = entries.filter((entry) =>
        entry.kind === "video" && entry.type === "screen"
      );
      const screenAudioEntries = entries.filter((entry) =>
        entry.kind === "audio" && entry.type === "screen"
      );
      return {
        ok: debug?.connectionState === "joined" &&
          screenVideoEntries.length >= 1 &&
          (${JSON.stringify(requireScreenAudio)} ? screenAudioEntries.length >= 1 : true),
        connectionState: debug?.connectionState ?? null,
        adaptiveConsumers: debug?.adaptiveConsumers ?? null,
        screenVideoEntries,
        screenAudioEntries,
      };
    })()`,
    timeoutMs,
  );

const validateReceiveSnapshot = (
  snapshot,
  {
    expectedRemotePublisherCount = 1,
    consoleEvents = [],
    expectedQuality = expectedPublishQuality,
    expectedEmergencyMode = expectEmergencyMode,
    context = "webcam receive probe",
  } = {},
) => {
  const errors = [];
  const expected = expectedQuality;
  const network = snapshot.network;
  const adaptiveConsumers = snapshot.adaptiveConsumers;
  const entries = adaptiveConsumers?.entries ?? [];
  const videoEntries = entries.filter(
    (entry) => entry.kind === "video" && entry.type === "webcam",
  );
  const audioEntries = entries.filter((entry) => entry.kind === "audio");
  const failedEntries = entries.filter((entry) => entry.status === "error");
  const deferredEntries = entries.filter(
    (entry) => entry.status === "deferred",
  );
  const usableVideoEntries = videoEntries.filter((entry) =>
    ["applied", "fallback"].includes(entry.status),
  );
  const usableAudioEntries = audioEntries.filter((entry) =>
    ["applied", "fallback"].includes(entry.status),
  );
  const visibleRenderedVideos = getVisibleRenderedVideos(snapshot);
  const visibleAdaptivePausedRenderedVideos =
    getVisibleAdaptivePausedRenderedVideos(snapshot);
  const keptEmergencyVideoEntries = usableVideoEntries.filter(
    (entry) =>
      entry.emergencyKeepVideo === true &&
      entry.requestedPaused !== true &&
      entry.paused !== true,
  );
  const pausedEmergencyVideoEntries = usableVideoEntries.filter(
    (entry) => entry.requestedPaused === true || entry.paused === true,
  );
  const scoreAwareEntryErrors = getScoreAwareEntryErrors([
    ...usableVideoEntries,
    ...usableAudioEntries,
  ]);
  const congestionFeedbackErrors = getInconsistentRtpCongestionFeedbackErrors(
    snapshot,
    context,
  );

  if (snapshot.connectionState !== "joined") {
    errors.push(`expected viewer joined state, got ${snapshot.connectionState}`);
  }
  if (!network) {
    errors.push("missing viewer network debug snapshot");
  }
  if (network?.receiveQuality !== expected) {
    errors.push(
      `expected viewer receive quality ${expected}, got ${network?.receiveQuality}`,
    );
  }
  if (!adaptiveConsumers?.enabled) {
    errors.push("adaptive consumer hook did not enable");
  }
  if (adaptiveConsumers?.connectionQuality !== expected) {
    errors.push(
      `expected adaptive consumer quality ${expected}, got ${adaptiveConsumers?.connectionQuality}`,
    );
  }
  if (expectedEmergencyMode && adaptiveConsumers?.emergencyMode !== true) {
    errors.push("expected adaptive consumer emergency mode");
  }
  if (failedEntries.length > 0) {
    errors.push(
      `adaptive consumer preference errors: ${failedEntries
        .map((entry) => `${entry.producerId}:${entry.error}`)
        .join(", ")}`,
    );
  }
  if ((adaptiveConsumers?.deferredCount ?? 0) > 0 || deferredEntries.length > 0) {
    errors.push(
      `adaptive consumer preferences still deferred after settle: ${deferredEntries
        .map((entry) => `${entry.producerId}:${entry.error ?? "deferred"}`)
        .join(", ")}`,
    );
  }
  if (usableVideoEntries.length === 0) {
    errors.push("missing applied remote webcam consumer preference");
  }
  if (usableAudioEntries.length === 0) {
    errors.push("missing applied remote audio consumer preference");
  }
  if (usableVideoEntries.length < expectedRemotePublisherCount) {
    errors.push(
      `expected at least ${expectedRemotePublisherCount} remote webcam preferences, got ${usableVideoEntries.length}`,
    );
  }
  if (usableAudioEntries.length < expectedRemotePublisherCount) {
    errors.push(
      `expected at least ${expectedRemotePublisherCount} remote audio preferences, got ${usableAudioEntries.length}`,
    );
  }
  if (visibleRenderedVideos.length < Math.min(1, expectedRemotePublisherCount)) {
    errors.push(
      `expected visible decoded remote webcam video, got ${visibleRenderedVideos.length}`,
    );
  }
  if (expected === "poor") {
    const softVisibleVideos = visibleRenderedVideos.filter(
      (video) =>
        video.videoWidth < minCrispReceiveWebcamWidth ||
        video.videoHeight < minCrispReceiveWebcamHeight,
    );
    if (softVisibleVideos.length > 0) {
      errors.push(
        `visible remote webcam decode too soft for constrained receive: ${softVisibleVideos
          .map((video) => `${video.videoWidth}x${video.videoHeight}`)
          .join(", ")}`,
      );
    }
  }
  if (visibleAdaptivePausedRenderedVideos.length > 0) {
    errors.push(
      `adaptive-paused webcam tiles still had visible attached live video: ${visibleAdaptivePausedRenderedVideos
        .map((video) => `tile=${video.tileIndex}:video=${video.index}`)
        .join(", ")}`,
    );
  }
  if (scoreAwareEntryErrors.length > 0) {
    errors.push(
      `adaptive consumer entries missing score-aware fields: ${scoreAwareEntryErrors.join(", ")}`,
    );
  }
  assertConsumerTelemetryEchoesPreferences(
    snapshot,
    [...usableVideoEntries, ...usableAudioEntries],
    errors,
    context,
  );
  errors.push(...congestionFeedbackErrors);
  errors.push(
    ...getReceiveConsoleRegressionErrors(consoleEvents, context),
  );

  for (const entry of usableVideoEntries) {
    const layers = entry.requestedLayers ?? entry.preferredLayers;
    if (
      !expectedEmergencyMode &&
      (entry.requestedPaused === true || entry.paused === true)
    ) {
      errors.push(`remote webcam was paused unexpectedly: ${entry.producerId}`);
    }
    if (expected === "poor") {
      if (!layers) {
        errors.push(`missing poor-link layer request for ${entry.producerId}`);
      } else {
        if (layers.spatialLayer !== 0) {
          errors.push(
            `expected spatial layer 0 for ${entry.producerId}, got ${layers.spatialLayer}`,
          );
        }
        const maxTemporalLayer = expectedEmergencyMode ? 0 : 1;
        if ((layers.temporalLayer ?? 0) > maxTemporalLayer) {
          errors.push(
            `expected temporal layer <=${maxTemporalLayer} for ${entry.producerId}, got ${layers.temporalLayer}`,
          );
        }
      }
      if (entry.priority > (expectedEmergencyMode ? 145 : 155)) {
        errors.push(
          `remote webcam priority too high for poor link: ${entry.priority}`,
        );
      }
    }
  }

  if (expectedEmergencyMode) {
    if (keptEmergencyVideoEntries.length !== 1) {
      errors.push(
        `expected exactly one emergency webcam kept live, got ${keptEmergencyVideoEntries.length}`,
      );
    }
    if (
      expectedRemotePublisherCount > 1 &&
      pausedEmergencyVideoEntries.length < expectedRemotePublisherCount - 1
    ) {
      errors.push(
        `expected at least ${
          expectedRemotePublisherCount - 1
        } emergency webcams paused, got ${pausedEmergencyVideoEntries.length}`,
      );
    }
  }

  for (const entry of usableAudioEntries) {
    if (entry.priority < 255) {
      errors.push(`remote audio priority not protected: ${entry.priority}`);
    }
    if (entry.paused === true || entry.requestedPaused === true) {
      errors.push(`remote audio was paused unexpectedly: ${entry.producerId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      receiveQuality: network?.receiveQuality ?? null,
      expectedQuality: expected,
      rtcReceiveQuality: network?.rtcReceiveQuality ?? null,
      browserNetwork: network?.browserNetwork ?? null,
      adaptiveConsumerQuality: adaptiveConsumers?.connectionQuality ?? null,
      emergencyMode: adaptiveConsumers?.emergencyMode ?? null,
      expectedEmergencyMode,
      videoPreferenceCount: usableVideoEntries.length,
      audioPreferenceCount: usableAudioEntries.length,
      keptEmergencyVideoCount: keptEmergencyVideoEntries.length,
      pausedEmergencyVideoCount: pausedEmergencyVideoEntries.length,
      expectedRemotePublisherCount,
      deferredCount: adaptiveConsumers?.deferredCount ?? null,
      deferredEntries: deferredEntries.slice(0, 8),
      visibleRenderedVideoCount: visibleRenderedVideos.length,
      minVisibleRenderedVideoWidth:
        visibleRenderedVideos.length > 0
          ? Math.min(...visibleRenderedVideos.map((video) => video.videoWidth))
          : null,
      minVisibleRenderedVideoHeight:
        visibleRenderedVideos.length > 0
          ? Math.min(...visibleRenderedVideos.map((video) => video.videoHeight))
          : null,
      adaptivePausedVideoTileCount:
        snapshot.adaptivePausedVideoTiles?.length ?? 0,
      visibleAdaptivePausedRenderedVideoCount:
        visibleAdaptivePausedRenderedVideos.length,
      renderedVideos: getRenderedVideoSummaries(snapshot),
      consumerTelemetryCount: (snapshot.consumerTelemetry ?? []).length,
      rtcCongestionFeedbackIssues: congestionFeedbackErrors,
      consumerScoreQualities: summarizeConsumerScoreQualities([
        ...usableVideoEntries,
        ...usableAudioEntries,
      ]),
      firstVideoPreference: usableVideoEntries[0] ?? null,
      firstAudioPreference: usableAudioEntries[0] ?? null,
      consoleRegressionEventCount: getReceiveConsoleRegressionErrors(
        consoleEvents,
        context,
      ).length,
      consoleRegressionEvents: consoleEvents
        .filter((event) =>
          /Republished camera producer|Too many media publish requests|Too many consumer control requests|InvalidModificationError|order of m-lines|Failed to publish media/i.test(
            event.text,
          ),
        )
        .slice(0, 8),
    },
  };
};

const maxActiveEncodingValue = (encodings, key) =>
  Math.max(
    0,
    ...(encodings ?? [])
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding[key]) || 0),
  );

const getConstraintNumber = (constraint, preferredKey) => {
  if (typeof constraint === "number" && Number.isFinite(constraint)) {
    return constraint;
  }
  if (!constraint || typeof constraint !== "object") return null;
  const preferred = constraint[preferredKey];
  if (typeof preferred === "number" && Number.isFinite(preferred)) {
    return preferred;
  }
  for (const key of ["max", "ideal"]) {
    const value = constraint[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
};

const screenShareCaptureBoundsByProfile = {
  good: { maxWidth: 3840, maxHeight: 2160, maxFramerate: 24 },
  fair: { maxWidth: 2560, maxHeight: 1440, maxFramerate: 12 },
  poor: { maxWidth: 1920, maxHeight: 1080, maxFramerate: 5 },
  emergency: { maxWidth: 1280, maxHeight: 720, maxFramerate: 3 },
};

const screenShareDecodedMinimumByProfile = {
  good: { width: 1920, height: 1080 },
  fair: { width: 1920, height: 1080 },
  poor: { width: 1600, height: 900 },
  emergency: { width: 1280, height: 720 },
};

const getMaxExpectedScreenShareScaleResolutionDownBy = (
  profile,
  settings,
) => {
  const bounds = screenShareCaptureBoundsByProfile[profile];
  const width = Number(settings?.width) || null;
  const height = Number(settings?.height) || null;
  if (!bounds || width === null || height === null) return null;

  const scale = Math.max(width / bounds.maxWidth, height / bounds.maxHeight, 1);
  return Number((Math.ceil(scale * 10) / 10).toFixed(1));
};

const validateScreenPublishSnapshot = (
  snapshot,
  { consoleEvents = [] } = {},
) => {
  const errors = [];
  const expected = expectedPublishQuality;
  const network = snapshot.network;
  const adaptivePublish = snapshot.adaptivePublish;
  const screenProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.screen);
  const screenAudioProfile =
    extractAdaptiveNetworkProfile(
      adaptivePublish?.lastAppliedProfiles?.screenAudio,
    );
  const audioProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.audio);
  const screenEncodings = adaptivePublish?.screenEncodings ?? [];
  const screenAudioEncodings = adaptivePublish?.screenAudioEncodings ?? [];
  const audioEncodings = adaptivePublish?.audioEncodings ?? [];
  const screenMaxBitrate = maxActiveEncodingValue(screenEncodings, "maxBitrate");
  const screenMaxFramerate = maxActiveEncodingValue(
    screenEncodings,
    "maxFramerate",
  );
  const screenScaleResolutionDownBy = Math.max(
    1,
    maxActiveEncodingValue(screenEncodings, "scaleResolutionDownBy"),
  );
  const displayMediaVideoRequest =
    snapshot.displayMediaDebug?.calls?.[0]?.video ?? null;
  const displayMediaRequestedMaxFramerate = getConstraintNumber(
    displayMediaVideoRequest?.frameRate,
    "max",
  );
  const displayMediaRequestedMaxWidth = getConstraintNumber(
    displayMediaVideoRequest?.width,
    "max",
  );
  const displayMediaRequestedMaxHeight = getConstraintNumber(
    displayMediaVideoRequest?.height,
    "max",
  );
  const screenAudioMaxBitrate = maxActiveEncodingValue(
    screenAudioEncodings,
    "maxBitrate",
  );
  const audioMaxBitrate = maxActiveEncodingValue(audioEncodings, "maxBitrate");
  const audioProducer = adaptivePublish?.audioProducer ?? null;
  const screenProducer = adaptivePublish?.screenProducer ?? null;
  const screenAudioProducer = adaptivePublish?.screenAudioProducer ?? null;
  const audioOpusCodec = summarizeProducerOpusCodec(audioProducer);
  const screenVideoCodec =
    summarizeProducerPrimaryVideoCodec(screenProducer);
  const screenAudioOpusCodec =
    summarizeProducerOpusCodec(screenAudioProducer);
  const negotiatedOpusAudioCodecs =
    getLatestRemoteAnswerOpusAudioCodecs(snapshot);
  const negotiatedAudioSectionCount =
    (requireAudio ? 1 : 0) + (requireScreenAudio ? 1 : 0);
  const browserNetworkQuality = network?.browserNetwork?.quality ?? null;
  const rtcPublishQuality = network?.rtcPublishQuality ?? null;
  const publishQuality = network?.publishQuality ?? null;
  const browserNetworkMatched = browserNetworkQuality === expected;
  const rtcPublishMatched = rtcPublishQuality === expected;
  const expectedNegotiatedQuality = getExpectedNegotiatedQuality(
    browserNetworkQuality,
    expected,
  );
  const expectedNegotiatedMicrophoneOpusMaxAverageBitrate =
    microphoneOpusMaxAverageBitrateFor({
      emergency: network?.browserNetwork?.emergency === true,
      quality: expectedNegotiatedQuality,
    });
  const expectedNegotiatedScreenAudioOpusMaxAverageBitrate =
    screenAudioOpusMaxAverageBitrateFor({
      emergency: network?.browserNetwork?.emergency === true,
      quality: expectedNegotiatedQuality,
    });
  const expectedNegotiatedAudioSectionMaxAverageBitrate = Math.max(
    expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
    expectedNegotiatedScreenAudioOpusMaxAverageBitrate,
  );

  if (snapshot.connectionState !== "joined") {
    errors.push(`expected joined state, got ${snapshot.connectionState}`);
  }
  if (!network) {
    errors.push("missing network debug snapshot");
  }
  if (!adaptivePublish?.enabled) {
    errors.push("adaptive publish hook did not enable");
  }
  if (
    !browserNetworkMatched &&
    !rtcPublishMatched &&
    publishQuality !== expected
  ) {
    errors.push(
      `expected ${expected} publish link from browser or RTC stats, got browser=${browserNetworkQuality} rtcPublish=${rtcPublishQuality} publish=${publishQuality}`,
    );
  }
  if (publishQuality !== expected) {
    errors.push(`expected publish quality ${expected}, got ${publishQuality}`);
  }
  if (!screenProducer || screenProducer.closed) {
    errors.push("missing live screen video producer");
  }
  assertPreferredVp8ProducerCodec(screenProducer, errors, "screen video");
  if (screenProducer?.trackReadyState !== "live") {
    errors.push(
      `expected live screen video track, got ${screenProducer?.trackReadyState}`,
    );
  }
  if (screenEncodings.length === 0) {
    errors.push("missing screen RTP sender encodings");
  }
  if (
    screenProducer?.degradationPreference &&
    screenProducer.degradationPreference !== "maintain-resolution"
  ) {
    errors.push(
      `expected screen degradation preference maintain-resolution, got ${screenProducer.degradationPreference}`,
    );
  }
  if (screenProfile !== expectedPublishAdaptiveProfile) {
    errors.push(
      `expected ${expectedPublishAdaptiveProfile} screen profile, got ${screenProfile}`,
    );
  }
  const expectedCaptureBounds =
    screenShareCaptureBoundsByProfile[expectedPublishAdaptiveProfile];
  if (!displayMediaVideoRequest) {
    errors.push("missing display-media screen capture request debug");
  } else if (expectedCaptureBounds) {
    if (
      displayMediaRequestedMaxFramerate !== null &&
      displayMediaRequestedMaxFramerate >
        expectedCaptureBounds.maxFramerate + 0.05
    ) {
      errors.push(
        `screen capture requested too much frame rate for ${expectedPublishAdaptiveProfile}: ${displayMediaRequestedMaxFramerate}`,
      );
    }
    if (
      displayMediaRequestedMaxWidth !== null &&
      displayMediaRequestedMaxWidth > expectedCaptureBounds.maxWidth
    ) {
      errors.push(
        `screen capture requested too much width for ${expectedPublishAdaptiveProfile}: ${displayMediaRequestedMaxWidth}`,
      );
    }
    if (
      displayMediaRequestedMaxHeight !== null &&
      displayMediaRequestedMaxHeight > expectedCaptureBounds.maxHeight
    ) {
      errors.push(
        `screen capture requested too much height for ${expectedPublishAdaptiveProfile}: ${displayMediaRequestedMaxHeight}`,
      );
    }
  }
  const maxExpectedScreenScale =
    getMaxExpectedScreenShareScaleResolutionDownBy(
      expectedPublishAdaptiveProfile,
      screenProducer?.trackSettings,
    );
  if (
    maxExpectedScreenScale !== null &&
    screenScaleResolutionDownBy > maxExpectedScreenScale + 0.05
  ) {
    errors.push(
      `screen share was over-downscaled for ${expectedPublishAdaptiveProfile} profile: scale=${screenScaleResolutionDownBy}, expected<=${maxExpectedScreenScale}`,
    );
  }

  if (expected === "poor") {
    const bitrateLimit = expectPublishEmergencyMode ? 230000 : 460000;
    const framerateLimit = expectPublishEmergencyMode ? 3 : 5;
    if (screenMaxBitrate > bitrateLimit) {
      errors.push(`screen cap too high for poor profile: ${screenMaxBitrate}`);
    }
    if (screenMaxFramerate > framerateLimit) {
      errors.push(
        `screen framerate cap too high for poor profile: ${screenMaxFramerate}`,
      );
    }
  } else if (expected === "fair") {
    if (screenMaxBitrate > 1210000) {
      errors.push(`screen cap too high for fair profile: ${screenMaxBitrate}`);
    }
    if (screenMaxFramerate > 12) {
      errors.push(
        `screen framerate cap too high for fair profile: ${screenMaxFramerate}`,
      );
    }
  }

  if (requireAudio) {
    if (!audioProducer || audioProducer.closed) {
      errors.push("missing live microphone producer");
    }
    assertLowBandwidthOpusCodecOptions(
      audioProducer,
      errors,
      "microphone",
      expectedPublishMicrophoneOpusMaxAverageBitrate,
    );
    if (audioProfile !== expectedPublishAdaptiveProfile) {
      errors.push(
        `expected ${expectedPublishAdaptiveProfile} microphone profile, got ${audioProfile}`,
      );
    }
    if (
      expected !== "good" &&
      audioMaxBitrate >
        maxAllowedAudioBitrateFor(expectedPublishMicrophoneOpusMaxAverageBitrate)
    ) {
      errors.push(
        `microphone cap too high for ${expectedPublishAdaptiveProfile} profile: ${audioMaxBitrate}`,
      );
    }
  }

  if (requireScreenAudio) {
    if (!screenAudioProducer || screenAudioProducer.closed) {
      errors.push("missing live screen audio producer");
    }
    assertLowBandwidthOpusCodecOptions(
      screenAudioProducer,
      errors,
      "screen audio",
      expectedPublishScreenAudioOpusMaxAverageBitrate,
    );
    if (screenAudioProfile !== expectedPublishAdaptiveProfile) {
      errors.push(
        `expected ${expectedPublishAdaptiveProfile} screen audio profile, got ${screenAudioProfile}`,
      );
    }
    if (
      expected !== "good" &&
      screenAudioMaxBitrate >
        maxAllowedAudioBitrateFor(
          expectedPublishScreenAudioOpusMaxAverageBitrate,
        )
    ) {
      errors.push(
        `screen audio cap too high for ${expectedPublishAdaptiveProfile} profile: ${screenAudioMaxBitrate}`,
      );
    }
  }

  if (negotiatedAudioSectionCount > 0) {
    assertNegotiatedOpusMaxAverageBitrate(
      snapshot,
      errors,
      "screen publish audio",
      Math.min(
        expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
        expectedNegotiatedScreenAudioOpusMaxAverageBitrate,
      ),
      {
        maxAllowedForEveryAudioSection:
          expectedNegotiatedAudioSectionMaxAverageBitrate,
        minSections: negotiatedAudioSectionCount,
      },
    );
  }

  if (
    expectPublishEmergencyMode &&
    network?.browserNetwork?.emergency !== true &&
    network?.emergencyMode !== true
  ) {
    errors.push("expected browser or RTC emergency mode");
  }
  if (expectPublishEmergencyMode && adaptivePublish?.emergencyMode !== true) {
    errors.push("expected adaptive publish emergency mode");
  }
  assertNoVideoEffectsNetworkResources(
    snapshot,
    errors,
    "screen publish probe",
  );
  errors.push(
    ...getConsoleRegressionErrors(consoleEvents, "screen publish probe"),
  );

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      browserNetwork: network?.browserNetwork ?? null,
      networkEmergencyMode: network?.emergencyMode ?? null,
      browserNetworkMatched,
      publishQuality,
      rtcPublishQuality,
      rtcPublishMatched,
      screenProfile,
      screenAudioProfile,
      audioProfile,
      screenVideoCodec,
      displayMediaVideoRequest,
      displayMediaRequestedMaxFramerate,
      displayMediaRequestedMaxWidth,
      displayMediaRequestedMaxHeight,
      screenMaxBitrate,
      screenMaxFramerate,
      screenScaleResolutionDownBy,
      screenTrackSettings: screenProducer?.trackSettings ?? null,
      screenAudioMaxBitrate,
      audioMaxBitrate,
      audioOpusCodec,
      screenAudioOpusCodec,
      negotiatedOpusAudioCodecs,
      expectedNegotiatedMicrophoneOpusMaxAverageBitrate,
      expectedNegotiatedScreenAudioOpusMaxAverageBitrate,
      screenDegradationPreference:
        screenProducer?.degradationPreference ?? null,
      requireScreenAudio,
      videoEffectsNetworkResourceCount:
        snapshot.videoEffectsNetworkResources?.length ?? 0,
      videoEffectsNetworkResources:
        summarizeVideoEffectsNetworkResources(snapshot).slice(0, 6),
      consoleRegressionEventCount: getConsoleRegressionErrors(
        consoleEvents,
        "screen publish probe",
      ).length,
      consoleRegressionEvents: consoleEvents
        .filter((event) =>
          /Republished camera producer|Too many media publish requests|InvalidModificationError|order of m-lines|Failed to publish media/i.test(
            event.text,
          ),
        )
        .slice(0, 8),
    },
  };
};

const validateScreenReceiveSnapshot = (
  snapshot,
  { consoleEvents = [] } = {},
) => {
  const errors = [];
  const expected = profile.expectedQuality;
  const network = snapshot.network;
  const adaptiveConsumers = snapshot.adaptiveConsumers;
  const entries = adaptiveConsumers?.entries ?? [];
  const screenVideoEntries = entries.filter(
    (entry) => entry.kind === "video" && entry.type === "screen",
  );
  const screenAudioEntries = entries.filter(
    (entry) => entry.kind === "audio" && entry.type === "screen",
  );
  const webcamVideoEntries = entries.filter(
    (entry) => entry.kind === "video" && entry.type === "webcam",
  );
  const failedEntries = entries.filter((entry) => entry.status === "error");
  const deferredEntries = entries.filter(
    (entry) => entry.status === "deferred",
  );
  const usableScreenVideoEntries = screenVideoEntries.filter((entry) =>
    ["applied", "fallback"].includes(entry.status),
  );
  const usableScreenAudioEntries = screenAudioEntries.filter((entry) =>
    ["applied", "fallback"].includes(entry.status),
  );
  const usableWebcamVideoEntries = webcamVideoEntries.filter((entry) =>
    ["applied", "fallback"].includes(entry.status),
  );
  const visibleRenderedVideos = getVisibleRenderedVideos(snapshot);
  const visibleScreenRenderedVideos = visibleRenderedVideos.filter(
    (video) => video.meetVideoStreamType === "screen",
  );
  const largestRenderedScreenVideo = visibleScreenRenderedVideos
    .slice()
    .sort(
      (left, right) =>
        right.videoWidth * right.videoHeight -
        left.videoWidth * left.videoHeight,
    )[0];
  const scoreAwareEntryErrors = getScoreAwareEntryErrors([
    ...usableScreenVideoEntries,
    ...usableScreenAudioEntries,
  ]);
  const congestionFeedbackErrors = getInconsistentRtpCongestionFeedbackErrors(
    snapshot,
    "screen receive probe",
  );

  if (snapshot.connectionState !== "joined") {
    errors.push(`expected viewer joined state, got ${snapshot.connectionState}`);
  }
  if (!network) {
    errors.push("missing viewer network debug snapshot");
  }
  if (network?.receiveQuality !== expected) {
    errors.push(
      `expected viewer receive quality ${expected}, got ${network?.receiveQuality}`,
    );
  }
  if (!adaptiveConsumers?.enabled) {
    errors.push("adaptive consumer hook did not enable");
  }
  if (adaptiveConsumers?.connectionQuality !== expected) {
    errors.push(
      `expected adaptive consumer quality ${expected}, got ${adaptiveConsumers?.connectionQuality}`,
    );
  }
  if (expectEmergencyMode && adaptiveConsumers?.emergencyMode !== true) {
    errors.push("expected adaptive consumer emergency mode");
  }
  if (failedEntries.length > 0) {
    errors.push(
      `adaptive consumer preference errors: ${failedEntries
        .map((entry) => `${entry.producerId}:${entry.error}`)
        .join(", ")}`,
    );
  }
  if ((adaptiveConsumers?.deferredCount ?? 0) > 0 || deferredEntries.length > 0) {
    errors.push(
      `adaptive screen consumer preferences still deferred after settle: ${deferredEntries
        .map((entry) => `${entry.producerId}:${entry.error ?? "deferred"}`)
        .join(", ")}`,
    );
  }
  if (usableScreenVideoEntries.length === 0) {
    errors.push("missing applied remote screen video consumer preference");
  }
  if (requireScreenAudio && usableScreenAudioEntries.length === 0) {
    errors.push("missing applied remote screen audio consumer preference");
  }
  if (usableWebcamVideoEntries.length === 0) {
    errors.push("missing supporting remote webcam consumer preference");
  }
  if (!largestRenderedScreenVideo) {
    errors.push("missing visible decoded remote screen-share video");
  } else {
    const decodedMinimum =
      screenShareDecodedMinimumByProfile[
        expectEmergencyMode ? "emergency" : expected
      ] ?? screenShareDecodedMinimumByProfile.good;
    if (
      largestRenderedScreenVideo.videoWidth < decodedMinimum.width ||
      largestRenderedScreenVideo.videoHeight < decodedMinimum.height
    ) {
      errors.push(
        `expected profile-crisp decoded screen-share video >=${decodedMinimum.width}x${decodedMinimum.height}, got ${largestRenderedScreenVideo.videoWidth}x${largestRenderedScreenVideo.videoHeight}`,
      );
    }
  }
  if (scoreAwareEntryErrors.length > 0) {
    errors.push(
      `adaptive screen consumer entries missing score-aware fields: ${scoreAwareEntryErrors.join(", ")}`,
    );
  }
  assertConsumerTelemetryEchoesPreferences(
    snapshot,
    [...usableScreenVideoEntries, ...usableScreenAudioEntries],
    errors,
    "screen receive probe",
  );
  errors.push(...congestionFeedbackErrors);
  errors.push(
    ...getReceiveConsoleRegressionErrors(consoleEvents, "screen receive probe"),
  );

  for (const entry of usableScreenVideoEntries) {
    const layers = entry.requestedLayers ?? entry.preferredLayers;
    if (entry.requestedPaused === true || entry.paused === true) {
      errors.push(`remote screen video was paused unexpectedly: ${entry.producerId}`);
    }
    if (entry.priority < 240) {
      errors.push(`remote screen priority too low: ${entry.priority}`);
    }
    if (expected === "poor") {
      if (!layers) {
        errors.push(`missing poor-link screen layer request for ${entry.producerId}`);
      } else {
        if (layers.spatialLayer !== 0) {
          errors.push(
            `expected screen spatial layer 0 for ${entry.producerId}, got ${layers.spatialLayer}`,
          );
        }
        const isVisibleScreenShare =
          entry.layout?.visible === true ||
          entry.layout?.primary === true ||
          entry.layout?.focus === true;
        const maxTemporalLayer = expectEmergencyMode
          ? 0
          : isVisibleScreenShare
            ? entry.bounds?.maxTemporalLayer ?? 2
            : 1;
        if ((layers.temporalLayer ?? 0) > maxTemporalLayer) {
          errors.push(
            `expected screen temporal layer <=${maxTemporalLayer} for ${entry.producerId}, got ${layers.temporalLayer}`,
          );
        }
      }
    }
  }

  for (const entry of usableScreenAudioEntries) {
    if (entry.priority < 255) {
      errors.push(`remote screen audio priority not protected: ${entry.priority}`);
    }
    if (entry.paused === true || entry.requestedPaused === true) {
      errors.push(
        `remote screen audio was paused unexpectedly: ${entry.producerId}`,
      );
    }
  }

  for (const entry of usableWebcamVideoEntries) {
    const layers = entry.requestedLayers ?? entry.preferredLayers;
    if (entry.requestedPaused === true || entry.paused === true) {
      errors.push(
        `supporting webcam was paused unexpectedly: ${entry.producerId}`,
      );
    }
    if (!layers) {
      errors.push(
        `missing supporting webcam layer request for ${entry.producerId}`,
      );
      continue;
    }
    if (layers.spatialLayer !== 0) {
      errors.push(
        `expected supporting webcam spatial layer 0 while screen is active for ${entry.producerId}, got ${layers.spatialLayer}`,
      );
    }
    const maxTemporalLayer = expected === "poor" || expectEmergencyMode ? 0 : 1;
    if ((layers.temporalLayer ?? 0) > maxTemporalLayer) {
      errors.push(
        `expected supporting webcam temporal layer <=${maxTemporalLayer} while screen is active for ${entry.producerId}, got ${layers.temporalLayer}`,
      );
    }
    if (entry.priority > 105) {
      errors.push(
        `supporting webcam priority too high while screen is active: ${entry.priority}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      receiveQuality: network?.receiveQuality ?? null,
      rtcReceiveQuality: network?.rtcReceiveQuality ?? null,
      browserNetwork: network?.browserNetwork ?? null,
      adaptiveConsumerQuality: adaptiveConsumers?.connectionQuality ?? null,
      emergencyMode: adaptiveConsumers?.emergencyMode ?? null,
      screenVideoPreferenceCount: usableScreenVideoEntries.length,
      screenAudioPreferenceCount: usableScreenAudioEntries.length,
      supportingWebcamPreferenceCount: usableWebcamVideoEntries.length,
      deferredCount: adaptiveConsumers?.deferredCount ?? null,
      deferredEntries: deferredEntries.slice(0, 8),
      visibleScreenRenderedVideoCount: visibleScreenRenderedVideos.length,
      largestRenderedScreenVideo: largestRenderedScreenVideo
        ? {
            videoWidth: largestRenderedScreenVideo.videoWidth,
            videoHeight: largestRenderedScreenVideo.videoHeight,
            readyState: largestRenderedScreenVideo.readyState,
            rect: largestRenderedScreenVideo.rect,
          }
        : null,
      renderedVideos: getRenderedVideoSummaries(snapshot),
      consumerTelemetryCount: (snapshot.consumerTelemetry ?? []).length,
      rtcCongestionFeedbackIssues: congestionFeedbackErrors,
      consumerScoreQualities: summarizeConsumerScoreQualities([
        ...usableScreenVideoEntries,
        ...usableScreenAudioEntries,
      ]),
      firstScreenVideoPreference: usableScreenVideoEntries[0] ?? null,
      firstScreenAudioPreference: usableScreenAudioEntries[0] ?? null,
      firstSupportingWebcamPreference: usableWebcamVideoEntries[0] ?? null,
      requireScreenAudio,
      consoleRegressionEventCount: getReceiveConsoleRegressionErrors(
        consoleEvents,
        "screen receive probe",
      ).length,
      consoleRegressionEvents: consoleEvents
        .filter((event) =>
          /Republished camera producer|Too many media publish requests|Too many consumer control requests|InvalidModificationError|order of m-lines|Failed to publish media/i.test(
            event.text,
          ),
        )
        .slice(0, 8),
    },
  };
};

const runScreenPublishScenario = async () => {
  let page = null;
  let finalSnapshot = null;
  try {
    page = await launchProbePage({
      label: "screen-publisher",
      url: buildRoomUrl(displayName),
      port: chromePort,
      throttled: true,
      fakeDisplayMedia: true,
    });
    await waitForJoined(page.cdp, "screen-publisher");
    await clickButton(page.cdp, "Unmute", 15000);
    await clickButton(page.cdp, "Share screen", 15000);
    await waitForScreenProducer(page.cdp, "screen-publisher");

    emit("screen_publish_settle_start", { settleMs });
    await sleep(settleMs);
    finalSnapshot = await collectSnapshot(page.cdp);
    const validation = validateScreenPublishSnapshot(finalSnapshot, {
      consoleEvents: page.consoleEvents,
    });
    emit("low_bandwidth_screen_publish_probe_result", validation);
    if (!validation.ok) {
      throw new Error(
        `Low-bandwidth screen publish probe failed: ${validation.errors.join(
          "; ",
        )}`,
      );
    }
  } finally {
    if (finalSnapshot) {
      emit("final_snapshot", { label: "screen-publisher", snapshot: finalSnapshot });
    }
    await closeProbePage(page);
  }
};

const runScreenReceiveScenario = async () => {
  let publisher = null;
  let viewer = null;
  let publisherSnapshot = null;
  let viewerSnapshot = null;
  try {
    publisher = await launchProbePage({
      label: "screen-publisher",
      url: buildRoomUrl(publisherName),
      port: chromePort,
      throttled: false,
      fakeDisplayMedia: true,
    });
    await waitForJoined(publisher.cdp, "screen-publisher");
    await clickButton(publisher.cdp, "Turn on camera", 15000);
    await waitForCameraProducer(publisher.cdp, "screen-publisher");
    await clickButton(publisher.cdp, "Share screen", 15000);
    await waitForScreenProducer(publisher.cdp, "screen-publisher");

    viewer = await launchProbePage({
      label: "screen-viewer",
      url: buildRoomUrl(viewerName),
      port: chromePort + 1,
      throttled: true,
    });
    await waitForJoined(viewer.cdp, "screen-viewer");
    await waitForRemoteScreenConsumerPreferences(viewer.cdp);

    emit("screen_receive_settle_start", { settleMs });
    await sleep(settleMs);
    publisherSnapshot = await collectSnapshot(publisher.cdp);
    viewerSnapshot = await collectSnapshot(viewer.cdp);
    const validation = validateScreenReceiveSnapshot(viewerSnapshot, {
      consoleEvents: viewer.consoleEvents,
    });
    emit("low_bandwidth_screen_receive_probe_result", validation);
    if (!validation.ok) {
      throw new Error(
        `Low-bandwidth screen receive probe failed: ${validation.errors.join(
          "; ",
        )}`,
      );
    }
  } finally {
    if (publisherSnapshot) {
      emit("final_snapshot", {
        label: "screen-publisher",
        snapshot: publisherSnapshot,
      });
    }
    if (viewerSnapshot) {
      emit("final_snapshot", { label: "screen-viewer", snapshot: viewerSnapshot });
    }
    await closeProbePage(viewer);
    await closeProbePage(publisher);
  }
};

const runReceiveScenario = async () => {
  const publishers = [];
  let viewer = null;
  const publisherSnapshots = [];
  let viewerSnapshot = null;
  try {
    for (let index = 0; index < receivePublisherCount; index += 1) {
      const label =
        receivePublisherCount === 1 ? "publisher" : `publisher-${index + 1}`;
      const publisher = await launchProbePage({
        label,
        url: buildRoomUrl(
          receivePublisherCount === 1
            ? publisherName
            : `${publisherName} ${index + 1}`,
        ),
        port: chromePort + index,
        throttled: false,
      });
      publishers.push(publisher);
      await waitForJoined(publisher.cdp, label);
      await clickButton(publisher.cdp, "Turn on camera", 15000);
      await clickButton(publisher.cdp, "Unmute", 15000);
      await waitForCameraProducer(publisher.cdp, label);
    }

    viewer = await launchProbePage({
      label: "viewer",
      url: buildRoomUrl(viewerName),
      port: chromePort + receivePublisherCount,
      throttled: true,
    });
    await waitForJoined(viewer.cdp, "viewer");
    await waitForRemoteConsumerPreferences(viewer.cdp, receivePublisherCount);
    emit("receive_settle_start", { settleMs });
    await sleep(settleMs);

    for (const publisher of publishers) {
      publisherSnapshots.push({
        label: publisher.label,
        snapshot: await collectSnapshot(publisher.cdp),
      });
    }
    viewerSnapshot = await collectSnapshot(viewer.cdp);
    const validation = validateReceiveSnapshot(viewerSnapshot, {
      expectedRemotePublisherCount: receivePublisherCount,
      consoleEvents: viewer.consoleEvents,
    });
    emit("low_bandwidth_receive_probe_result", validation);
    if (!validation.ok) {
      throw new Error(
        `Low-bandwidth receive probe failed: ${validation.errors.join("; ")}`,
      );
    }
  } finally {
    for (const entry of publisherSnapshots) {
      emit("final_snapshot", entry);
    }
    if (viewerSnapshot) {
      emit("final_snapshot", { label: "viewer", snapshot: viewerSnapshot });
    }
    await closeProbePage(viewer);
    for (const publisher of publishers.slice().reverse()) {
      await closeProbePage(publisher);
    }
  }
};

const runReceiveTransitionScenario = async () => {
  const publishers = [];
  let viewer = null;
  const publisherSnapshots = [];
  let initialSnapshot = null;
  let finalSnapshot = null;
  try {
    for (let index = 0; index < receivePublisherCount; index += 1) {
      const label =
        receivePublisherCount === 1 ? "publisher" : `publisher-${index + 1}`;
      const publisher = await launchProbePage({
        label,
        url: buildRoomUrl(
          receivePublisherCount === 1
            ? publisherName
            : `${publisherName} ${index + 1}`,
        ),
        port: chromePort + index,
        throttled: false,
      });
      publishers.push(publisher);
      await waitForJoined(publisher.cdp, label);
      await clickButton(publisher.cdp, "Turn on camera", 15000);
      await clickButton(publisher.cdp, "Unmute", 15000);
      await waitForCameraProducer(publisher.cdp, label);
    }

    viewer = await launchProbePage({
      label: "viewer",
      url: buildRoomUrl(viewerName),
      port: chromePort + receivePublisherCount,
      throttled: true,
    });
    await waitForJoined(viewer.cdp, "viewer");
    await waitForRemoteConsumerPreferences(viewer.cdp, receivePublisherCount);

    emit("receive_transition_initial_settle_start", { settleMs });
    await sleep(settleMs);
    initialSnapshot = await collectSnapshot(viewer.cdp);
    const initialValidation = validateReceiveSnapshot(initialSnapshot, {
      expectedRemotePublisherCount: receivePublisherCount,
      consoleEvents: viewer.consoleEvents,
      expectedQuality: expectedPublishQuality,
      expectedEmergencyMode: expectPublishEmergencyMode,
      context: "receive transition initial",
    });
    emit("low_bandwidth_receive_transition_initial_result", initialValidation);
    if (!initialValidation.ok) {
      throw new Error(
        `Low-bandwidth receive transition initial state failed: ${initialValidation.errors.join(
          "; ",
        )}`,
      );
    }

    const transitionConsoleStartIndex = viewer.consoleEvents.length;
    const targetExpectedQuality = transitionTargetProfile.expectedQuality;
    const targetEmergencyMode = transitionTargetName === "emergency";
    await switchNetworkProfile(
      viewer.cdp,
      transitionTargetName,
      transitionTargetProfile,
    );
    emit("receive_transition_target_settle_start", {
      settleMs: transitionSettleMs,
      targetProfileName: transitionTargetName,
    });
    await waitForRemoteConsumerQuality(viewer.cdp, {
      expectedRemotePublisherCount: receivePublisherCount,
      expectedQuality: targetExpectedQuality,
      expectedEmergencyMode: targetEmergencyMode,
      label: "receive transition target consumer quality",
    });
    await sleep(transitionSettleMs);

    for (const publisher of publishers) {
      publisherSnapshots.push({
        label: publisher.label,
        snapshot: await collectSnapshot(publisher.cdp),
      });
    }
    finalSnapshot = await collectSnapshot(viewer.cdp);
    const finalValidation = validateReceiveSnapshot(finalSnapshot, {
      expectedRemotePublisherCount: receivePublisherCount,
      consoleEvents: viewer.consoleEvents.slice(transitionConsoleStartIndex),
      expectedQuality: targetExpectedQuality,
      expectedEmergencyMode: targetEmergencyMode,
      context: "receive transition final",
    });
    emit("low_bandwidth_receive_transition_result", finalValidation);
    if (!finalValidation.ok) {
      throw new Error(
        `Low-bandwidth receive transition probe failed: ${finalValidation.errors.join(
          "; ",
        )}`,
      );
    }
  } finally {
    if (initialSnapshot) {
      emit("receive_transition_initial_snapshot", initialSnapshot);
    }
    for (const entry of publisherSnapshots) {
      emit("final_snapshot", entry);
    }
    if (finalSnapshot) {
      emit("final_snapshot", { label: "viewer", snapshot: finalSnapshot });
    }
    await closeProbePage(viewer);
    for (const publisher of publishers.slice().reverse()) {
      await closeProbePage(publisher);
    }
  }
};

const validateTransitionSnapshot = (
  snapshot,
  { recoveryConsoleEvents = [] } = {},
) => {
  const errors = [];
  const targetExpectedQuality = transitionTargetProfile.expectedQuality;
  const targetEmergencyMode = transitionTargetName === "emergency";
  const targetAdaptiveProfile = targetEmergencyMode
    ? "emergency"
    : targetExpectedQuality;
  const targetMicrophoneOpusMaxAverageBitrate =
    microphoneOpusMaxAverageBitrateFor({
      emergency: targetEmergencyMode,
      quality: targetExpectedQuality,
    });
  const network = snapshot.network;
  const adaptivePublish = snapshot.adaptivePublish;
  const webcamProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.webcam);
  const audioProfile =
    extractAdaptiveNetworkProfile(adaptivePublish?.lastAppliedProfiles?.audio);
  const activeWebcamMaxBitrate = Math.max(
    0,
    ...(adaptivePublish?.videoEncodings ?? [])
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxBitrate) || 0),
  );
  const activeWebcamMaxFramerate = Math.max(
    0,
    ...(adaptivePublish?.videoEncodings ?? [])
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxFramerate) || 0),
  );
  const activeWebcamEncodingRanks = (adaptivePublish?.videoEncodings ?? [])
    .map((encoding, index) => ({
      index,
      rank: getWebcamEncodingRank(encoding, index),
      active: encoding.active !== false,
      rid: encoding.rid ?? null,
      scaleResolutionDownBy:
        typeof encoding.scaleResolutionDownBy === "number"
          ? encoding.scaleResolutionDownBy
          : null,
    }))
    .filter((encoding) => encoding.active);
  const audioMaxBitrate = Math.max(
    0,
    ...(adaptivePublish?.audioEncodings ?? [])
      .filter((encoding) => encoding.active !== false)
      .map((encoding) => Number(encoding.maxBitrate) || 0),
  );
  const webcamTrackSettings = snapshot.videoProducer?.track?.settings ?? null;
  const webcamCaptureWidth = Number(webcamTrackSettings?.width) || null;
  const webcamCaptureHeight = Number(webcamTrackSettings?.height) || null;
  const webcamCaptureFrameRate = Number(webcamTrackSettings?.frameRate) || null;

  if (snapshot.connectionState !== "joined") {
    errors.push(`expected joined state, got ${snapshot.connectionState}`);
  }
  if (network?.browserNetwork?.quality !== targetExpectedQuality) {
    errors.push(
      `expected browser network ${targetExpectedQuality} after transition, got ${network?.browserNetwork?.quality}`,
    );
  }
  if (
    network?.publishQuality !== targetExpectedQuality &&
    network?.rtcPublishQuality !== targetExpectedQuality
  ) {
    errors.push(
      `expected publish quality ${targetExpectedQuality} after transition, got publish=${network?.publishQuality} rtcPublish=${network?.rtcPublishQuality}`,
    );
  }
  if (targetEmergencyMode) {
    if (
      network?.browserNetwork?.emergency !== true &&
      network?.publishEmergencyMode !== true &&
      network?.emergencyMode !== true
    ) {
      errors.push("expected emergency mode after transition");
    }
    if (adaptivePublish?.emergencyMode !== true) {
      errors.push("expected adaptive publish emergency mode after transition");
    }
  } else if (network?.browserNetwork?.emergency === true) {
    errors.push("browser network stayed in emergency mode after transition");
  }
  if (!adaptivePublish?.enabled) {
    errors.push("adaptive publish hook did not enable");
  }
  if (webcamProfile !== targetAdaptiveProfile) {
    errors.push(
      `expected webcam profile ${targetAdaptiveProfile} after transition, got ${webcamProfile}`,
    );
  }
  if (audioProfile !== targetAdaptiveProfile) {
    errors.push(
      `expected audio profile ${targetAdaptiveProfile} after transition, got ${audioProfile}`,
    );
  }
  if (targetExpectedQuality === "good") {
    if (
      expectStandardVideoRestore &&
      adaptivePublish?.videoQuality !== "standard"
    ) {
      errors.push(
        `video quality did not restore to standard after good transition: ${adaptivePublish?.videoQuality}`,
      );
    }
    if (activeWebcamMaxBitrate < 200000) {
      errors.push(
        `webcam cap did not recover after transition: ${activeWebcamMaxBitrate}`,
      );
    }
    if (expectStandardVideoRestore && activeWebcamMaxBitrate < 1000000) {
      errors.push(
        `standard webcam cap did not fully recover after transition: ${activeWebcamMaxBitrate}`,
      );
    }
    if (activeWebcamMaxFramerate < 20) {
      errors.push(
        `webcam framerate cap did not recover after transition: ${activeWebcamMaxFramerate}`,
      );
    }
    if (expectStandardVideoRestore && activeWebcamMaxFramerate < 28) {
      errors.push(
        `standard webcam framerate did not fully recover after transition: ${activeWebcamMaxFramerate}`,
      );
    }
    if (
      expectStandardVideoRestore &&
      webcamCaptureWidth !== null &&
      webcamCaptureWidth < 640
    ) {
      errors.push(
        `standard webcam capture width did not recover after transition: ${webcamCaptureWidth}`,
      );
    }
    if (
      expectStandardVideoRestore &&
      webcamCaptureHeight !== null &&
      webcamCaptureHeight < 360
    ) {
      errors.push(
        `standard webcam capture height did not recover after transition: ${webcamCaptureHeight}`,
      );
    }
    if (
      expectStandardVideoRestore &&
      webcamCaptureFrameRate !== null &&
      webcamCaptureFrameRate < 20
    ) {
      errors.push(
        `standard webcam capture framerate did not recover after transition: ${webcamCaptureFrameRate}`,
      );
    }
    if (audioMaxBitrate < 40000) {
      errors.push(
        `audio cap did not recover after transition: ${audioMaxBitrate}`,
      );
    }
  } else {
    if (adaptivePublish?.videoQuality !== "low") {
      errors.push(
        `video quality did not downgrade after ${transitionTargetName} transition: ${adaptivePublish?.videoQuality}`,
      );
    }
    const maxAllowedEncodingRank =
      getMaxActiveWebcamEncodingRankForProfile(targetAdaptiveProfile);
    const tooHighRank = activeWebcamEncodingRanks.filter(
      (encoding) => encoding.rank > maxAllowedEncodingRank,
    );
    if (tooHighRank.length > 0) {
      errors.push(
        `webcam kept high simulcast encodings active after ${transitionTargetName} transition: ${tooHighRank
          .map((encoding) => `${encoding.rid ?? encoding.index}:${encoding.rank}`)
          .join(", ")}`,
      );
    }

    const activeBaseEncoding = activeWebcamEncodingRanks.find(
      (encoding) => encoding.rank === 0,
    );
    if (
      typeof activeBaseEncoding?.scaleResolutionDownBy === "number" &&
      activeBaseEncoding.scaleResolutionDownBy > 1
    ) {
      errors.push(
        `webcam active low-bandwidth layer is double-scaled after transition: ${activeBaseEncoding.scaleResolutionDownBy}`,
      );
    }

    if (
      targetExpectedQuality === "poor" &&
      activeWebcamMaxBitrate > (targetEmergencyMode ? 80000 : 180000)
    ) {
      errors.push(
        `webcam cap too high after ${transitionTargetName} transition: ${activeWebcamMaxBitrate}`,
      );
    } else if (targetExpectedQuality === "fair" && activeWebcamMaxBitrate > 240000) {
      errors.push(
        `webcam cap too high after ${transitionTargetName} transition: ${activeWebcamMaxBitrate}`,
      );
    }

    if (
      targetExpectedQuality === "poor" &&
      activeWebcamMaxFramerate > (targetEmergencyMode ? 8 : 12)
    ) {
      errors.push(
        `webcam framerate cap too high after ${transitionTargetName} transition: ${activeWebcamMaxFramerate}`,
      );
    } else if (
      targetExpectedQuality === "fair" &&
      activeWebcamMaxFramerate > 20
    ) {
      errors.push(
        `webcam framerate cap too high after ${transitionTargetName} transition: ${activeWebcamMaxFramerate}`,
      );
    }

    if (targetExpectedQuality === "poor") {
      const maxCaptureWidth = targetEmergencyMode ? 360 : 500;
      const maxCaptureHeight = targetEmergencyMode ? 240 : 300;
      const maxCaptureFrameRate = targetEmergencyMode ? 15 : 18;
      if (webcamCaptureWidth !== null && webcamCaptureWidth > maxCaptureWidth) {
        errors.push(
          `webcam capture width too high after ${transitionTargetName} transition: ${webcamCaptureWidth}`,
        );
      }
      if (webcamCaptureHeight !== null && webcamCaptureHeight > maxCaptureHeight) {
        errors.push(
          `webcam capture height too high after ${transitionTargetName} transition: ${webcamCaptureHeight}`,
        );
      }
      if (
        webcamCaptureFrameRate !== null &&
        webcamCaptureFrameRate > maxCaptureFrameRate
      ) {
        errors.push(
          `webcam capture frame rate too high after ${transitionTargetName} transition: ${webcamCaptureFrameRate}`,
        );
      }
    }

    if (
      targetExpectedQuality !== "good" &&
      audioMaxBitrate >
        maxAllowedAudioBitrateFor(targetMicrophoneOpusMaxAverageBitrate)
    ) {
      errors.push(
        `audio cap too high after ${transitionTargetName} transition: ${audioMaxBitrate}`,
      );
    }
  }
  errors.push(
    ...getConsoleRegressionErrors(
      recoveryConsoleEvents,
      "transition recovery",
    ),
  );

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      connectionState: snapshot.connectionState,
      browserNetwork: network?.browserNetwork ?? null,
      publishQuality: network?.publishQuality ?? null,
      rtcPublishQuality: network?.rtcPublishQuality ?? null,
      videoQuality: adaptivePublish?.videoQuality ?? null,
      webcamProfile,
      audioProfile,
      targetAdaptiveProfile,
      activeWebcamMaxBitrate,
      activeWebcamMaxFramerate,
      activeWebcamEncodingRanks,
      webcamTrackSettings,
      audioMaxBitrate,
      expectStandardVideoRestore,
      targetEmergencyMode,
      recoveryConsoleRegressionEventCount:
        getConsoleRegressionErrors(
          recoveryConsoleEvents,
          "transition recovery",
        ).length,
      recoveryConsoleEvents: recoveryConsoleEvents
        .filter((event) =>
          /Republished camera producer|Too many media publish requests|InvalidModificationError|order of m-lines|Failed to publish media/i.test(
            event.text,
          ),
        )
        .slice(0, 8),
    },
  };
};

const runTransitionScenario = async () => {
  let page = null;
  let initialSnapshot = null;
  let finalSnapshot = null;
  try {
    page = await launchProbePage({
      label: "transition",
      url: buildRoomUrl(displayName),
      port: chromePort,
      throttled: true,
    });
    await waitForJoined(page.cdp, "transition");
    await clickButton(page.cdp, "Turn on camera", 15000);
    await clickButton(page.cdp, "Unmute", 15000);
    await waitForCameraProducer(page.cdp, "transition");

    emit("transition_initial_settle_start", { settleMs });
    await sleep(settleMs);
    initialSnapshot = await collectSnapshot(page.cdp);
    const initialValidation = validateFinalSnapshot(initialSnapshot, {
      consoleEvents: page.consoleEvents,
    });
    emit("low_bandwidth_transition_initial_result", initialValidation);
    if (!initialValidation.ok) {
      throw new Error(
        `Low-bandwidth transition initial state failed: ${initialValidation.errors.join(
          "; ",
        )}`,
      );
    }

    const recoveryConsoleStartIndex = page.consoleEvents.length;
    await switchNetworkProfile(
      page.cdp,
      transitionTargetName,
      transitionTargetProfile,
    );
    emit("transition_recovery_settle_start", {
      settleMs: transitionSettleMs,
      targetProfileName: transitionTargetName,
    });
    await sleep(transitionSettleMs);
    finalSnapshot = await collectSnapshot(page.cdp);
    const finalValidation = validateTransitionSnapshot(finalSnapshot, {
      recoveryConsoleEvents: page.consoleEvents.slice(recoveryConsoleStartIndex),
    });
    emit("low_bandwidth_transition_result", finalValidation);
    if (!finalValidation.ok) {
      throw new Error(
        `Low-bandwidth transition probe failed: ${finalValidation.errors.join(
          "; ",
        )}`,
      );
    }
  } finally {
    if (initialSnapshot) {
      emit("transition_initial_snapshot", initialSnapshot);
    }
    if (finalSnapshot) {
      emit("final_snapshot", finalSnapshot);
    }
    await closeProbePage(page);
  }
};

const run = async () => {
  if (scenario === "transition") {
    await runTransitionScenario();
    return;
  }

  if (scenario === "screen-publish") {
    await runScreenPublishScenario();
    return;
  }

  if (scenario === "screen-receive") {
    await runScreenReceiveScenario();
    return;
  }

  if (scenario === "receive-transition") {
    await runReceiveTransitionScenario();
    return;
  }

  if (scenario === "receive" || scenario === "receive-many") {
    await runReceiveScenario();
    return;
  }

  const userDataDir = mkdtempSync(join(tmpdir(), "conclave-low-bandwidth-"));
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const url = new URL(`/${encodeURIComponent(roomId)}`, normalizedBaseUrl);
  url.searchParams.set("autojoin", "1");
  url.searchParams.set("admin", "1");
  url.searchParams.set("name", displayName);
  if (clientId) url.searchParams.set("clientId", clientId);

  const args = [
    chromeHeadlessFlag,
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=MediaRouter",
    `--window-size=${viewport.width},${viewport.height}`,
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "about:blank",
  ];

  emit("chrome_launch", {
    chromePath,
    chromePort,
    url: String(url),
    profileName,
    profile,
    viewportName,
    viewport,
    command: `${shellEscape(chromePath)} ${args.map(shellEscape).join(" ")}`,
  });

  const consoleRecorder = createPageConsoleRecorder();
  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let chromeExited = false;
  const chromeExitPromise = new Promise((resolve) => {
    chrome.once("exit", () => {
      chromeExited = true;
      resolve();
    });
  });
  chrome.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) emit("chrome_stdout", { text });
  });
  chrome.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text && !text.includes("INFO:CONSOLE")) {
      const event = {
        ts: new Date().toISOString(),
        label: null,
        type: "stderr",
        text,
      };
      consoleRecorder.events.push(event);
      if (consoleRecorder.events.length > 500) {
        consoleRecorder.events.splice(0, consoleRecorder.events.length - 500);
      }
      emit("chrome_stderr", { text });
    }
  });

  let cdp = null;
  let startupSnapshot = null;
  let finalSnapshot = null;
  try {
    const targets = await waitForJson(
      `http://127.0.0.1:${chromePort}/json/list`,
      "Chrome target list",
      30000,
    );
    const target = targets.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("No debuggable Chrome page target found");
    }

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await applyProbeViewport(cdp);
    await applyProbeUserAgent(cdp);
    cdp.on("Runtime.consoleAPICalled", (params) => {
      consoleRecorder.record(params);
    });

    await applyNetworkProfile(cdp);
    if (installBrowserNetworkInformation) {
      await installNetworkInformationOverride(cdp);
    } else {
      await installNetworkInformationUnavailableOverride(cdp);
    }
    await installRtcSdpDebug(cdp);
    await installDebugStorage(cdp);

    await cdp.send("Page.navigate", { url: String(url) });
    emit("navigate", { url: String(url) });
    await waitForEval(
      cdp,
      "Conclave debug getter",
      `(() => ({ ok: typeof window.__conclaveGetMeetVideoDebug === "function" }))()`,
      timeoutMs,
    );
    await waitForEval(
      cdp,
      "meeting joined",
      `(() => {
        const debug = window.__conclaveGetMeetVideoDebug?.();
        return {
          ok: debug?.connectionState === "joined",
          state: debug?.connectionState ?? null,
          meetError: debug?.meetError ?? null,
        };
      })()`,
      timeoutMs,
    );

    await clickButton(cdp, "Turn on camera", 15000);
    await clickButton(cdp, "Unmute", 15000);

    if (requireCamera) {
      await waitForEval(
        cdp,
        "camera producer",
        `(() => {
          const debug = window.__conclaveGetMeetVideoDebug?.();
          return {
            ok: debug?.connectionState === "joined" &&
              debug?.isCameraOff === false &&
              Boolean(debug?.videoProducer && !debug.videoProducer.closed),
            isCameraOff: debug?.isCameraOff ?? null,
            videoProducer: debug?.videoProducer ?? null,
          };
        })()`,
        30000,
      );
    }

    if (expectMobileNoNetworkInformationStartup) {
      startupSnapshot = await collectSnapshot(cdp);
      const startupValidation =
        validateMobileNoNetworkInformationStartupSnapshot(startupSnapshot, {
          consoleEvents: consoleRecorder.events,
        });
      emit("low_bandwidth_mobile_no_netinfo_startup_result", startupValidation);
      if (!startupValidation.ok) {
        throw new Error(
          `Mobile no-NetInfo startup probe failed: ${startupValidation.errors.join(
            "; ",
          )}`,
        );
      }
    }

    if (openEffectsPanelDuringPublish) {
      await openVideoEffectsPanel(cdp);
    }

    emit("settle_start", { settleMs });
    await sleep(settleMs);
    finalSnapshot = await collectSnapshot(cdp);
    const validation = validateFinalSnapshot(finalSnapshot, {
      consoleEvents: consoleRecorder.events,
    });
    emit("low_bandwidth_probe_result", validation);
    if (!validation.ok) {
      throw new Error(`Low-bandwidth probe failed: ${validation.errors.join("; ")}`);
    }
  } finally {
    if (startupSnapshot) emit("startup_snapshot", startupSnapshot);
    if (finalSnapshot) emit("final_snapshot", finalSnapshot);
    if (cdp) cdp.close();
    if (!chromeExited) {
      try {
        chrome.kill("SIGTERM");
        await Promise.race([chromeExitPromise, sleep(1500)]);
        if (!chromeExited) {
          chrome.kill("SIGKILL");
          await Promise.race([chromeExitPromise, sleep(1000)]);
        }
      } catch (error) {
        emit("chrome_shutdown_failed", { error: error.message });
      }
    }
    try {
      rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (error) {
      emit("profile_cleanup_failed", { path: userDataDir, error: error.message });
    }
  }
};

run()
  .then(() => {
    process.stdout.write("", () => process.exit(0));
  })
  .catch((error) => {
    emit("fatal", { error: error.message, stack: error.stack });
    process.stdout.write("", () => process.exit(1));
  });
