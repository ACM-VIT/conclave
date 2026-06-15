#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const meetUrl =
  process.env.MEET_URL ?? "https://meet.google.com/avj-ysfo-nbm";
const headlessMode = !/^(0|false|no)$/i.test(
  process.env.MEET_OBSERVER_HEADLESS ?? "true",
);
const attachPort = process.env.MEET_OBSERVER_ATTACH_PORT
  ? Number(process.env.MEET_OBSERVER_ATTACH_PORT)
  : null;
const chromePort = Number(
  attachPort ??
    process.env.MEET_OBSERVER_CHROME_PORT ??
    String(9400 + Math.floor(Math.random() * 500)),
);
const fakeVideoPath = process.env.MEET_OBSERVER_FAKE_VIDEO ?? null;
const useFakeMedia = !/^(1|true|yes)$/i.test(
  process.env.MEET_OBSERVER_REAL_MEDIA ?? "",
);
const configuredUserDataDir = process.env.MEET_OBSERVER_USER_DATA_DIR ?? null;
const keepUserDataDir =
  Boolean(configuredUserDataDir) ||
  /^(1|true|yes)$/i.test(process.env.MEET_OBSERVER_KEEP_PROFILE ?? "");
const streamNetwork = /^(1|true|yes)$/i.test(
  process.env.MEET_OBSERVER_STREAM_NETWORK ?? "",
);

const emit = (event, payload = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  close() {
    this.ws.close();
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }
}

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

const waitForJson = async (url, label, timeoutMs = 20000) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`${label} timed out`);
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

if (fakeVideoPath && !existsSync(fakeVideoPath)) {
  throw new Error(`MEET_OBSERVER_FAKE_VIDEO does not exist: ${fakeVideoPath}`);
}

const spawnedChrome = attachPort === null;
const createdUserDataDir = spawnedChrome && !configuredUserDataDir;
const userDataDir = configuredUserDataDir ??
  (createdUserDataDir ? mkdtempSync(join(tmpdir(), "meet-effects-observer-")) : null);
const chromeArgs = [
  `--remote-debugging-port=${chromePort}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-extensions",
  "--disable-sync",
  "--window-size=1440,900",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-logging=stderr",
  "--v=0",
  meetUrl,
].filter(Boolean);
if (userDataDir) {
  chromeArgs.unshift(`--user-data-dir=${userDataDir}`);
}
if (useFakeMedia) {
  chromeArgs.splice(
    chromeArgs.length - 1,
    0,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  );
  if (fakeVideoPath) {
    chromeArgs.splice(
      chromeArgs.length - 1,
      0,
      `--use-file-for-fake-video-capture=${fakeVideoPath}`,
    );
  }
}
if (headlessMode) {
  chromeArgs.unshift("--headless=new");
}

const chrome = spawnedChrome
  ? spawn(chromePath, chromeArgs, { stdio: ["ignore", "ignore", "pipe"] })
  : null;

chrome?.stderr.on("data", (chunk) => {
  const text = String(chunk).trim();
  if (text && !text.includes("INFO:CONSOLE")) {
    emit("chrome_stderr", { text });
  }
});

let cdp = null;
const networkRecorder = createNetworkRecorder();
try {
  const targets = await waitForJson(
    `http://127.0.0.1:${chromePort}/json/list`,
    "Chrome target list",
  );
  const pageTargets = targets.filter((candidate) => candidate.type === "page");
  const target =
    pageTargets.find((candidate) =>
      String(candidate.url ?? "").includes("meet.google.com"),
    ) ??
    pageTargets.find((candidate) =>
      !String(candidate.url ?? "").startsWith("chrome://"),
    ) ??
    pageTargets[0] ??
    targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No debuggable Meet page target found");
  }
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  installCdpLogForwarding(cdp);
  networkRecorder.install(cdp);
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url: meetUrl });
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
    const appearanceClick = await clickFirstAvailable(cdp, [
      "Appearance",
      "Touch-up appearance",
    ]);
    emit("appearance_click", { clicked: appearanceClick });
    await sleep(1000);
    await collectEvidence(cdp, networkRecorder, "state_effects_appearance");
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
  cdp?.close();
  if (chrome && !chrome.killed) {
    chrome.kill("SIGTERM");
  }
  if (chrome) {
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      sleep(1500),
    ]);
  }
  if (createdUserDataDir && userDataDir && !keepUserDataDir) {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
