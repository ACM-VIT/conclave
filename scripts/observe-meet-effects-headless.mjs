#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  closeSilentBrowser,
  launchSilentBrowser,
  navigateSilentBrowserPage,
} from "./quality/silent-browser-contract.mjs";

const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const meetUrl =
  process.env.MEET_URL ?? "https://meet.google.com/avj-ysfo-nbm";
if (
  process.env.MEET_OBSERVER_HEADLESS &&
  !/^(1|true|yes)$/i.test(process.env.MEET_OBSERVER_HEADLESS)
) {
  throw new Error(
    "Meet observation probes are safety-locked to --headless=new and cannot launch visibly",
  );
}
if (
  process.env.MEET_OBSERVER_ATTACH_PORT ||
  process.env.MEET_OBSERVER_CHROME_PORT
) {
  throw new Error(
    "Meet observation probes use an isolated OS-selected DevTools port and cannot attach to or select a browser port",
  );
}
const fakeVideoPath = process.env.MEET_OBSERVER_FAKE_VIDEO
  ? resolve(process.env.MEET_OBSERVER_FAKE_VIDEO)
  : null;
if (/^(1|true|yes)$/i.test(process.env.MEET_OBSERVER_REAL_MEDIA ?? "")) {
  throw new Error(
    "Meet observation probes cannot request native media capture",
  );
}
const configuredUserDataDir = process.env.MEET_OBSERVER_USER_DATA_DIR ?? null;
if (
  configuredUserDataDir ||
  /^(1|true|yes)$/i.test(process.env.MEET_OBSERVER_KEEP_PROFILE ?? "")
) {
  throw new Error(
    "Meet observation probes require an ephemeral centrally owned browser profile",
  );
}

const streamNetwork = /^(1|true|yes)$/i.test(
  process.env.MEET_OBSERVER_STREAM_NETWORK ?? "",
);
const mobileMode = /^(1|true|yes)$/i.test(
  process.env.MEET_OBSERVER_MOBILE ?? "",
);
const mobileWidth = Number(process.env.MEET_OBSERVER_MOBILE_WIDTH ?? 390);
const mobileHeight = Number(process.env.MEET_OBSERVER_MOBILE_HEIGHT ?? 844);
const mobileDeviceScaleFactor = Number(
  process.env.MEET_OBSERVER_MOBILE_DEVICE_SCALE_FACTOR ?? 3,
);
const mobileUserAgent =
  process.env.MEET_OBSERVER_MOBILE_USER_AGENT ??
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const mobilePlatform = /android/i.test(mobileUserAgent)
  ? "Linux armv8l"
  : "iPhone";
const selectedBackgroundLabel =
  process.env.MEET_OBSERVER_BACKGROUND_LABEL ?? "";
const selectedFilterLabel = process.env.MEET_OBSERVER_FILTER_LABEL ?? "";
const selectedStyleLabel = process.env.MEET_OBSERVER_STYLE_LABEL ?? "";
const enableStudioLook = /^(1|true|yes)$/i.test(
  process.env.MEET_OBSERVER_ENABLE_STUDIO_LOOK ?? "",
);
const waitAfterEffectMs = Number(
  process.env.MEET_OBSERVER_WAIT_AFTER_EFFECT_MS ?? 6000,
);

const emit = (event, payload = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const installCdpLogForwarding = (cdp) => {
  cdp.on("Runtime.consoleAPICalled", (params) => {
    emit("page_console", {
      type: params.type,
      text: (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "")
        .join(" "),
      stack: params.stackTrace ?? null,
    });
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    emit("page_log", {
      level: entry?.level,
      source: entry?.source,
      text: entry?.text,
      url: entry?.url,
    });
  });
};

const importantNetworkPatterns = [
  /boq-rtc\.MeetingsUi/i,
  /meetingsui/i,
  /mediapipe/i,
  /tensorflow/i,
  /tflite/i,
  /wasm/i,
  /segmentation/i,
  /segmenter/i,
  /selfie/i,
  /background/i,
  /blur/i,
  /effect/i,
  /video_effects\/effects/i,
  /videopipe_bundle/i,
  /face/i,
  /landmark/i,
  /vision/i,
  /model/i,
  /graph/i,
  /\$rpc\/google\.rtc\.meetings/i,
];

const classifyNetworkUrl = (url, mimeType = "", resourceType = "") => {
  const value = `${url} ${mimeType} ${resourceType}`;
  if (/\$rpc\/google\.rtc\.meetings/i.test(value)) return "meet_rpc";
  if (/video_effects\/effects\/[^/]+\/[^/]+\/videopipe_bundle\.js/i.test(value)) {
    return "effects_runtime";
  }
  if (/boq-rtc\.MeetingsUi|meetingsui/i.test(value)) return "meet_bundle";
  if (/wasm/i.test(value)) return "wasm";
  if (/tflite|model|graph/i.test(value)) return "model";
  if (/mediapipe|tensorflow|vision|segmentation|segmenter|selfie|face|landmark/i.test(value)) {
    return "ml_effects";
  }
  if (/background|blur|effect/i.test(value)) return "effects_asset";
  if (/javascript|script/i.test(value)) return "script";
  return "other";
};

const isImportantNetworkUrl = (url, mimeType = "", resourceType = "") => {
  const value = `${url} ${mimeType} ${resourceType}`;
  return importantNetworkPatterns.some((pattern) => pattern.test(value));
};

const getEffectsRuntimeBundle = (url) => {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(
      /^\/video_effects\/effects\/([^/]+)\/([^/]+)\/([^/]+)$/i,
    );
    if (!match || match[3] !== "videopipe_bundle.js") return null;
    return {
      origin: parsed.origin,
      build: match[1],
      encoding: match[2],
      file: match[3],
      url: compactUrl(url),
    };
  } catch {
    return null;
  }
};

const compactUrl = (url) => {
  try {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    if (path.length <= 420) return `${parsed.origin}${path}`;
    return `${parsed.origin}${path.slice(0, 300)}...${path.slice(-100)}`;
  } catch {
    return String(url).slice(0, 520);
  }
};

const createNetworkRecorder = () => {
  const requests = new Map();
  const relevant = new Map();

  const rememberRelevant = (requestId) => {
    const record = requests.get(requestId);
    if (!record) return;
    if (
      !isImportantNetworkUrl(
        record.url,
        record.mimeType ?? "",
        record.resourceType ?? "",
      )
    ) {
      return;
    }
    record.category = classifyNetworkUrl(
      record.url,
      record.mimeType ?? "",
      record.resourceType ?? "",
    );
    relevant.set(requestId, record);
    if (streamNetwork && !record.emitted) {
      record.emitted = true;
      emit("network_effect_resource", {
        category: record.category,
        method: record.method,
        status: record.status,
        resourceType: record.resourceType,
        mimeType: record.mimeType,
        url: compactUrl(record.url),
      });
    }
  };

  return {
    install(cdp) {
      cdp.on("Network.requestWillBeSent", (params) => {
        const existing = requests.get(params.requestId) ?? {};
        requests.set(params.requestId, {
          ...existing,
          requestId: params.requestId,
          url: params.request?.url ?? existing.url,
          method: params.request?.method ?? existing.method,
          resourceType: params.type ?? existing.resourceType,
          initiatorType: params.initiator?.type ?? existing.initiatorType,
          startedAt: params.timestamp ?? existing.startedAt,
        });
        rememberRelevant(params.requestId);
      });
      cdp.on("Network.responseReceived", (params) => {
        const existing = requests.get(params.requestId) ?? {};
        requests.set(params.requestId, {
          ...existing,
          requestId: params.requestId,
          url: params.response?.url ?? existing.url,
          status: params.response?.status,
          mimeType: params.response?.mimeType,
          resourceType: params.type ?? existing.resourceType,
          fromDiskCache: params.response?.fromDiskCache,
          fromServiceWorker: params.response?.fromServiceWorker,
          protocol: params.response?.protocol,
        });
        rememberRelevant(params.requestId);
      });
      cdp.on("Network.loadingFinished", (params) => {
        const existing = requests.get(params.requestId);
        if (!existing) return;
        existing.encodedDataLength = params.encodedDataLength;
        existing.finishedAt = params.timestamp;
        rememberRelevant(params.requestId);
      });
      cdp.on("Network.loadingFailed", (params) => {
        const existing = requests.get(params.requestId) ?? {};
        requests.set(params.requestId, {
          ...existing,
          requestId: params.requestId,
          resourceType: params.type ?? existing.resourceType,
          failed: true,
          errorText: params.errorText,
          canceled: params.canceled,
        });
        rememberRelevant(params.requestId);
      });
    },
    summary() {
      const items = Array.from(relevant.values())
        .filter((record) => record.url)
        .sort((a, b) => {
          const byCategory = String(a.category).localeCompare(String(b.category));
          if (byCategory !== 0) return byCategory;
          return String(a.url).localeCompare(String(b.url));
        });
      const categories = items.reduce((acc, record) => {
        const category = record.category ?? "other";
        acc[category] = (acc[category] ?? 0) + 1;
        return acc;
      }, {});
      const effectsRuntimeBundles = items
        .map((record) => getEffectsRuntimeBundle(record.url))
        .filter(Boolean);
      return {
        totalRelevant: items.length,
        categories,
        effectsRuntimeObserved: effectsRuntimeBundles.length > 0,
        effectsRuntimeBundles,
        items: items.slice(0, 90).map((record) => ({
          category: record.category,
          method: record.method,
          status: record.status ?? null,
          resourceType: record.resourceType ?? null,
          mimeType: record.mimeType ?? null,
          encodedDataLength: record.encodedDataLength ?? null,
          failed: record.failed === true,
          errorText: record.errorText ?? null,
          url: compactUrl(record.url),
        })),
      };
    },
  };
};

const evalValue = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        "CDP evaluation failed",
    );
  }
  return result.result.value;
};

const waitFor = async (cdp, label, expression, timeoutMs = 15000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evalValue(cdp, expression)) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const clickByTextOrAria = async (cdp, label) => {
  const clicked = await evalValue(
    cdp,
    `(() => {
      const target = ${JSON.stringify(label)};
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const element = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem']"))
        .find((node) => normalize(node.getAttribute("aria-label")) === target ||
          normalize(node.textContent).includes(target));
      if (!element) return false;
      element.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Could not click ${label}`);
};

const clickFirstAvailable = async (cdp, labels) => {
  for (const label of labels) {
    const clicked = await evalValue(
      cdp,
      `(() => {
        const target = ${JSON.stringify(label)};
        const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const element = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem'], [role='tab']"))
          .find((node) => {
            const aria = normalize(node.getAttribute("aria-label"));
            const text = normalize(node.textContent);
            return aria === target || aria.includes(target) || text === target || text.includes(target);
          });
        if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") {
          return false;
        }
        element.click();
        return true;
      })()`,
    );
    if (clicked) return label;
  }
  return null;
};

const collectMeetState = async (cdp, label) => {
  const state = await evalValue(
    cdp,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const buttons = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem']")).slice(0, 220)
        .map((button) => ({
          text: normalize(button.textContent),
          aria: button.getAttribute("aria-label"),
          disabled: button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true",
          pressed: button.getAttribute("aria-pressed"),
          selected: button.getAttribute("aria-selected"),
        }));
      const tabs = Array.from(document.querySelectorAll("[role='tab'], button"))
        .filter((node) => ["Backgrounds", "Appearance", "Filters"].includes(normalize(node.textContent)))
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          text: normalize(node.textContent),
          selected: node.getAttribute("aria-selected"),
          pressed: node.getAttribute("aria-pressed"),
        }));
      return {
        url: location.href,
        title: document.title,
        text: normalize(document.body?.innerText).slice(0, 6000),
        buttons,
        tabs,
        videos: Array.from(document.querySelectorAll("video")).map((video, index) => ({
          index,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          paused: video.paused,
          ended: video.ended,
          rect: (() => {
            const rect = video.getBoundingClientRect();
            return { width: Math.round(rect.width), height: Math.round(rect.height) };
          })(),
        })),
      };
    })()`,
  );
  emit(label, state);
  return state;
};

const collectClientCapabilities = async (cdp, label) => {
  const capabilities = await evalValue(
    cdp,
    `(() => {
      const getWebglInfo = () => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        if (!gl) return null;
        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          version: gl.getParameter(gl.VERSION),
          shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        };
      };
      const supportedConstraints = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
      const resourceEntries = performance.getEntriesByType("resource")
        .map((entry) => ({
          name: entry.name,
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        }))
        .filter((entry) => /boq-rtc\\.MeetingsUi|meetingsui|mediapipe|tensorflow|tflite|wasm|segmentation|segmenter|selfie|background|blur|effect|face|landmark|vision|model|graph|\\$rpc\\/google\\.rtc\\.meetings/i.test(entry.name))
        .slice(0, 120);
      const scripts = Array.from(document.scripts)
        .map((script) => script.src)
        .filter(Boolean)
        .filter((src) => /boq-rtc\\.MeetingsUi|meetingsui|mediapipe|tensorflow|tflite|wasm|segmentation|segmenter|selfie|background|blur|effect|face|landmark|vision|model|graph/i.test(src))
        .slice(0, 80);
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        crossOriginIsolated: window.crossOriginIsolated,
        hasMediaDevices: Boolean(navigator.mediaDevices),
        hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
        hasRequestVideoFrameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
        hasMediaStreamTrackProcessor: "MediaStreamTrackProcessor" in window,
        hasMediaStreamTrackGenerator: "MediaStreamTrackGenerator" in window,
        hasWebCodecsVideoFrame: "VideoFrame" in window,
        hasOffscreenCanvas: "OffscreenCanvas" in window,
        hasWebGpu: "gpu" in navigator,
        supportedConstraints,
        webgl: getWebglInfo(),
        relevantScripts: scripts,
        relevantResourceEntries: resourceEntries,
      };
    })()`,
  );
  emit(label, capabilities);
  return capabilities;
};

const collectEvidence = async (cdp, networkRecorder, label) => {
  const state = await collectMeetState(cdp, label);
  emit(`${label}_network`, networkRecorder.summary());
  await collectClientCapabilities(cdp, `${label}_capabilities`);
  return state;
};

const clickEffectAndCollect = async (
  cdp,
  networkRecorder,
  label,
  candidates,
) => {
  const clicked = await clickFirstAvailable(cdp, candidates);
  emit(`${label}_click`, { clicked, candidates });
  if (!clicked) return null;
  await sleep(waitAfterEffectMs);
  return collectEvidence(cdp, networkRecorder, label);
};

if (fakeVideoPath && !existsSync(fakeVideoPath)) {
  throw new Error(`MEET_OBSERVER_FAKE_VIDEO does not exist: ${fakeVideoPath}`);
}

let browserSession = null;
let cdp = null;
const networkRecorder = createNetworkRecorder();
try {
  browserSession = await launchSilentBrowser({
    chromePath,
    label: "meet-effects-observer",
    windowSize: mobileMode
      ? `${mobileWidth},${mobileHeight}`
      : "1440,900",
    syntheticVideoFilePath: fakeVideoPath,
    timeoutMs: 30_000,
  });
  cdp = browserSession.pageCdp;
  emit("chrome_launch", {
    chromePath,
    url: meetUrl,
    fakeVideoPath,
    headless: browserSession.authority.exactHeadless,
    muted: browserSession.authority.muted,
    zeroAudioInput: browserSession.authority.zeroAudioInput,
    isolatedProfile: browserSession.authority.isolatedProfile,
  });
  installCdpLogForwarding(cdp);
  networkRecorder.install(cdp);
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");
  if (mobileMode) {
    await cdp.send("Network.setUserAgentOverride", {
      userAgent: mobileUserAgent,
      platform: mobilePlatform,
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: mobileWidth,
      height: mobileHeight,
      deviceScaleFactor: mobileDeviceScaleFactor,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await cdp.send("Emulation.setEmitTouchEventsForMouse", {
      enabled: true,
      configuration: "mobile",
    }).catch(() => {});
    emit("mobile_emulation_enabled", {
      width: mobileWidth,
      height: mobileHeight,
      deviceScaleFactor: mobileDeviceScaleFactor,
      platform: mobilePlatform,
      userAgent: mobileUserAgent,
    });
  }
  await navigateSilentBrowserPage(browserSession, {
    url: meetUrl,
    label: "Meet observer",
    timeoutMs: 30_000,
  });
  await waitFor(
    cdp,
    "Meet prejoin shell",
    `(() => {
      const text = document.body?.innerText || "";
      return text.includes("Backgrounds and effects") || text.includes("More options");
    })()`,
    30000,
  );
  await sleep(2500);
  const initialState = await collectEvidence(
    cdp,
    networkRecorder,
    "state_prejoin_initial",
  );
  if (initialState.text.includes("You can't join this video call")) {
    emit("result", {
      ok: true,
      limited: true,
      reason: "Meet blocked this isolated browser profile before prejoin.",
      network: networkRecorder.summary(),
    });
    process.exitCode = 0;
  } else {
    await waitFor(
      cdp,
      "Meet fake-media prejoin controls",
      `(() => {
        const text = document.body?.innerText || "";
        if (text.includes("You can't join this video call")) return true;
        const controls = Array.from(document.querySelectorAll("button, [role='button']"));
        const hasVisualEffects = controls.some((node) =>
          (node.getAttribute("aria-label") || "").includes("Backgrounds and effects") ||
          (node.textContent || "").includes("visual_effects")
        );
        const stillGettingReady = text.includes("Getting ready");
        return hasVisualEffects && !stillGettingReady;
      })()`,
      30000,
    );
    await collectEvidence(cdp, networkRecorder, "state_prejoin_ready");

    const directEffectsClicked = await evalValue(
      cdp,
      `(() => {
        const button = Array.from(document.querySelectorAll("button, [role='button']"))
          .find((node) => (node.getAttribute("aria-label") || "").includes("Backgrounds and effects") ||
            (node.getAttribute("aria-label") || "").includes("Permission needed") ||
            (node.textContent || "").includes("visual_effects"));
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
        button.click();
        return true;
      })()`,
    );
    if (!directEffectsClicked) {
      await clickByTextOrAria(cdp, "More options");
      await sleep(500);
      await clickByTextOrAria(cdp, "Backgrounds and effects");
    }
    await sleep(700);
    const afterDirectClickState = await collectMeetState(
      cdp,
      "state_effects_after_direct_click",
    );
    emit(
      "state_effects_after_direct_click_network",
      networkRecorder.summary(),
    );
    await collectClientCapabilities(
      cdp,
      "state_effects_after_direct_click_capabilities",
    );
    if (afterDirectClickState.text.includes("Choose backgrounds and effects")) {
      await clickFirstAvailable(cdp, [
        "Choose backgrounds and effects",
        "Backgrounds and effects",
      ]);
      await sleep(700);
    }

    await waitFor(
      cdp,
      "effects panel",
      `(() => {
        const text = document.body.innerText || "";
        return text.includes("Backgrounds and effects") &&
          (text.includes("Backgrounds") || text.includes("Touch-up appearance"));
      })()`,
      15000,
    );
    await sleep(1000);
    await collectEvidence(cdp, networkRecorder, "state_effects_backgrounds");
    if (selectedBackgroundLabel) {
      await clickEffectAndCollect(cdp, networkRecorder, "state_background_selected", [
        selectedBackgroundLabel,
      ]);
    }
    if (selectedFilterLabel) {
      const filtersClick = await clickFirstAvailable(cdp, ["Filters"]);
      emit("filters_click", { clicked: filtersClick });
      await sleep(1000);
      await collectEvidence(cdp, networkRecorder, "state_effects_filters");
      await clickEffectAndCollect(cdp, networkRecorder, "state_filter_selected", [
        selectedFilterLabel,
      ]);
    }
    const appearanceClick = await clickFirstAvailable(cdp, [
      "Appearance",
      "Touch-up appearance",
    ]);
    emit("appearance_click", { clicked: appearanceClick });
    await sleep(1000);
    await collectEvidence(cdp, networkRecorder, "state_effects_appearance");
    if (enableStudioLook) {
      await clickEffectAndCollect(cdp, networkRecorder, "state_studio_look_enabled", [
        "Studio look",
      ]);
    }
    if (selectedStyleLabel) {
      await clickEffectAndCollect(cdp, networkRecorder, "state_style_selected", [
        selectedStyleLabel,
      ]);
    }
    emit("result", {
      ok: true,
      limited: false,
      network: networkRecorder.summary(),
    });
  }
} catch (err) {
  const error = err instanceof Error ? err.stack || err.message : String(err);
  const network = networkRecorder.summary();
  const accessLimitedByMeet =
    /Timed out waiting for Meet prejoin shell/i.test(error) &&
    (network.items.some(
      (item) => item.category === "meet_rpc" && item.status === 403,
    ) ||
      network.effectsRuntimeObserved ||
      Number(network.categories.effects_asset ?? 0) > 0);

  if (accessLimitedByMeet) {
    emit("result", {
      ok: true,
      limited: true,
      reason:
        "Meet blocked this isolated browser profile before prejoin; effects resources were still captured.",
      error,
      network,
    });
    process.exitCode = 0;
  } else {
    emit("result", {
      ok: false,
      error,
      network,
    });
    process.exitCode = 1;
  }
} finally {
  await closeSilentBrowser(browserSession);
}
