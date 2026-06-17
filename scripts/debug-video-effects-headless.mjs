#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const chromePath =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeHeadlessFlag =
  process.env.CONCLAVE_CHROME_HEADLESS_FLAG ?? "--headless";
const baseUrl = process.env.CONCLAVE_WEB_URL ?? "http://localhost:3000";
const roomId =
  process.env.CONCLAVE_ROOM_ID ?? `headless-effects-${Date.now()}`;
const expectFaceLandmarks = /^(1|true|yes)$/i.test(
  process.env.CONCLAVE_EXPECT_FACE ?? "",
);
const defaultFakeVideoWidth = expectFaceLandmarks ? 352 : 256;
const defaultFakeVideoHeight = expectFaceLandmarks ? 198 : 144;
const defaultFakeVideoFps = expectFaceLandmarks ? 8 : 6;
const defaultFakeVideoDurationSeconds = expectFaceLandmarks ? 10 : 6;
const fakeVideoDurationSeconds = Number(
  process.env.CONCLAVE_FAKE_VIDEO_DURATION_SECONDS ??
    defaultFakeVideoDurationSeconds,
);
const fakeVideoSourceImage =
  process.env.CONCLAVE_FAKE_VIDEO_SOURCE_IMAGE ?? null;
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.round(parsed));
};
const fakeVideoWidth = parsePositiveInteger(
  process.env.CONCLAVE_FAKE_VIDEO_WIDTH,
  defaultFakeVideoWidth,
);
const fakeVideoHeight = parsePositiveInteger(
  process.env.CONCLAVE_FAKE_VIDEO_HEIGHT,
  defaultFakeVideoHeight,
);
const expectedStableOutputScale = Math.min(
  1,
  1280 / fakeVideoWidth,
  720 / fakeVideoHeight,
);
const expectedStableOutputWidth = Math.max(
  2,
  Math.floor((fakeVideoWidth * expectedStableOutputScale) / 2) * 2,
);
const expectedStableOutputHeight = Math.max(
  2,
  Math.floor((fakeVideoHeight * expectedStableOutputScale) / 2) * 2,
);
const fakeVideoFps = parsePositiveInteger(
  process.env.CONCLAVE_FAKE_VIDEO_FPS,
  defaultFakeVideoFps,
);
const forceDarkVideoProbe = /^(1|true|yes)$/i.test(
  process.env.CONCLAVE_FORCE_DARK_VIDEO_PROBE ?? "",
);
const headlessMobileViewport = /^(1|true|yes)$/i.test(
  process.env.CONCLAVE_HEADLESS_MOBILE ?? "",
);
const headlessViewportWidth = parsePositiveInteger(
  process.env.CONCLAVE_HEADLESS_VIEWPORT_WIDTH,
  headlessMobileViewport ? 390 : 1440,
);
const headlessViewportHeight = parsePositiveInteger(
  process.env.CONCLAVE_HEADLESS_VIEWPORT_HEIGHT,
  headlessMobileViewport ? 844 : 900,
);
const headlessDeviceScaleFactorRaw = Number(
  process.env.CONCLAVE_HEADLESS_DEVICE_SCALE_FACTOR ??
    (headlessMobileViewport ? 2 : 1),
);
const headlessDeviceScaleFactor =
  Number.isFinite(headlessDeviceScaleFactorRaw) &&
  headlessDeviceScaleFactorRaw > 0
    ? headlessDeviceScaleFactorRaw
    : headlessMobileViewport
      ? 2
      : 1;
const headlessEmulateMobile = /^(1|true|yes)$/i.test(
  process.env.CONCLAVE_HEADLESS_EMULATE_MOBILE ??
    (headlessMobileViewport ? "1" : "0"),
);
const headlessTouchEnabled = /^(1|true|yes)$/i.test(
  process.env.CONCLAVE_HEADLESS_TOUCH ??
    (headlessMobileViewport ? "1" : "0"),
);
const headlessWindowSize = `${headlessViewportWidth},${headlessViewportHeight}`;
const defaultFaceFilterLabels = expectFaceLandmarks
  ? [
      "Sparkles",
      "Butterflies",
      "Barely there",
      "Simply radiant",
      "Dewy fresh",
      "Warm glow",
      "Coral hint",
      "Berry blush",
      "Cat eye",
      "Dramatic eye",
      "Lip gloss",
      "Pink dewy",
      "Red lipstick",
      "Rosy pink",
      "Signature statement",
      "Goth chic",
      "Mummy",
      "Zombie",
      "Beach day",
      "Glasses",
      "Cute glasses",
      "Aviator",
      "Cat-eye beret",
      "Cyber glasses",
      "Cat ear headphones",
      "Cat ears and glasses",
      "Cat on head",
      "Fuzzy cat",
      "Halloween cat",
      "Velvety dog",
      "Medium hair and beard",
      "Long wavy hair",
      "Gold crown",
      "Light halo",
      "Bunny ears",
      "Bunny",
      "Working bunny",
      "Cute alien",
      "Cute astronaut",
      "Pirate",
      "Cake",
      "Party hat",
      "Pilot hat",
      "Trucker hat",
      "Glowing hat",
      "Noogler hat",
      "Intern hat",
      "Winter hat and scarf",
      "Wizard hat",
      "Dia de los Muertos",
      "Dia de los Muertos flower",
      "Alien ship",
      "Thin mustache",
      "Mustache",
      "Idea bulb",
    ]
  : ["Sparkles"];
const parseConfiguredLabels = (value, fallback) => {
  if (value === undefined) return fallback;
  if (/^(0|false|none|off|no)$/i.test(value.trim())) return [];
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
};
const faceFilterLabels = parseConfiguredLabels(
  process.env.CONCLAVE_FACE_FILTERS,
  defaultFaceFilterLabels,
);
const faceFilterIdByLabel = new Map([
  ["Sparkles", "sparkles"],
  ["Butterflies", "butterflies"],
  ["Barely there", "makeup-barely-there"],
  ["Simply radiant", "makeup-simply-radiant"],
  ["Dewy fresh", "makeup-dewy-fresh"],
  ["Warm glow", "makeup-warm-glow"],
  ["Coral hint", "makeup-coral-hint"],
  ["Berry blush", "makeup-berry-blush"],
  ["Cat eye", "makeup-cat-eye"],
  ["Dramatic eye", "makeup-dramatic-eye"],
  ["Lip gloss", "makeup-lip-gloss"],
  ["Pink dewy", "makeup-pink-dewy"],
  ["Red lipstick", "makeup-red-lipstick"],
  ["Rosy pink", "makeup-rosy-pink"],
  ["Signature statement", "makeup-signature-statement"],
  ["Goth chic", "makeup-goth-chic"],
  ["Mummy", "makeup-mummy"],
  ["Zombie", "makeup-zombie"],
  ["Beach day", "beach-day"],
  ["Glasses", "glasses"],
  ["Cute glasses", "cute-glasses"],
  ["Aviator", "aviator"],
  ["Cat-eye beret", "cat-eye-beret"],
  ["Cyber glasses", "cyber-glasses"],
  ["Cat ear headphones", "cat-ear-headphones"],
  ["Cat ears and glasses", "cat-ears-glasses"],
  ["Cat on head", "cat-on-head"],
  ["Fuzzy cat", "fuzzy-cat"],
  ["Halloween cat", "halloween-cat"],
  ["Velvety dog", "velvety-dog"],
  ["Medium hair and beard", "hair-medium-beard"],
  ["Long wavy hair", "long-wavy-hair"],
  ["Gold crown", "crown"],
  ["Light halo", "halo"],
  ["Bunny ears", "bunny-ears"],
  ["Bunny", "bunny"],
  ["Working bunny", "working-bunny"],
  ["Cute alien", "cute-alien"],
  ["Cute astronaut", "cute-astronaut"],
  ["Pirate", "pirate"],
  ["Cake", "cake"],
  ["Party hat", "party-hat"],
  ["Pilot hat", "pilot-hat"],
  ["Trucker hat", "trucker-hat"],
  ["Glowing hat", "glowing-hat"],
  ["Noogler hat", "noogler-hat"],
  ["Intern hat", "intern-hat"],
  ["Winter hat and scarf", "winter-hat-scarf"],
  ["Wizard hat", "wizard-hat"],
  ["Dia de los Muertos", "dia-de-los-muertos"],
  ["Dia de los Muertos flower", "dia-de-los-muertos-flower"],
  ["Alien ship", "alien"],
  ["Thin mustache", "thin-mustache"],
  ["Mustache", "mustache"],
  ["Idea bulb", "idea"],
]);
const primaryFaceFilterLabel = faceFilterLabels[0] ?? "Zombie";
const primaryFaceFilterId = faceFilterIdByLabel.get(primaryFaceFilterLabel) ?? null;
const secondaryFaceFilterLabel =
  faceFilterLabels.find((label) => label !== primaryFaceFilterLabel) ?? null;
const secondaryFaceFilterId = secondaryFaceFilterLabel
  ? faceFilterIdByLabel.get(secondaryFaceFilterLabel) ?? null
  : null;
const defaultBackgroundLabels = expectFaceLandmarks
  ? [
      "Slight blur",
      "Blur",
      "Desk motion",
      "Loft motion",
      "Aurora motion",
      "Cyberpunk penthouse",
      "Gaming room",
      "Rainy conservatory",
      "Rainy cafe",
      "Sunny cafe",
      "Rustic cabin",
      "Snowy chalet",
      "Underwater sea lab",
      "Space station",
      "Japanese courtyard",
      "Parisian skyline",
      "Greenhouse",
      "Italian terrace",
      "Physics lab",
      "Lakeside tent",
      "Camper vacation",
      "Dog office",
      "Indian balcony",
      "Arabian cafe terrace",
      "Ocean terrace",
      "Snowy cafe",
      "Office shelf",
      "Conference wall",
      "Warm lounge",
      "Beach pavilion",
      "Tropical beach",
      "Forest light",
      "Accessible patio",
      "Bookshelf",
      "Coffee shop",
      "Home office living room",
      "Modern conference room",
      "Modern Indian living room",
      "Office break room",
      "Office library",
      "Living room close",
      "Living room wide",
      "Shelf with plants",
      "Stylish living room",
      "Color field",
    ]
  : ["Blur"];
const backgroundLabels = parseConfiguredLabels(
  process.env.CONCLAVE_BACKGROUNDS,
  defaultBackgroundLabels,
);
const backgroundIdByLabel = new Map([
  ["Slight blur", "blur-light"],
  ["Blur", "blur-strong"],
  ["Desk motion", "desk-motion"],
  ["Loft motion", "loft-motion"],
  ["Aurora motion", "aurora-motion"],
  ["Cyberpunk penthouse", "cyberpunk-penthouse"],
  ["Gaming room", "gaming-room"],
  ["Rainy conservatory", "rainy-conservatory"],
  ["Rainy cafe", "rainy-cafe"],
  ["Sunny cafe", "sunny-cafe"],
  ["Rustic cabin", "rustic-cabin"],
  ["Snowy chalet", "snowy-chalet"],
  ["Underwater sea lab", "underwater-sea-lab"],
  ["Space station", "space-station"],
  ["Japanese courtyard", "japanese-courtyard"],
  ["Parisian skyline", "parisian-skyline"],
  ["Greenhouse", "greenhouse"],
  ["Italian terrace", "italian-terrace-countryside"],
  ["Physics lab", "physics-lab"],
  ["Lakeside tent", "lakeside-tent"],
  ["Camper vacation", "camper-vacation"],
  ["Dog office", "dog-office"],
  ["Indian balcony", "indian-balcony"],
  ["Arabian cafe terrace", "arabian-cafe-terrace"],
  ["Ocean terrace", "ocean-terrace"],
  ["Snowy cafe", "snowy-cafe"],
  ["Office shelf", "office"],
  ["Conference wall", "studio"],
  ["Warm lounge", "lounge"],
  ["Beach pavilion", "beach"],
  ["Tropical beach", "tropical-beach"],
  ["Forest light", "forest"],
  ["Accessible patio", "accessible-patio"],
  ["Bookshelf", "bookshelf"],
  ["Coffee shop", "coffee-shop"],
  ["Home office", "home-office-bookshelf"],
  ["Home office living room", "home-office-living-room"],
  ["Home sofa", "home-office-sofa"],
  ["Living room close", "living-room-close"],
  ["Living room shelf", "living-room-shelf"],
  ["Living room wide", "living-room-wide"],
  ["Modern conference room", "modern-conference-room"],
  ["Modern Indian living room", "modern-indian-living-room"],
  ["Office break room", "office-break-room"],
  ["Office library", "office-library"],
  ["Office meeting space", "office-meeting-space"],
  ["Office green space", "office-green-space"],
  ["Shelf with plants", "shelf-with-plants"],
  ["Stylish home office", "stylish-home-office"],
  ["Stylish living room", "stylish-living-room-couch"],
  ["Color field", "gradient"],
]);
const meetVideoPipeCombinedBackgroundLabelRaw =
  process.env.CONCLAVE_MEET_VIDEOPIPE_COMBINED_BACKGROUND?.trim() ?? "";
const meetVideoPipeCombinedBackgroundLabel =
  meetVideoPipeCombinedBackgroundLabelRaw &&
  !/^(0|false|none|off|no)$/i.test(meetVideoPipeCombinedBackgroundLabelRaw)
    ? meetVideoPipeCombinedBackgroundLabelRaw
    : null;
const meetVideoPipeCombinedBackgroundId = meetVideoPipeCombinedBackgroundLabel
  ? backgroundIdByLabel.get(meetVideoPipeCombinedBackgroundLabel) ?? null
  : null;
const meetVideoPipeCombinedOrder =
  process.env.CONCLAVE_MEET_VIDEOPIPE_COMBINED_ORDER === "filter-first"
    ? "filter-first"
    : "background-first";
const imageBackedBackgroundIds = new Set([
  "office",
  "studio",
  "lounge",
  "beach",
  "tropical-beach",
  "forest",
  "accessible-patio",
  "bookshelf",
  "coffee-shop",
  "home-office-bookshelf",
  "home-office-living-room",
  "home-office-sofa",
  "living-room-close",
  "living-room-shelf",
  "living-room-wide",
  "modern-conference-room",
  "modern-indian-living-room",
  "office-break-room",
  "office-library",
  "office-meeting-space",
  "office-green-space",
  "shelf-with-plants",
  "stylish-home-office",
  "stylish-living-room-couch",
  "cyberpunk-penthouse",
  "gaming-room",
  "rainy-conservatory",
  "rainy-cafe",
  "sunny-cafe",
  "rustic-cabin",
  "snowy-chalet",
  "underwater-sea-lab",
  "space-station",
  "japanese-courtyard",
  "parisian-skyline",
  "greenhouse",
  "italian-terrace-countryside",
  "physics-lab",
  "lakeside-tent",
  "camper-vacation",
  "dog-office",
  "indian-balcony",
  "arabian-cafe-terrace",
  "ocean-terrace",
  "snowy-cafe",
]);
const hasExplicitFakeVideoPath = Boolean(process.env.CONCLAVE_FAKE_VIDEO);
const fakeVideoPath =
  process.env.CONCLAVE_FAKE_VIDEO ??
  join(
    tmpdir(),
    fakeVideoSourceImage
      ? `conclave-fake-camera-${basename(fakeVideoSourceImage).replace(/[^a-z0-9._-]/gi, "_")}-${fakeVideoWidth}x${fakeVideoHeight}-${fakeVideoFps}fps-${fakeVideoDurationSeconds}s.y4m`
      : `conclave-fake-camera-${fakeVideoWidth}x${fakeVideoHeight}-${fakeVideoFps}fps-${fakeVideoDurationSeconds}s.y4m`,
  );
const maxReusableFakeVideoBytes = parsePositiveInteger(
  process.env.CONCLAVE_MAX_FAKE_VIDEO_BYTES,
  (expectFaceLandmarks ? 10 : 4) * 1024 * 1024,
);
const shouldCleanupLegacyFakeVideos = !/^(0|false|no)$/i.test(
  process.env.CONCLAVE_CLEANUP_LEGACY_FAKE_VIDEOS ?? "1",
);
const timeoutMs = Number(process.env.CONCLAVE_HEADLESS_TIMEOUT_MS ?? 90000);
const chromePort = Number(
  process.env.CONCLAVE_CHROME_DEBUG_PORT ??
    String(9300 + Math.floor(Math.random() * 600)),
);
const minOutputFrameRatio = Number(
  process.env.CONCLAVE_MIN_OUTPUT_FRAME_RATIO ?? 0.93,
);
const maxOutputWriterBackpressureSkips = Number(
  process.env.CONCLAVE_MAX_OUTPUT_WRITER_BACKPRESSURE_SKIPS ?? 1,
);
const maxOutputWriterUnavailableSkips = Number(
  process.env.CONCLAVE_MAX_OUTPUT_WRITER_UNAVAILABLE_SKIPS ?? 2,
);
const maxEffectSwitchVisibleLatencyMs = Number(
  process.env.CONCLAVE_MAX_EFFECT_SWITCH_VISIBLE_LATENCY_MS ?? 120,
);
const maxEffectSwitchDeliveredLatencyMs = Number(
  process.env.CONCLAVE_MAX_EFFECT_SWITCH_DELIVERED_LATENCY_MS ?? 120,
);
const minEffectSwitchLatencySamples = Number(
  process.env.CONCLAVE_MIN_EFFECT_SWITCH_LATENCY_SAMPLES ?? 4,
);
const chromeTargetListTimeoutMs = Number(
  process.env.CONCLAVE_CHROME_TARGET_LIST_TIMEOUT_MS ?? 30000,
);
const maxNormalOutputWriterPendingAgeMs = Number(
  process.env.CONCLAVE_MAX_NORMAL_OUTPUT_WRITER_PENDING_AGE_MS ?? 75,
);
const requireDirectOutputFrame = !/^(0|false|no)$/i.test(
  process.env.CONCLAVE_REQUIRE_DIRECT_OUTPUT_FRAME ?? "1",
);
const minEffectsOutputHeight = Number(
  process.env.CONCLAVE_MIN_EFFECTS_OUTPUT_HEIGHT ??
    (fakeVideoHeight >= 1080 ? 600 : 0),
);
const minEffectsOutputWidth = Number(
  process.env.CONCLAVE_MIN_EFFECTS_OUTPUT_WIDTH ??
    (minEffectsOutputHeight > 0
      ? Math.round(minEffectsOutputHeight * (fakeVideoWidth / fakeVideoHeight))
      : 0),
);
const headlessProbe = process.env.CONCLAVE_HEADLESS_PROBE ?? "all";
const allowedHeadlessProbes = new Set([
  "all",
  "effects",
  "meet-videopipe",
  "permission-blocked-effects",
]);

if (!allowedHeadlessProbes.has(headlessProbe)) {
  throw new Error(`Unknown CONCLAVE_HEADLESS_PROBE: ${headlessProbe}`);
}

const emit = (event, payload = {}) => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}\n`,
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const shellEscape = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const cleanupLegacyFakeVideos = () => {
  if (hasExplicitFakeVideoPath || !shouldCleanupLegacyFakeVideos) return;

  for (const entry of readdirSync(tmpdir())) {
    if (!/^conclave-fake-camera-.*\.y4m$/.test(entry)) continue;

    const path = join(tmpdir(), entry);
    if (path === fakeVideoPath) continue;

    try {
      const { size } = statSync(path);
      if (size <= maxReusableFakeVideoBytes) continue;

      rmSync(path, { force: true });
      emit("fake_video_cleanup_legacy", { path, size });
    } catch (err) {
      emit("fake_video_cleanup_legacy_failed", {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

const ensureFakeVideo = () => {
  if (existsSync(fakeVideoPath)) {
    const size = statSync(fakeVideoPath).size;
    const sourceImageIsFresh =
      !fakeVideoSourceImage ||
      (existsSync(fakeVideoSourceImage) &&
        statSync(fakeVideoPath).mtimeMs >= statSync(fakeVideoSourceImage).mtimeMs);
    if (!hasExplicitFakeVideoPath && size > maxReusableFakeVideoBytes) {
      rmSync(fakeVideoPath, { force: true });
      emit("fake_video_discard_oversized", {
        fakeVideoPath,
        size,
        maxReusableFakeVideoBytes,
      });
    } else if (
      size > 1024 * 1024 &&
      (hasExplicitFakeVideoPath || sourceImageIsFresh)
    ) {
      emit("fake_video_reuse", { fakeVideoPath, size });
      return;
    }
  }

  mkdirSync(dirname(fakeVideoPath), { recursive: true });
  emit("fake_video_generate_start", {
    fakeVideoPath,
    fakeVideoSourceImage,
    width: fakeVideoWidth,
    height: fakeVideoHeight,
    fps: fakeVideoFps,
    durationSeconds: fakeVideoDurationSeconds,
  });

  let args;
  if (fakeVideoSourceImage) {
    if (!existsSync(fakeVideoSourceImage)) {
      throw new Error(
        `CONCLAVE_FAKE_VIDEO_SOURCE_IMAGE does not exist: ${fakeVideoSourceImage}`,
      );
    }
    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-i",
      fakeVideoSourceImage,
      "-vf",
      `scale=${fakeVideoWidth}:${fakeVideoHeight}:force_original_aspect_ratio=decrease,pad=${fakeVideoWidth}:${fakeVideoHeight}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
      "-r",
      String(fakeVideoFps),
      "-t",
      String(fakeVideoDurationSeconds),
      fakeVideoPath,
    ];
  } else {
    const faceX = Math.round(fakeVideoWidth * 0.398);
    const faceY = Math.round(fakeVideoHeight * 0.2);
    const faceW = Math.round(fakeVideoWidth * 0.203);
    const faceH = Math.round(fakeVideoHeight * 0.433);
    const leftEyeX = Math.round(fakeVideoWidth * 0.445);
    const rightEyeX = Math.round(fakeVideoWidth * 0.528);
    const eyeY = Math.round(fakeVideoHeight * 0.328);
    const eyeSize = Math.max(8, Math.round(fakeVideoWidth * 0.025));
    const mouthX = Math.round(fakeVideoWidth * 0.475);
    const mouthY = Math.round(fakeVideoHeight * 0.467);
    const mouthW = Math.round(fakeVideoWidth * 0.072);
    const mouthH = Math.max(4, Math.round(fakeVideoHeight * 0.022));
    const filter =
      `testsrc2=size=${fakeVideoWidth}x${fakeVideoHeight}:rate=${fakeVideoFps},drawbox=x=${faceX}:y=${faceY}:w=${faceW}:h=${faceH}:color=0xf0b38a@0.95:t=fill,drawbox=x=${leftEyeX}:y=${eyeY}:w=${eyeSize}:h=${eyeSize}:color=black@1:t=fill,drawbox=x=${rightEyeX}:y=${eyeY}:w=${eyeSize}:h=${eyeSize}:color=black@1:t=fill,drawbox=x=${mouthX}:y=${mouthY}:w=${mouthW}:h=${mouthH}:color=0x5b2017@1:t=fill,format=yuv420p`;
    args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-t",
      String(fakeVideoDurationSeconds),
      fakeVideoPath,
    ];
  }

  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed creating fake camera video: ${result.stderr || result.stdout}`,
    );
  }
  emit("fake_video_generate_done", {
    fakeVideoPath,
    size: statSync(fakeVideoPath).size,
    width: fakeVideoWidth,
    height: fakeVideoHeight,
    fps: fakeVideoFps,
    durationSeconds: fakeVideoDurationSeconds,
  });
};

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.logs = [];
    this.ws.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
        return;
      }
      this.events.push(data);
      this.collectLog(data);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }

  collectLog(event) {
    if (event.method === "Runtime.consoleAPICalled") {
      const args = event.params.args
        .map((arg) => {
          if ("value" in arg) return String(arg.value);
          return arg.description ?? arg.type;
        })
        .join(" ");
      this.logs.push({
        source: "console",
        level: event.params.type,
        text: args,
      });
    }
    if (event.method === "Log.entryAdded") {
      this.logs.push({
        source: event.params.entry.source,
        level: event.params.entry.level,
        text: event.params.entry.text,
        url: event.params.entry.url,
      });
    }
    if (event.method === "Runtime.exceptionThrown") {
      this.logs.push({
        source: "exception",
        level: "error",
        text:
          event.params.exceptionDetails.text ??
          event.params.exceptionDetails.exception?.description ??
          "Runtime exception",
      });
    }
  }
}

const waitForJson = async (url, label, timeoutMs = 15000) => {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
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

const evalValue = async (cdp, expression, timeout = 10000) => {
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

const pageProbeExpression = `(() => {
  const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const panel = document.querySelector('[data-testid="video-effects-panel"]');
  const panelAttrs = panel
    ? Object.fromEntries(Array.from(panel.attributes)
        .filter((attr) => attr.name.startsWith("data-video-effects"))
        .map((attr) => [attr.name, attr.value]))
    : null;
  let panelStats = null;
  try {
    panelStats = panelAttrs?.["data-video-effects-stats"]
      ? JSON.parse(panelAttrs["data-video-effects-stats"])
      : null;
  } catch {}
  const allButtons = Array.from(document.querySelectorAll("button"));
  const countControl = (label) =>
    allButtons.filter((button) =>
      normalize(button.getAttribute("aria-label")) === label ||
      normalize(button.textContent) === label
    ).length;
  const buttons = allButtons
    .slice(0, 30)
    .map((button) => ({
      text: normalize(button.textContent).slice(0, 80),
      ariaLabel: normalize(button.getAttribute("aria-label")).slice(0, 80),
      disabled: button.disabled,
    }));
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyText: normalize(document.body?.innerText).slice(0, 500),
    hasGrid: Boolean(document.querySelector("[data-meet-view-layout]")),
    hasEffectsPanel: Boolean(panel),
    panelAttrs,
    panelStats,
    effectsButtonCount: countControl("Backgrounds and effects"),
    controlButtonCounts: {
      effects: countControl("Backgrounds and effects"),
      reactions: countControl("Reactions"),
      moreOptions: countControl("More options"),
      leaveCall: countControl("Leave call"),
    },
    videoCount: document.querySelectorAll("video").length,
    videoEffectsFrameMetadataDebug:
      typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
        ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
        : window.__conclaveVideoEffectsFrameMetadataDebug ?? null,
    meetVideoDebug:
      typeof window.__conclaveGetMeetVideoDebug === "function"
        ? window.__conclaveGetMeetVideoDebug()
        : window.__conclaveMeetVideoDebug ?? null,
    buttons,
  };
})()`;

const collectProbe = async (cdp) => {
  try {
    return await evalValue(cdp, pageProbeExpression, 3000);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const meetingToolbarControlsExpression = `(() => {
  const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const buttons = Array.from(document.querySelectorAll("button"));
  const labels = [
    "Backgrounds and effects",
    "Reactions",
    "More options",
    "Leave call",
  ];
  const matches = Object.fromEntries(
    labels.map((label) => [
      label,
      buttons
        .filter((button) =>
          normalize(button.getAttribute("aria-label")) === label ||
          normalize(button.textContent) === label
        )
        .map((button) => ({
          ariaLabel: normalize(button.getAttribute("aria-label")),
          text: normalize(button.textContent),
          disabled: button.disabled,
        })),
    ])
  );
  const counts = Object.fromEntries(
    labels.map((label) => [label, matches[label]?.length ?? 0])
  );
  const effects = matches["Backgrounds and effects"]?.[0];
  const reactions = matches.Reactions?.[0];
  const moreOptions = matches["More options"]?.[0];
  const leaveCall = matches["Leave call"]?.[0];
  return {
    ok:
      counts["Backgrounds and effects"] === 1 &&
      counts.Reactions === 1 &&
      counts["More options"] === 1 &&
      counts["Leave call"] === 1 &&
      effects?.disabled === false &&
      reactions?.disabled === false &&
      moreOptions?.disabled === false &&
      leaveCall?.disabled === false,
    counts,
    matches,
  };
})()`;

const waitFor = async (cdp, label, expression, timeout = timeoutMs) => {
  const started = Date.now();
  let value = null;
  let lastProbeAt = 0;
  while (Date.now() - started < timeout) {
    value = await evalValue(cdp, expression, 3000).catch(() => null);
    if (value) return value;
    const elapsedMs = Date.now() - started;
    if (elapsedMs - lastProbeAt > 5000) {
      lastProbeAt = elapsedMs;
      emit("wait_for_progress", {
        label,
        elapsedMs,
        probe: await collectProbe(cdp),
      });
    }
    await sleep(300);
  }
  emit("wait_for_timeout", {
    label,
    elapsedMs: Date.now() - started,
    lastValue: value,
    probe: await collectProbe(cdp),
  });
  throw new Error(`Timed out waiting for ${label}`);
};

const clickButton = async (cdp, label, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await evalValue(
      cdp,
      `(() => {
        const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const buttons = Array.from(document.querySelectorAll("button"));
        const button = buttons.find((candidate) =>
          normalize(candidate.getAttribute("aria-label")) === ${JSON.stringify(label)} ||
          normalize(candidate.textContent) === ${JSON.stringify(label)}
        ) ?? buttons.find((candidate) =>
          normalize(candidate.textContent).startsWith(${JSON.stringify(label)})
        );
        if (!button || button.disabled) return false;
        button.click();
        return true;
      })()`,
    ).catch(() => false);
    if (ok) return;
    await sleep(150);
  }
  emit("click_button_failed", {
    label,
    elapsedMs: Date.now() - started,
    probe: await collectProbe(cdp),
  });
  throw new Error(`Button not found or disabled: ${label}`);
};

const ensureMeetingToolbarControls = async (cdp) => {
  const hasEffectsEntry = await evalValue(
    cdp,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      return Array.from(document.querySelectorAll("button")).some((button) =>
        normalize(button.getAttribute("aria-label")) === "Backgrounds and effects" ||
        normalize(button.textContent) === "Backgrounds and effects"
      );
    })()`,
  );
  if (!hasEffectsEntry) {
    await clickButton(cdp, "More options");
  }
  const state = await waitFor(
    cdp,
    "meeting toolbar controls",
    `(() => {
      const state = ${meetingToolbarControlsExpression};
      return state.ok ? state : false;
    })()`,
    10000,
  );
  emit("meeting_toolbar_controls_probe", state);
  return state;
};

const openMeetingEffectsPanel = async (cdp, label = "meeting effects panel") => {
  const clickedDirect = await evalValue(
    cdp,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
          (normalize(candidate.getAttribute("aria-label")) === "Backgrounds and effects" ||
            normalize(candidate.textContent) === "Backgrounds and effects" ||
            normalize(candidate.textContent).startsWith("Backgrounds and effects")) &&
          !candidate.disabled
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  ).catch(() => false);

  if (!clickedDirect) {
    await clickButton(cdp, "More options");
    await waitFor(
      cdp,
      `${label} overflow entry`,
      `(() => {
        const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
        const button = Array.from(document.querySelectorAll("button")).find(
          (candidate) =>
            normalize(candidate.getAttribute("aria-label")) === "Backgrounds and effects" ||
            normalize(candidate.textContent) === "Backgrounds and effects" ||
            normalize(candidate.textContent).startsWith("Backgrounds and effects")
        );
        return Boolean(button && !button.disabled);
      })()`,
      10000,
    );
    await clickButton(cdp, "Backgrounds and effects");
  }

  await waitFor(
    cdp,
    label,
    `Boolean(document.querySelector('[data-testid="video-effects-panel"]'))`,
    10000,
  );
};

const clickTestId = async (cdp, testId, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await evalValue(
      cdp,
      `(() => {
        const element = document.querySelector(${JSON.stringify(
          `[data-testid="${testId}"]`,
        )});
        if (!(element instanceof HTMLElement)) return false;
        if (element instanceof HTMLButtonElement && element.disabled) return false;
        element.click();
        return true;
      })()`,
    ).catch(() => false);
    if (ok) return;
    await sleep(150);
  }
  emit("click_test_id_failed", {
    testId,
    elapsedMs: Date.now() - started,
    probe: await collectProbe(cdp),
  });
  throw new Error(`Element not found or disabled: ${testId}`);
};

const turnCameraOnIfNeeded = async (cdp, label) => {
  const cameraState = await waitFor(
    cdp,
    `${label} camera state`,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const liveVideoFromDebug =
        debug?.rawTrack?.readyState === "live" ||
        debug?.localStream?.videoTracks?.some?.((track) => track.readyState === "live") ||
        false;
      const liveVideoFromElement = Array.from(document.querySelectorAll("video")).some((video) => {
        const stream = video.srcObject;
        const tracks = stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
        return tracks.some((track) => track.readyState === "live");
      });
      const alreadyOn =
        debug?.isCameraOff === false && (liveVideoFromDebug || liveVideoFromElement);
      const turnOnButton = Array.from(document.querySelectorAll("button")).find(
        (candidate) =>
          candidate.getAttribute("aria-label") === "Turn on camera" ||
          (candidate.textContent || "").includes("Turn on camera")
      );
      const turnOnReady = Boolean(turnOnButton && !turnOnButton.disabled);
      if (!alreadyOn && !turnOnReady) return false;
      return {
        alreadyOn,
        turnOnReady,
        connectionState: debug?.connectionState ?? null,
        isCameraOff: debug?.isCameraOff ?? null,
        liveVideoFromDebug,
        liveVideoFromElement,
      };
    })()`,
    30000,
  );
  emit("turn_camera_on_if_needed_state", { label, cameraState });
  if (cameraState.alreadyOn) return;

  await clickButton(cdp, "Turn on camera", 10000);
  await waitFor(
    cdp,
    label,
    `(() => {
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const liveVideoFromDebug =
        debug?.rawTrack?.readyState === "live" ||
        debug?.localStream?.videoTracks?.some?.((track) => track.readyState === "live") ||
        false;
      const liveVideoFromElement = Array.from(document.querySelectorAll("video")).some((video) => {
        const stream = video.srcObject;
        const tracks = stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
        return tracks.some((track) => track.readyState === "live");
      });
      return debug?.isCameraOff === false && (liveVideoFromDebug || liveVideoFromElement);
    })()`,
    30000,
  );
};

const setRangeValue = async (cdp, selector, value) => {
  const ok = await evalValue(
    cdp,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement)) return false;
      const nextValue = ${JSON.stringify(String(value))};
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      if (valueSetter) {
        valueSetter.call(input, nextValue);
      } else {
        input.value = nextValue;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
  if (!ok) throw new Error(`Range input not found: ${selector}`);
};

const dragButtonToCorner = async (cdp, label, corner) => {
  const ok = await evalValue(
    cdp,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => normalize(candidate.getAttribute("aria-label")) === ${JSON.stringify(label)}
      );
      const grid = document.querySelector("[data-meet-view-layout]");
      if (!button || !grid || typeof PointerEvent !== "function") return false;
      const buttonRect = button.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const target = ${JSON.stringify(corner)};
      const endX = target.endsWith("left")
        ? gridRect.left + 28
        : gridRect.right - 28;
      const endY = target.startsWith("top")
        ? gridRect.top + 28
        : gridRect.bottom - 28;
      const pointerId = 77;
      button.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId,
        clientX: buttonRect.left + buttonRect.width / 2,
        clientY: buttonRect.top + buttonRect.height / 2,
      }));
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId,
        clientX: endX,
        clientY: endY,
      }));
      window.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId,
        clientX: endX,
        clientY: endY,
      }));
      return true;
    })()`,
  );
  if (!ok) throw new Error(`Drag handle not found: ${label}`);
};

const collectLayoutStateExpression = `(() => {
  const grid = document.querySelector("[data-meet-view-layout]");
  const mobileGrid = document.querySelector("[data-mobile-room-tiling-source='client']");
  const layoutRoot = grid ?? mobileGrid;
  const attrs = layoutRoot
    ? Object.fromEntries(Array.from(layoutRoot.attributes)
        .filter((attr) =>
          attr.name.startsWith("data-meet-view") ||
          attr.name.startsWith("data-meet-room-tiling") ||
          attr.name.startsWith("data-mobile")
        )
        .map((attr) => [attr.name, attr.value]))
    : null;
  const tileSelector = grid
    ? ".acm-video-tile"
    : "[data-mobile-grid-tile] > .mobile-tile, .mobile-grid-tile > .mobile-tile";
  const tiles = Array.from(document.querySelectorAll(tileSelector)).map((tile, index) => {
    const rect = tile.getBoundingClientRect();
    const tileStyle = getComputedStyle(tile);
    const videos = Array.from(tile.querySelectorAll("video")).map((video) => {
      const videoRect = video.getBoundingClientRect();
      return {
        objectFit: video.getAttribute("data-video-object-fit") || "",
        objectPosition: getComputedStyle(video).objectPosition || "",
        width: Math.round(videoRect.width),
        height: Math.round(videoRect.height),
        left: Math.round(videoRect.left),
        top: Math.round(videoRect.top),
        visible:
          videoRect.width > 2 &&
          videoRect.height > 2 &&
          getComputedStyle(video).display !== "none" &&
          getComputedStyle(video).visibility !== "hidden",
      };
    });
    return {
      index,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      visible:
        rect.width > 2 &&
        rect.height > 2 &&
        tileStyle.display !== "none" &&
        tileStyle.visibility !== "hidden" &&
        tileStyle.opacity !== "0",
      ariaHidden: tile.getAttribute("aria-hidden") || "",
      text: (tile.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      videoFits: videos,
    };
  });
  return {
    url: location.href,
    layoutKind: grid ? "desktop" : mobileGrid ? "mobile" : "unknown",
    attrs,
    roomTilingDebug: typeof window.__conclaveGetMeetRoomTilingDebug === "function"
      ? window.__conclaveGetMeetRoomTilingDebug()
      : null,
    tileCount: tiles.length,
    tiles,
  };
})()`;

const collectLayoutState = async (cdp, event) => {
  const state = await evalValue(cdp, collectLayoutStateExpression);
  emit(event, state);
  const visibleTiles = (state.tiles || []).filter((tile) => tile.visible);
  const geometryFailures = visibleTiles.filter(
    (tile) => Number(tile.width || 0) <= 2 || Number(tile.height || 0) <= 2,
  );
  if (state.attrs && (visibleTiles.length === 0 || geometryFailures.length > 0)) {
    throw new Error(
      `Layout geometry regression at ${event}: ${JSON.stringify({
        visibleTileCount: visibleTiles.length,
        geometryFailures,
        attrs: state.attrs,
      })}`,
    );
  }
  return state;
};

const collectMobileRoomTilingProbe = async (cdp, event) => {
  const probe = await waitFor(
    cdp,
    event,
    `(() => {
      const root = document.querySelector("[data-mobile-room-tiling-source='client']");
      if (!root) return false;
      const attrs = Object.fromEntries(
        Array.from(root.attributes)
          .filter((attr) => attr.name.startsWith("data-mobile"))
          .map((attr) => [attr.name, attr.value])
      );
      const parseJson = (value, fallback) => {
        try {
          return JSON.parse(value || "");
        } catch {
          return fallback;
        }
      };
      const debug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
        ? window.__conclaveGetMeetRoomTilingDebug()
        : null;
      const current = debug?.current;
      const tileRects = Array.from(
        document.querySelectorAll("[data-mobile-grid-tile]")
      ).map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          id: tile.getAttribute("data-mobile-grid-tile") || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible:
            rect.width > 2 &&
            rect.height > 2 &&
            getComputedStyle(tile).display !== "none" &&
            getComputedStyle(tile).visibility !== "hidden",
        };
      });
      const visibleTiles = tileRects.filter((tile) => tile.visible);
      const scores = parseJson(attrs["data-mobile-room-tiling-scores"], []);
      const warmReasons = parseJson(attrs["data-mobile-warm-reasons"], {});
      const primaryIds = (attrs["data-mobile-primary-ids"] || "")
        .split(",")
        .filter(Boolean);
      const gridTileIds = (attrs["data-mobile-grid-visible-tile-ids"] || "")
        .split(",")
        .filter(Boolean);
      const ok =
        attrs["data-mobile-room-tiling-source"] === "client" &&
        attrs["data-mobile-room-tiling-metadata-interval"] === "200" &&
        attrs["data-mobile-room-tiling-promote-delay"] === "220" &&
        attrs["data-mobile-room-tiling-min-switch-interval"] === "2200" &&
        attrs["data-mobile-max-tiles"] === "9" &&
        attrs["data-mobile-warm-hold"] === "3500" &&
        Number(attrs["data-mobile-visible-count"] || 0) >= 1 &&
        Number(attrs["data-mobile-total-people"] || 0) >= 1 &&
        Number(attrs["data-mobile-grid-cols"] || 0) >= 1 &&
        Number(attrs["data-mobile-grid-rows"] || 0) >= 1 &&
        primaryIds.length >= 1 &&
        gridTileIds.length >= 1 &&
        visibleTiles.length >= 1 &&
        scores.every((item, index) =>
          typeof item.id === "string" &&
          item.rank === index &&
          typeof item.score === "number" &&
          typeof item.visible === "boolean" &&
          typeof item.hidden === "boolean" &&
          typeof item.warm === "boolean" &&
          Array.isArray(item.warmReasons)
        ) &&
        warmReasons &&
        typeof warmReasons === "object" &&
        debug?.intervalMs === 200 &&
        Number(debug?.sequence || 0) >= 1 &&
        Array.isArray(debug?.history) &&
        debug.history.length >= 1 &&
        current?.source === "client" &&
        current?.intervalMs === 200 &&
        current?.promoteDelayMs === 220 &&
        current?.minSwitchIntervalMs === 2200 &&
        current?.requestedMode === "auto" &&
        ["solo", "tiled"].includes(current?.renderedMode) &&
        current?.dynamicCrop === false &&
        Array.isArray(current?.primaryIds) &&
        current.primaryIds.length >= 1 &&
        Number(current?.counts?.maxTiles || 0) === 9 &&
        Number(current?.counts?.totalGrid || 0) >= 1 &&
        Number(current?.layout?.tileWidth || 0) > 0 &&
        Number(current?.layout?.tileHeight || 0) > 0 &&
        Array.isArray(current?.layout?.positions) &&
        current.layout.positions.length >= 1 &&
        current?.signature?.length > 20;
      return ok ? {
        ok,
        attrs,
        tileRects,
        current,
        historyLength: debug.history.length,
      } : false;
    })()`,
    10000,
  );
  emit(event, probe);
  return probe;
};

const collectMobileMoreMenuProbe = async (cdp, event) => {
  const probe = await waitFor(
    cdp,
    event,
    `(() => {
      const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
      const moreButton = Array.from(document.querySelectorAll("button")).find(
        (button) => normalize(button.getAttribute("aria-label")) === "More actions"
      );
      moreButton?.click();
      const root = document.querySelector("[data-mobile-more-menu-state]");
      if (!root || root.getAttribute("data-mobile-more-menu-state") !== "open") {
        return false;
      }
      const actions = Array.from(
        root.querySelectorAll("[data-mobile-more-action]")
      ).map((button, index) => ({
        index,
        action: button.getAttribute("data-mobile-more-action") || "",
        state: button.getAttribute("data-mobile-more-action-state") || "",
        aria: normalize(button.getAttribute("aria-label")),
        text: normalize(button.textContent),
        pressed: button.getAttribute("aria-pressed"),
        disabled: Boolean(button.disabled),
      }));
      const effects = actions.find((action) => action.action === "effects");
      const ok =
        root.getAttribute("data-mobile-video-effects-permission-blocked") === "false" &&
        root.getAttribute("data-mobile-video-effects-active-count") === "0" &&
        root.getAttribute("data-mobile-video-effects-open") === "false" &&
        root.getAttribute("data-mobile-video-effects-state") === "Off" &&
        actions[0]?.action === "effects" &&
        actions[1]?.action === "participants" &&
        actions[2]?.action === "settings" &&
        effects?.state === "Off" &&
        effects?.aria === "Backgrounds and effects, off" &&
        /Backgrounds and effects/.test(effects?.text || "") &&
        /Off/.test(effects?.text || "") &&
        effects?.pressed === "false" &&
        effects?.disabled === false;
      return ok ? {
        ok,
        attrs: Object.fromEntries(
          Array.from(root.attributes)
            .filter((attr) => attr.name.startsWith("data-mobile"))
            .map((attr) => [attr.name, attr.value])
        ),
        actions,
      } : false;
    })()`,
    5000,
  );
  emit(event, probe);
  return probe;
};

const collectStateExpression = `(() => {
  const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const panel = document.querySelector('[data-testid="video-effects-panel"]');
  const panelAttrs = panel
    ? Object.fromEntries(Array.from(panel.attributes)
        .filter((attr) => attr.name.startsWith("data-video-effects"))
        .map((attr) => [attr.name, attr.value]))
    : null;
  let panelStats = null;
  try {
    panelStats = panelAttrs?.["data-video-effects-stats"]
      ? JSON.parse(panelAttrs["data-video-effects-stats"])
      : null;
  } catch {}
  const effectsButton = Array.from(document.querySelectorAll("button")).find(
    (button) =>
      normalize(button.getAttribute("aria-label")) === "Backgrounds and effects" ||
      normalize(button.textContent) === "Backgrounds and effects",
  );
  const selected = panel
    ? Array.from(panel.querySelectorAll("button"))
        .map((button) => ({
          text: (button.textContent || "").replace(/\\s+/g, " ").trim(),
          pressed: button.getAttribute("aria-pressed"),
        }))
        .filter((item) => item.pressed === "true")
    : [];
  const videos = Array.from(document.querySelectorAll("video")).map((video, index) => {
    const rect = video.getBoundingClientRect();
    const stream = video.srcObject;
    const tracks = stream && typeof stream.getTracks === "function"
      ? stream.getTracks().map((track) => ({
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        }))
      : [];
    return {
      index,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      paused: video.paused,
      ended: video.ended,
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      tracks,
    };
  });
  return {
    url: location.href,
    text: document.body.innerText.slice(0, 600),
    hasGrid: Boolean(document.querySelector("[data-meet-view-layout]")),
    effectsButtonEnabled: effectsButton ? !effectsButton.disabled : false,
    panelAttrs,
    panelStats,
    videoEffectsFrameMetadataDebug:
      typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
        ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
        : window.__conclaveVideoEffectsFrameMetadataDebug ?? null,
    meetVideoDebug:
      typeof window.__conclaveGetMeetVideoDebug === "function"
        ? window.__conclaveGetMeetVideoDebug()
        : window.__conclaveMeetVideoDebug ?? null,
    selected,
    videos,
  };
})()`;

const collectState = async (cdp, event) => {
  const state = await evalValue(cdp, collectStateExpression);
  emit(event, state);
  return state;
};

const getOutputWriterQuality = (state, label) => {
  const framePipeline = state.panelStats?.framePipeline ?? null;
  const outputWriter = framePipeline?.outputWriter ?? null;
  const lastFrame = framePipeline?.lastFrame ?? null;
  const segmentationWorkerResult =
    framePipeline?.segmentationProcessor?.latestWorkerResult ?? null;
  const faceWorkerResult =
    framePipeline?.faceProcessor?.latestWorkerResult ?? null;
  const frameSequence = Number(framePipeline?.frameSequence || 0);
  const outputFrameSequence = Number(framePipeline?.outputFrameSequence || 0);
  const workerBackpressureSkipCount = Number(
    outputWriter?.workerBackpressureSkipCount || 0,
  );
  const workerCadenceSkipCount = Number(
    outputWriter?.workerCadenceSkipCount || 0,
  );
  const workerUnavailableSkipCount = Number(
    outputWriter?.workerUnavailableSkipCount || 0,
  );
  const workerWriteFailures = Number(outputWriter?.workerWriteFailures || 0);
  const workerPostFailures = Number(outputWriter?.workerPostFailures || 0);
  const workerPendingFrameCount = Number(
    outputWriter?.workerPendingFrameCount || 0,
  );
  const acknowledgedOutputFrameRatio =
    frameSequence > 0 ? outputFrameSequence / frameSequence : 0;
  const effectiveOutputFrameSequence =
    outputFrameSequence + Math.min(workerPendingFrameCount, 1);
  const outputFrameRatio =
    frameSequence > 0 ? effectiveOutputFrameSequence / frameSequence : 0;
  const directFrameHealthy =
    !requireDirectOutputFrame ||
    (outputWriter?.workerInputMode === "video-frame" &&
      outputWriter?.latestWorkerFrameMetadata?.inputMode === "video-frame" &&
      outputWriter?.workerRenderer === "direct-video-frame" &&
      outputWriter?.workerVideoFrameUnsupported !== true);
  const modelInputHealthy =
    (!segmentationWorkerResult ||
      (Number(segmentationWorkerResult.width || 0) > 0 &&
        Number(segmentationWorkerResult.height || 0) > 0 &&
        Number(segmentationWorkerResult.width || 0) <=
          Math.min(fakeVideoWidth, 640) &&
        Number(segmentationWorkerResult.height || 0) <=
          Math.min(fakeVideoHeight, 360))) &&
    (!faceWorkerResult ||
      (Number(faceWorkerResult.width || 0) > 0 &&
        Number(faceWorkerResult.height || 0) > 0 &&
        Number(faceWorkerResult.width || 0) <= Math.min(fakeVideoWidth, 720) &&
        Number(faceWorkerResult.height || 0) <= Math.min(fakeVideoHeight, 405)));
  const outputWidth = Number(lastFrame?.outputWidth || 0);
  const outputHeight = Number(lastFrame?.outputHeight || 0);
  const activeEffectCount = Number(
    state.panelAttrs?.["data-video-effects-active-count"] || 0,
  );
  const outputTrackPublished =
    state.panelAttrs?.["data-video-effects-output-published"] === "true" ||
    framePipeline?.outputTrackPublished === true;
  const shouldCheckOutputResolution =
    minEffectsOutputHeight > 0 &&
    activeEffectCount > 0 &&
    outputTrackPublished &&
    framePipeline?.outputMode === "track-generator";
  const outputResolutionHealthy =
    !shouldCheckOutputResolution ||
    (outputWidth >= minEffectsOutputWidth &&
      outputHeight >= minEffectsOutputHeight);
  const ok =
    framePipeline?.outputMode === "track-generator" &&
    outputWriter?.mode === "worker" &&
    outputWriter?.workerReady === true &&
    outputWriter?.workerFirstFrameSeen === true &&
    Number(outputWriter?.workerFramesWritten || 0) >= 8 &&
    frameSequence >= 8 &&
    outputFrameSequence >= 8 &&
    outputFrameRatio >= minOutputFrameRatio &&
    workerCadenceSkipCount === 0 &&
    workerBackpressureSkipCount <= maxOutputWriterBackpressureSkips &&
    workerUnavailableSkipCount <= maxOutputWriterUnavailableSkips &&
    workerWriteFailures === 0 &&
    workerPostFailures === 0 &&
    workerPendingFrameCount <= 1 &&
    directFrameHealthy &&
    modelInputHealthy &&
    outputResolutionHealthy;
  return {
    label,
    ok,
    frameSequence,
    outputFrameSequence,
    effectiveOutputFrameSequence,
    outputFrameRatio: Number(outputFrameRatio.toFixed(3)),
    acknowledgedOutputFrameRatio: Number(
      acknowledgedOutputFrameRatio.toFixed(3),
    ),
    minOutputFrameRatio,
    requireDirectOutputFrame,
    minEffectsOutputWidth,
    minEffectsOutputHeight,
    outputWidth,
    outputHeight,
    outputScale: Number(lastFrame?.outputScale ?? 0),
    activeEffectCount,
    outputTrackPublished,
    shouldCheckOutputResolution,
    outputResolutionHealthy,
    workerInputMode: outputWriter?.workerInputMode ?? null,
    workerRenderer: outputWriter?.workerRenderer ?? null,
    workerVideoFrameUnsupported:
      outputWriter?.workerVideoFrameUnsupported ?? null,
    workerBackpressureSkipCount,
    maxOutputWriterBackpressureSkips,
    workerCadenceSkipCount,
    workerUnavailableSkipCount,
    maxOutputWriterUnavailableSkips,
    workerWriteFailures,
    workerPostFailures,
    workerPendingFrameCount,
    modelInputHealthy,
    segmentationWorkerInput: segmentationWorkerResult
      ? {
          width: segmentationWorkerResult.width ?? null,
          height: segmentationWorkerResult.height ?? null,
        }
      : null,
    faceWorkerInput: faceWorkerResult
      ? {
          width: faceWorkerResult.width ?? null,
          height: faceWorkerResult.height ?? null,
        }
      : null,
    latestWorkerFrameBuildMs: outputWriter?.latestWorkerFrameBuildMs ?? null,
    averageWorkerFrameBuildMs: outputWriter?.averageWorkerFrameBuildMs ?? null,
    maxWorkerFrameBuildMs: outputWriter?.maxWorkerFrameBuildMs ?? null,
    latestWorkerWriteMs: outputWriter?.latestWorkerWriteMs ?? null,
    latestWorkerRoundTripMs: outputWriter?.latestWorkerRoundTripMs ?? null,
  };
};

const assertOutputWriterQuality = (state, label) => {
  const quality = getOutputWriterQuality(state, label);
  emit("output_writer_quality_probe", quality);
  if (!quality.ok) {
    throw new Error(
      `Output writer quality regression at ${label}: ${JSON.stringify(
        quality,
      )}`,
    );
  }
  return quality;
};

const parseEffectSwitchLatencyLogs = (logs, options = {}) => {
  const startIndex = Math.max(0, Number(options.fromIndex || 0));
  const samples = [];
  for (const log of logs.slice(startIndex)) {
    const match = log.text.match(
      /\[VideoEffects#(\d+)\]\s+effect_switch_visible_output\s+(\{.*\})$/,
    );
    if (!match) continue;
    try {
      const payload = JSON.parse(match[2]);
      samples.push({
        instanceId: Number(match[1]),
        timestamp: log.timestamp,
        sequence: Number(payload.sequence || 0),
        reason: payload.reason ?? null,
        firstDeliveredLatencyMs:
          payload.firstDeliveredLatencyMs === null ||
          payload.firstDeliveredLatencyMs === undefined
            ? null
            : Number(payload.firstDeliveredLatencyMs),
        firstVisibleLatencyMs:
          payload.firstVisibleLatencyMs === null ||
          payload.firstVisibleLatencyMs === undefined
            ? null
            : Number(payload.firstVisibleLatencyMs),
        outputMode: payload.outputMode ?? null,
        outputFramesWritten: Number(payload.outputFramesWritten || 0),
        processingConfigId: Number(payload.processingConfigId || 0),
        modelProcessingConfigId: Number(payload.modelProcessingConfigId || 0),
      });
    } catch {}
  }
  return samples;
};

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseVideoEffectsEventLogs = (logs, eventName, options = {}) => {
  const startIndex = Math.max(0, Number(options.fromIndex || 0));
  const pattern = new RegExp(
    `\\[VideoEffects#(\\d+)\\]\\s+${escapeRegExp(eventName)}\\s+(\\{.*\\})$`,
  );
  const events = [];
  for (const log of logs.slice(startIndex)) {
    const match = log.text.match(pattern);
    if (!match) continue;
    try {
      events.push({
        instanceId: Number(match[1]),
        timestamp: log.timestamp,
        payload: JSON.parse(match[2]),
      });
    } catch {}
  }
  return events;
};

const isEffectsPanelOpenReason = (reason) =>
  typeof reason === "string" && reason.endsWith("effects-panel-open");

const getEffectsPanelOpenPrewarmScopeQuality = (
  logs,
  label,
  options = {},
) => {
  const prewarmRequests = parseVideoEffectsEventLogs(
    logs,
    "prewarm_requested",
    options,
  ).filter((event) => isEffectsPanelOpenReason(event.payload?.reason));
  const backgroundQueueStarts = parseVideoEffectsEventLogs(
    logs,
    "background_prewarm_queue_start",
    options,
  ).filter((event) => isEffectsPanelOpenReason(event.payload?.reason));
  const requestedBackgroundCounts = prewarmRequests.map((event) =>
    Array.isArray(event.payload?.backgrounds)
      ? event.payload.backgrounds.length
      : 0,
  );
  const queuedBackgroundCounts = backgroundQueueStarts.map((event) =>
    Number(event.payload?.count || 0),
  );
  const maxRequestedBackgrounds =
    requestedBackgroundCounts.length > 0
      ? Math.max(...requestedBackgroundCounts)
      : 0;
  const maxQueuedBackgrounds =
    queuedBackgroundCounts.length > 0
      ? Math.max(...queuedBackgroundCounts)
      : 0;
  const bulkQueues = backgroundQueueStarts.filter(
    (event) => event.payload?.bulk === true || Number(event.payload?.count) > 1,
  );
  return {
    label,
    ok:
      maxRequestedBackgrounds <= 1 &&
      maxQueuedBackgrounds <= 1 &&
      bulkQueues.length === 0,
    requestCount: prewarmRequests.length,
    backgroundQueueStartCount: backgroundQueueStarts.length,
    maxRequestedBackgrounds,
    maxQueuedBackgrounds,
    bulkQueueCount: bulkQueues.length,
    recentRequests: prewarmRequests.slice(-4),
    recentBackgroundQueues: backgroundQueueStarts.slice(-4),
  };
};

const assertEffectsPanelOpenPrewarmScope = (logs, label, options = {}) => {
  const quality = getEffectsPanelOpenPrewarmScopeQuality(logs, label, options);
  emit("effects_panel_open_prewarm_scope_probe", quality);
  if (!quality.ok) {
    throw new Error(
      `Effects panel open prewarm scope regression at ${label}: ${JSON.stringify(
        quality,
      )}`,
    );
  }
  return quality;
};

const percentile = (values, ratio) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
};

const getEffectSwitchLatencyQuality = (logs, state, label, options = {}) => {
  const samples = parseEffectSwitchLatencyLogs(logs, options);
  const requiredSampleCount = Math.max(
    1,
    Number.isFinite(Number(options.minSamples))
      ? Number(options.minSamples)
      : minEffectSwitchLatencySamples,
  );
  const visibleLatencies = samples
    .map((sample) => sample.firstVisibleLatencyMs)
    .filter((value) => Number.isFinite(value));
  const deliveredLatencies = samples
    .map((sample) => sample.firstDeliveredLatencyMs)
    .filter((value) => Number.isFinite(value));
  const maxVisibleLatencyMs =
    visibleLatencies.length > 0 ? Math.max(...visibleLatencies) : null;
  const maxDeliveredLatencyMs =
    deliveredLatencies.length > 0 ? Math.max(...deliveredLatencies) : null;
  const panelLatency = state.panelStats?.effectSwitchLatency ?? null;
  const panelPending =
    panelLatency?.sequence > 0 && panelLatency?.pending === true;
  const visibleWithinBudget =
    maxVisibleLatencyMs === null ||
    maxVisibleLatencyMs <= maxEffectSwitchVisibleLatencyMs;
  const deliveredWithinBudget =
    maxDeliveredLatencyMs === null ||
    maxDeliveredLatencyMs <= maxEffectSwitchDeliveredLatencyMs;
  const enoughSamples = samples.length >= requiredSampleCount;
  const slowSamples = samples.filter((sample) => {
    const visibleSlow =
      Number.isFinite(sample.firstVisibleLatencyMs) &&
      sample.firstVisibleLatencyMs > maxEffectSwitchVisibleLatencyMs;
    const deliveredSlow =
      Number.isFinite(sample.firstDeliveredLatencyMs) &&
      sample.firstDeliveredLatencyMs > maxEffectSwitchDeliveredLatencyMs;
    return visibleSlow || deliveredSlow;
  });
  return {
    label,
    ok:
      enoughSamples &&
      visibleWithinBudget &&
      deliveredWithinBudget &&
      !panelPending,
    sampleCount: samples.length,
    minEffectSwitchLatencySamples: requiredSampleCount,
    defaultMinEffectSwitchLatencySamples: minEffectSwitchLatencySamples,
    maxEffectSwitchVisibleLatencyMs,
    maxEffectSwitchDeliveredLatencyMs,
    maxVisibleLatencyMs,
    maxDeliveredLatencyMs,
    p50VisibleLatencyMs: percentile(visibleLatencies, 0.5),
    p95VisibleLatencyMs: percentile(visibleLatencies, 0.95),
    p50DeliveredLatencyMs: percentile(deliveredLatencies, 0.5),
    p95DeliveredLatencyMs: percentile(deliveredLatencies, 0.95),
    panelLatency,
    panelPending,
    sampleLogStartIndex: Math.max(0, Number(options.fromIndex || 0)),
    slowSamples,
    recentSamples: samples.slice(-8),
  };
};

const assertEffectSwitchLatencyQuality = (logs, state, label, options = {}) => {
  const quality = getEffectSwitchLatencyQuality(logs, state, label, options);
  emit("effect_switch_latency_quality_probe", quality);
  if (!quality.ok) {
    throw new Error(
      `Effect switch latency regression at ${label}: ${JSON.stringify(
        quality,
      )}`,
    );
  }
  return quality;
};

const waitForMeetVideoPublish = async (cdp, label, mode = "processed") => {
  const eventLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  await waitFor(
    cdp,
    label,
    `(() => {
      const debug =
        typeof window.__conclaveGetMeetVideoDebug === "function"
          ? window.__conclaveGetMeetVideoDebug()
          : window.__conclaveMeetVideoDebug ?? null;
      const producer = debug?.videoProducer;
      const track = producer?.track;
      const publish = debug?.publish;
      const producerHealthy =
        debug?.connectionState === "joined" &&
        debug?.isCameraOff === false &&
        producer &&
        producer.closed === false &&
        track?.readyState === "live" &&
        track?.enabled !== false &&
        publish?.producerTrackLive === true;
      if (!producerHealthy) return false;
      if (${JSON.stringify(mode)} === "processed") {
        return publish?.shouldPublishProcessed === true &&
          publish?.usingProcessedTrack === true;
      }
      if (${JSON.stringify(mode)} === "raw") {
        return publish?.shouldPublishProcessed === false &&
          publish?.usingRawTrack === true;
      }
      return publish?.usingProcessedTrack === true || publish?.usingRawTrack === true;
    })()`,
    20000,
  );
  const state = await collectState(cdp, `meet_video_publish_${eventLabel}`);
  emit("meet_video_publish_probe", {
    label,
    mode,
    meetVideoDebug: state.meetVideoDebug ?? null,
  });
  return state;
};

const runMeetVideoPipeProbe = async (
  cdp,
  {
    cameraToggleLivePrewarmRequested,
    cameraToggleLivePrewarmDone,
  } = {},
) => {
  if (!primaryFaceFilterId) {
    throw new Error(
      `Unknown CONCLAVE_FACE_FILTERS label for Meet VideoPipe probe: ${primaryFaceFilterLabel}`,
    );
  }
  if (meetVideoPipeCombinedBackgroundLabel && !meetVideoPipeCombinedBackgroundId) {
    throw new Error(
      `Unknown CONCLAVE_MEET_VIDEOPIPE_COMBINED_BACKGROUND label: ${meetVideoPipeCombinedBackgroundLabel}`,
    );
  }

  const probeLogStartIndex = cdp.logs.length;
  const selectCombinedBackground = async () => {
    if (!meetVideoPipeCombinedBackgroundId) return;
    await clickButton(cdp, "Backgrounds");
    await sleep(75);
    await clickButton(cdp, meetVideoPipeCombinedBackgroundLabel, 10000);
    await waitFor(
      cdp,
      `${meetVideoPipeCombinedBackgroundLabel} background before Meet VideoPipe filter`,
      `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const render = stats?.backgroundRender;
      return panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
        stats?.effects?.background === ${JSON.stringify(meetVideoPipeCombinedBackgroundId)} &&
        render?.background === ${JSON.stringify(meetVideoPipeCombinedBackgroundId)} &&
        render?.active === true;
      })()`,
      30000,
    );
  };
  const selectPrimaryMeetVideoPipeFilter = async () => {
    await clickButton(cdp, "Filters");
    await sleep(75);
    await clickButton(cdp, primaryFaceFilterLabel, 10000);
  };
  const waitForDirectMeetVideoPipeFilter = async () => {
    await waitFor(
      cdp,
      `${primaryFaceFilterLabel} Meet VideoPipe filter before combined background`,
      `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const debug = window.__conclaveGetMeetVideoDebug?.();
      const producer = debug?.videoProducer;
      return panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        stats?.effects?.filter === ${JSON.stringify(primaryFaceFilterId)} &&
        stats?.outputMode === "meet-videopipe" &&
        stats?.meetVideoPipe?.active === true &&
        stats?.meetVideoPipe?.mode === "direct" &&
        stats?.meetVideoPipe?.outputTrack?.readyState === "live" &&
        debug?.publish?.usingProcessedTrack === true &&
        debug?.publish?.usingRawTrack === false &&
        producer?.track?.readyState === "live";
      })()`,
      30000,
    );
  };
  if (
    meetVideoPipeCombinedBackgroundId &&
    meetVideoPipeCombinedOrder === "background-first"
  ) {
    await selectCombinedBackground();
  }
  await selectPrimaryMeetVideoPipeFilter();
  if (
    meetVideoPipeCombinedBackgroundId &&
    meetVideoPipeCombinedOrder === "filter-first"
  ) {
    await waitForDirectMeetVideoPipeFilter();
    await selectCombinedBackground();
  }

  const collectRelevantLogs = () =>
    cdp.logs
      .slice(probeLogStartIndex)
      .filter((log) =>
        /meet_videopipe|VideoPipe|video.?pipe|black_output|release_processed|skip_replace|track ended|VideoFrame was garbage collected/i.test(
          log.text,
        ),
      )
      .slice(-80);

  let outputProbe;
  try {
    outputProbe = await waitFor(
      cdp,
      `Meet VideoPipe ${primaryFaceFilterLabel} output`,
      `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const meetVideoPipe = stats?.meetVideoPipe;
      const debug =
        typeof window.__conclaveGetMeetVideoDebug === "function"
          ? window.__conclaveGetMeetVideoDebug()
          : window.__conclaveMeetVideoDebug ?? null;
      const producer = debug?.videoProducer;
      const producerTrack = producer?.track;
      const publish = debug?.publish;
      const combinedBackgroundId = ${JSON.stringify(meetVideoPipeCombinedBackgroundId)};
      const selectedFilter = combinedBackgroundId
        ? debug?.videoEffects?.filter ?? stats?.effects?.filter ?? null
        : stats?.effects?.filter ?? debug?.videoEffects?.filter ?? null;
      const blackOutputFrameCount = Number(
        panel?.getAttribute("data-video-effects-black-output-count") ?? 1
      );
      const combinedBackgroundOk = combinedBackgroundId
        ? stats?.effects?.background === combinedBackgroundId &&
          stats?.backgroundRender?.background === combinedBackgroundId &&
          stats?.backgroundRender?.active === true
        : true;
      const outputModeOk = combinedBackgroundId
        ? (stats?.outputMode === "track-generator" || stats?.outputMode === "canvas-capture")
        : stats?.outputMode === "meet-videopipe";
      const frameSourceOk = combinedBackgroundId
        ? (stats?.frameSource === "video" || stats?.frameSource === "track-processor")
        : stats?.frameSource === "meet-videopipe";
      const meetVideoPipeOk = combinedBackgroundId
        ? meetVideoPipe?.active === true &&
          meetVideoPipe?.mode === "gate" &&
          meetVideoPipe?.gate?.selectedFilter === ${JSON.stringify(primaryFaceFilterId)}
        : meetVideoPipe?.active === true &&
          meetVideoPipe?.mode === "direct" &&
          meetVideoPipe?.outputTrack?.readyState === "live";
      const ok =
        panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
        Number(panel?.getAttribute("data-video-effects-active-count") || 0) >= 1 &&
        blackOutputFrameCount === 0 &&
        selectedFilter === ${JSON.stringify(primaryFaceFilterId)} &&
        combinedBackgroundOk &&
        frameSourceOk &&
        outputModeOk &&
        stats?.latestOutputFrameVisible === true &&
        meetVideoPipeOk &&
        debug?.connectionState === "joined" &&
        debug?.isCameraOff === false &&
        producer &&
        producer.closed === false &&
        producerTrack?.readyState === "live" &&
        producerTrack?.enabled !== false &&
        publish?.producerTrackLive === true &&
        publish?.shouldPublishProcessed === true &&
        publish?.usingProcessedTrack === true;
      return ok
        ? {
            selectedFilter,
            activeCount: panel?.getAttribute("data-video-effects-active-count"),
            blackOutputFrameCount,
            outputMode: stats?.outputMode,
            frameSource: stats?.frameSource,
            background: stats?.effects?.background ?? null,
            backgroundRender: stats?.backgroundRender ?? null,
            latestOutputFrameVisible: stats?.latestOutputFrameVisible,
            meetVideoPipe,
            publish,
	          }
	        : false;
	    })()`,
      45000,
    );
  } catch (error) {
    const state = await collectState(cdp, "state_after_meet_videopipe_timeout");
    emit("meet_videopipe_timeout_probe", {
      label: primaryFaceFilterLabel,
      expectedFilterId: primaryFaceFilterId,
      error: error instanceof Error ? error.message : String(error),
      panelAttrs: state.panelAttrs ?? null,
      panelStats: state.panelStats ?? null,
      meetVideoDebug: state.meetVideoDebug ?? null,
      relevantLogs: collectRelevantLogs(),
    });
    throw error;
  }
  emit("meet_videopipe_output_probe", {
    ok: true,
    label: primaryFaceFilterLabel,
    expectedFilterId: primaryFaceFilterId,
    outputProbe,
  });

  const state = await collectState(cdp, "state_after_meet_videopipe_filter");
  await waitForMeetVideoPublish(
    cdp,
    `Meet VideoPipe ${primaryFaceFilterLabel} producer uses processed output`,
    "processed",
  );

  if (secondaryFaceFilterLabel && !secondaryFaceFilterId) {
    throw new Error(
      `Unknown secondary CONCLAVE_FACE_FILTERS label for Meet VideoPipe probe: ${secondaryFaceFilterLabel}`,
    );
  }

  if (secondaryFaceFilterId) {
    const switchLogStartIndex = cdp.logs.length;
    await clickButton(cdp, secondaryFaceFilterLabel, 10000);
    const switchProbe = await waitFor(
      cdp,
      `Meet VideoPipe ${secondaryFaceFilterLabel} switch output`,
      `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const meetVideoPipe = stats?.meetVideoPipe;
      const debug =
        typeof window.__conclaveGetMeetVideoDebug === "function"
          ? window.__conclaveGetMeetVideoDebug()
          : window.__conclaveMeetVideoDebug ?? null;
      const producer = debug?.videoProducer;
      const producerTrack = producer?.track;
      const publish = debug?.publish;
      const selectedFilter =
        stats?.effects?.filter ?? debug?.videoEffects?.filter ?? null;
      const blackOutputFrameCount = Number(
        panel?.getAttribute("data-video-effects-black-output-count") ?? 1
      );
      const ok =
        panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
        Number(panel?.getAttribute("data-video-effects-active-count") || 0) >= 1 &&
        blackOutputFrameCount === 0 &&
        selectedFilter === ${JSON.stringify(secondaryFaceFilterId)} &&
        stats?.frameSource === "meet-videopipe" &&
        stats?.outputMode === "meet-videopipe" &&
        stats?.latestOutputFrameVisible === true &&
        meetVideoPipe?.active === true &&
        meetVideoPipe?.mode === "direct" &&
        Number(meetVideoPipe?.effectIdNumber || 0) > 0 &&
        meetVideoPipe?.outputTrack?.readyState === "live" &&
        debug?.connectionState === "joined" &&
        debug?.isCameraOff === false &&
        producer &&
        producer.closed === false &&
        producerTrack?.readyState === "live" &&
        producerTrack?.enabled !== false &&
        publish?.producerTrackLive === true &&
        publish?.shouldPublishProcessed === true &&
        publish?.usingProcessedTrack === true;
      return ok
        ? {
            selectedFilter,
            activeCount: panel?.getAttribute("data-video-effects-active-count"),
            blackOutputFrameCount,
            outputMode: stats?.outputMode,
            frameSource: stats?.frameSource,
            latestOutputFrameVisible: stats?.latestOutputFrameVisible,
            meetVideoPipe,
            publish,
          }
        : false;
      })()`,
      30000,
    );
    const switchState = await collectState(
      cdp,
      "state_after_meet_videopipe_filter_switch",
    );
    await waitForMeetVideoPublish(
      cdp,
      `Meet VideoPipe ${secondaryFaceFilterLabel} producer uses processed output`,
      "processed",
    );
    const switchLogs = cdp.logs.slice(switchLogStartIndex);
    const processorReused = switchLogs.some((log) =>
      /meet_videopipe_processor_reused/i.test(log.text),
    );
    const switchBadLogs = switchLogs.filter((log) =>
      badLogPatterns.some((pattern) => pattern.test(log.text)),
    );
    const switchQuality = {
      ok:
        processorReused &&
        switchBadLogs.length === 0 &&
        switchState.panelStats?.effects?.filter === secondaryFaceFilterId &&
        switchState.panelStats?.outputMode === "meet-videopipe" &&
        switchState.panelStats?.frameSource === "meet-videopipe" &&
        switchState.panelStats?.meetVideoPipe?.active === true &&
        switchState.meetVideoDebug?.publish?.usingProcessedTrack === true &&
        switchState.meetVideoDebug?.publish?.shouldPublishProcessed === true &&
        switchState.meetVideoDebug?.publish?.producerTrackLive === true,
      from: primaryFaceFilterLabel,
      to: secondaryFaceFilterLabel,
      expectedFilterId: secondaryFaceFilterId,
      processorReused,
      switchProbe,
      status:
        switchState.panelAttrs?.["data-video-effects-status"] ?? null,
      outputMode: switchState.panelStats?.outputMode ?? null,
      frameSource: switchState.panelStats?.frameSource ?? null,
      effects: switchState.panelStats?.effects ?? null,
      meetVideoPipe: switchState.panelStats?.meetVideoPipe ?? null,
      publish: switchState.meetVideoDebug?.publish ?? null,
      badLogs: switchBadLogs,
      relevantLogs: switchLogs
        .filter((log) =>
          /meet_videopipe|VideoPipe|video.?pipe|black_output|release_processed|skip_replace|track ended|VideoFrame was garbage collected/i.test(
            log.text,
          ),
        )
        .slice(-40),
    };
    emit("meet_videopipe_switch_probe", switchQuality);
    if (!switchQuality.ok) {
      throw new Error(
        `Meet VideoPipe switch regression failed: ${JSON.stringify(switchQuality)}`,
      );
    }
  }

  const badLogs = cdp.logs
    .slice(probeLogStartIndex)
    .filter((log) => badLogPatterns.some((pattern) => pattern.test(log.text)));
  const relevantLogs = collectRelevantLogs().slice(-40);

  const panelStats = state.panelStats ?? {};
  const combinedOutputModeOk = meetVideoPipeCombinedBackgroundId
    ? panelStats.outputMode === "track-generator" ||
      panelStats.outputMode === "canvas-capture"
    : panelStats.outputMode === "meet-videopipe";
  const combinedFrameSourceOk = meetVideoPipeCombinedBackgroundId
    ? panelStats.frameSource === "video" ||
      panelStats.frameSource === "track-processor"
    : panelStats.frameSource === "meet-videopipe";
  const combinedBackgroundOk = meetVideoPipeCombinedBackgroundId
    ? panelStats.effects?.background === meetVideoPipeCombinedBackgroundId &&
      panelStats.backgroundRender?.background ===
        meetVideoPipeCombinedBackgroundId &&
      panelStats.backgroundRender?.active === true
    : true;
  const combinedMeetVideoPipeOk = meetVideoPipeCombinedBackgroundId
    ? panelStats.meetVideoPipe?.active === true &&
      panelStats.meetVideoPipe?.mode === "gate" &&
      panelStats.meetVideoPipe?.gate?.selectedFilter === primaryFaceFilterId
    : panelStats.meetVideoPipe?.active === true &&
      panelStats.meetVideoPipe?.outputTrack?.readyState === "live";
  const selectedFilterMatches = meetVideoPipeCombinedBackgroundId
    ? state.meetVideoDebug?.videoEffects?.filter === primaryFaceFilterId
    : panelStats.effects?.filter === primaryFaceFilterId;
  const cameraToggleLivePrewarmOk = meetVideoPipeCombinedBackgroundId
    ? cameraToggleLivePrewarmRequested === true
    : cameraToggleLivePrewarmRequested === true &&
      cameraToggleLivePrewarmDone === true;
  const quality = {
    ok:
      state.panelAttrs?.["data-video-effects-status"] === "running" &&
      state.panelAttrs?.["data-video-effects-output-published"] === "true" &&
      state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true" &&
      Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ) === 0 &&
      selectedFilterMatches &&
      combinedBackgroundOk &&
      combinedOutputModeOk &&
      combinedFrameSourceOk &&
      combinedMeetVideoPipeOk &&
      state.meetVideoDebug?.publish?.usingProcessedTrack === true &&
      state.meetVideoDebug?.publish?.shouldPublishProcessed === true &&
      (meetVideoPipeCombinedBackgroundId
        ? state.meetVideoDebug?.publish?.processedSourceMatchesChainedInput ===
          true
        : true) &&
      state.meetVideoDebug?.publish?.producerTrackLive === true &&
      cameraToggleLivePrewarmOk &&
      badLogs.length === 0,
    label: primaryFaceFilterLabel,
    expectedFilterId: primaryFaceFilterId,
    status: state.panelAttrs?.["data-video-effects-status"] ?? null,
    activeCount: state.panelAttrs?.["data-video-effects-active-count"] ?? null,
    outputPublished:
      state.panelAttrs?.["data-video-effects-output-published"] ?? null,
    previewMatchesOutput:
      state.panelAttrs?.["data-video-effects-preview-matches-output"] ?? null,
    blackOutputFrameCount: Number(
      state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
    ),
    combinedBackgroundLabel: meetVideoPipeCombinedBackgroundLabel,
    combinedBackgroundId: meetVideoPipeCombinedBackgroundId,
    combinedOrder: meetVideoPipeCombinedBackgroundId
      ? meetVideoPipeCombinedOrder
      : null,
    combinedBackgroundOk,
    combinedOutputModeOk,
    combinedFrameSourceOk,
    selectedFilterMatches,
    outputMode: panelStats.outputMode ?? null,
    frameSource: panelStats.frameSource ?? null,
    effects: panelStats.effects ?? null,
    backgroundRender: panelStats.backgroundRender ?? null,
    meetVideoPipe: panelStats.meetVideoPipe ?? null,
    publish: state.meetVideoDebug?.publish ?? null,
    cameraToggleLivePrewarmOk,
    cameraToggleLivePrewarmRequested,
    cameraToggleLivePrewarmDone,
    badLogs,
    relevantLogs,
  };
  emit("meet_videopipe_quality_probe", quality);
  if (!quality.ok) {
    throw new Error(
      `Meet VideoPipe headless regression failed: ${JSON.stringify(quality)}`,
    );
  }

  emit("result", {
    ok: true,
    probe: "meet-videopipe",
    label: primaryFaceFilterLabel,
    expectedFilterId: primaryFaceFilterId,
  });
};

const forceCloseLocalVideoProducerForDebug = async (cdp, label) => {
  const closeResult = await evalValue(
    cdp,
    `(() => {
      const closeProducer = window.__conclaveCloseLocalVideoProducerForDebug;
      if (typeof closeProducer !== "function") {
        return { ok: false, error: "debug close function missing" };
      }
      return closeProducer(${JSON.stringify(label)});
    })()`,
    10000,
  );
  emit("local_video_producer_close_probe_start", {
    label,
    closeResult,
  });
  if (!closeResult?.ok || !closeResult?.producerId) {
    throw new Error(
      `Failed to force-close local video producer: ${JSON.stringify(
        closeResult,
      )}`,
    );
  }

  const closedProducerId = closeResult.producerId;
  await waitFor(
    cdp,
    `${label} recovered processed producer`,
    `(() => {
      const debug =
        typeof window.__conclaveGetMeetVideoDebug === "function"
          ? window.__conclaveGetMeetVideoDebug()
          : window.__conclaveMeetVideoDebug ?? null;
      const producer = debug?.videoProducer;
      const producerTrack = producer?.track;
      return debug?.connectionState === "joined" &&
        debug?.isCameraOff === false &&
        producer &&
        producer.id !== ${JSON.stringify(closedProducerId)} &&
        producer.closed === false &&
        producerTrack?.readyState === "live" &&
        debug?.publish?.shouldPublishProcessed === true &&
        debug?.publish?.usingProcessedTrack === true &&
        debug?.publish?.producerTrackLive === true;
    })()`,
    30000,
  );
  const recoveredState = await collectState(
    cdp,
    `state_${label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_recovered`,
  );
  emit("local_video_producer_close_recovery_probe", {
    label,
    closedProducerId,
    recoveredProducerId: recoveredState.meetVideoDebug?.videoProducer?.id ?? null,
    usingProcessedTrack:
      recoveredState.meetVideoDebug?.publish?.usingProcessedTrack === true,
    cameraOff: recoveredState.meetVideoDebug?.isCameraOff ?? null,
    status: recoveredState.meetVideoDebug?.videoEffectsStatus ?? null,
  });
  return recoveredState;
};

const uploadCustomBackground = async (cdp) => {
  const ok = await evalValue(
    cdp,
    `(async () => {
      const input = document.querySelector('[data-testid="custom-background-input"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (!ctx || typeof DataTransfer !== "function" || typeof File !== "function") {
        return false;
      }
      const sky = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      sky.addColorStop(0, "#0f766e");
      sky.addColorStop(0.56, "#22d3ee");
      sky.addColorStop(1, "#f8fafc");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(15,23,42,0.72)";
      ctx.fillRect(0, canvas.height * 0.62, canvas.width, canvas.height * 0.38);
      ctx.fillStyle = "#facc15";
      ctx.beginPath();
      ctx.arc(canvas.width * 0.78, canvas.height * 0.2, 42, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png", 0.92)
      );
      if (!blob) return false;
      const file = new File([blob], "conclave-custom-background.png", {
        type: "image/png",
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
    5000,
  );
  if (!ok) {
    emit("custom_background_upload_failed", {
      probe: await collectProbe(cdp),
    });
    throw new Error("Could not upload custom background fixture");
  }
  emit("custom_background_upload_done");
};

const runPrejoinHandoffProbe = async (cdp, prejoinUrl) => {
  await cdp.send("Page.navigate", { url: prejoinUrl });
  emit("prejoin_navigate", { url: prejoinUrl });

  await waitFor(
    cdp,
    "prejoin lobby",
    `(() => {
      const bodyText = document.body?.innerText || "";
      const hasNewMeeting = Array.from(document.querySelectorAll("button")).some(
        (button) => (button.textContent || "").replace(/\\s+/g, " ").trim() === "New meeting"
      );
      return hasNewMeeting || bodyText.includes("Camera is off");
    })()`,
    30000,
  );

  await evalValue(
    cdp,
    `(() => {
      const input = Array.from(document.querySelectorAll("input")).find((candidate) =>
        candidate.getAttribute("placeholder") === "Enter your name"
      ) ?? Array.from(document.querySelectorAll("input[type='text']")).find(
        (candidate) => !candidate.readOnly && !candidate.disabled
      );
      if (input instanceof HTMLInputElement && !input.value.trim()) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "Headless Prejoin");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    })()`,
  );

  await waitFor(
    cdp,
    "prejoin new meeting ready",
    `(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => (candidate.textContent || "").replace(/\\s+/g, " ").trim() === "New meeting"
      );
      return Boolean(button && !button.disabled);
    })()`,
    10000,
  );

  await waitFor(
    cdp,
    "prejoin direct effects button ready",
    `(() => {
      const button = document.querySelector('[data-testid="prejoin-backgrounds-effects"]');
      return button instanceof HTMLButtonElement &&
        !button.disabled &&
        button.getAttribute("aria-label") === "Backgrounds and effects";
    })()`,
    10000,
  );
  await collectState(cdp, "state_prejoin_direct_effects_button");

  const quickBlurLogStartIndex = cdp.logs.length;
  await clickButton(cdp, "Turn on background blur");
  await waitFor(
    cdp,
    "prejoin quick blur selection pending",
    `(() => {
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      const liveVideoTracks = Array.from(document.querySelectorAll("video")).flatMap((video) => {
        const stream = video.srcObject;
        return stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
      }).filter((track) => track.readyState === "live");
      return meetDebug?.videoEffects?.background === "blur-strong" &&
        meetDebug?.activeVideoEffectsCount === 1 &&
        meetDebug?.isCameraOff === true &&
        meetDebug?.localStream === null &&
        liveVideoTracks.length === 0;
    })()`,
    10000,
  );
  const quickBlurPrewarmRequested = cdp.logs
    .slice(quickBlurLogStartIndex)
    .some(
      (log) =>
        /prewarm_requested/.test(log.text) &&
        /prejoin-quick-blur:select/.test(log.text) &&
        /"segmentation":true/.test(log.text),
    );
  emit("prejoin_quick_blur_select_prewarm_probe", {
    ok: quickBlurPrewarmRequested,
  });
  if (!quickBlurPrewarmRequested) {
    throw new Error("Prejoin quick blur click did not request segmentation prewarm");
  }
  await collectState(cdp, "state_prejoin_quick_blur_selected_camera_off");

  await clickTestId(cdp, "prejoin-backgrounds-effects");
  await waitFor(
    cdp,
    "prejoin camera-off effects panel",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const text = (panel?.textContent || "").replace(/\\s+/g, " ").trim();
      return Boolean(panel) &&
        panel.getAttribute("data-video-effects-status") === "off" &&
        panel.getAttribute("data-video-effects-filters-visible") === "true" &&
        text.includes("Filters") &&
        (text.includes("Camera is off") || text.includes("Camera unavailable"));
    })()`,
    10000,
  );
  await collectState(cdp, "state_prejoin_more_effects_camera_off");
  await clickButton(cdp, "Blur your background");
  await waitFor(
    cdp,
    "prejoin camera-off background selection pending",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      const effects = meetDebug?.videoEffects ?? stats?.effects;
      const liveVideoTracks = Array.from(document.querySelectorAll("video")).flatMap((video) => {
        const stream = video.srcObject;
        return stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
      }).filter((track) => track.readyState === "live");
      return panel?.getAttribute("data-video-effects-status") === "off" &&
        panel?.getAttribute("data-video-effects-active-count") === "1" &&
        panel?.getAttribute("data-video-effects-output-published") === "false" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "false" &&
        panel?.getAttribute("data-video-effects-filters-visible") === "true" &&
        panel?.getAttribute("data-video-effects-permission-locked") === "false" &&
        Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
        stats?.effects?.background === "blur-strong" &&
        stats?.effects?.active === true &&
        stats?.frameSource === "none" &&
        stats?.outputTrackPublished === false &&
        stats?.needsSegmentation === false &&
        stats?.needsFace === false &&
        liveVideoTracks.length === 0 &&
        meetDebug?.isCameraOff === true &&
        meetDebug?.localStream === null;
    })()`,
    10000,
  );
  const prejoinPendingState = await collectState(
    cdp,
    "state_prejoin_more_background_selected_camera_off",
  );
  const prejoinCameraLivePrewarmLogStartIndex = cdp.logs.length;
  await clickButton(cdp, "Turn on camera");
  await waitFor(
    cdp,
    "prejoin explicit camera-on background output",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const render = stats?.backgroundRender;
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      return panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-active-count") === "1" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
        panel?.getAttribute("data-video-effects-filters-visible") === "true" &&
        panel?.getAttribute("data-video-effects-permission-locked") === "false" &&
        Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
        render?.background === "blur-strong" &&
        render?.active === true &&
        Number(render?.changedPixels || 0) > 0 &&
        stats?.needsSegmentation === true &&
        stats?.needsFace === false &&
        ((stats?.framePipeline?.segmentationProcessor?.mode === "worker" && Number(stats?.framePipeline?.segmentationProcessor?.workerResults || 0) > 0) || Number(stats?.closedSegmentationMasks || 0) > 0) &&
        ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
        stats?.outputMode === "track-generator";
    })()`,
    30000,
  );
  const prejoinCameraLivePrewarmRequested = cdp.logs
    .slice(prejoinCameraLivePrewarmLogStartIndex)
    .some(
      (log) =>
        /prewarm_(?:requested|coalesce_inflight)/.test(log.text) &&
        /prejoin-camera-toggle-live/.test(log.text) &&
        /"segmentation":true/.test(log.text) &&
        /"face":true/.test(log.text),
    );
  emit("prejoin_camera_live_prewarm_probe", {
    ok: prejoinCameraLivePrewarmRequested,
  });
  if (!prejoinCameraLivePrewarmRequested) {
    throw new Error("Prejoin camera toggle did not request live-camera effects prewarm");
  }
  const prejoinState = await collectState(
    cdp,
    "state_prejoin_more_background_selected_live",
  );
  await clickButton(cdp, "Close backgrounds and effects");

  await clickButton(cdp, "New meeting");
  await waitFor(
    cdp,
    "prejoin handoff joined meeting",
    `(() => {
      const grid = document.querySelector("[data-meet-view-layout]");
      const liveVideo = Array.from(document.querySelectorAll("video")).some((video) => {
        const stream = video.srcObject;
        const tracks = stream && typeof stream.getTracks === "function"
          ? stream.getTracks()
          : [];
        return video.readyState >= 2 &&
          !video.ended &&
          tracks.some((track) => track.kind === "video" && track.readyState === "live");
      });
      return Boolean(grid) && liveVideo;
    })()`,
    30000,
  );

  await openMeetingEffectsPanel(cdp, "prejoin handoff in-meeting effects panel");
  await waitFor(
    cdp,
    "prejoin handoff in-meeting blur output",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const render = stats?.backgroundRender;
      return panel?.getAttribute("data-video-effects-status") === "running" &&
        panel?.getAttribute("data-video-effects-output-published") === "true" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
        Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
        render?.background === "blur-strong" &&
        render?.active === true &&
        Number(render?.changedPixels || 0) > 0 &&
        ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
        stats?.outputMode === "track-generator";
    })()`,
    30000,
  );
  const joinedState = await collectState(cdp, "state_prejoin_handoff_joined");
  await waitForMeetVideoPublish(
    cdp,
    "prejoin handoff producer uses processed blur",
    "processed",
  );
  emit("prejoin_handoff_probe", {
    prejoinPendingStatus:
      prejoinPendingState.panelAttrs?.["data-video-effects-status"],
    prejoinPendingActiveCount:
      prejoinPendingState.panelAttrs?.["data-video-effects-active-count"],
    prejoinStatus: prejoinState.panelAttrs?.["data-video-effects-status"],
    joinedStatus: joinedState.panelAttrs?.["data-video-effects-status"],
    joinedOutputPublished: joinedState.panelStats?.outputTrackPublished === true,
    joinedBlackOutputFrameCount: Number(
      joinedState.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
    ),
    joinedPreviewMatchesOutput:
      joinedState.panelAttrs?.["data-video-effects-preview-matches-output"] ===
      "true",
    joinedBackgroundRender: joinedState.panelStats?.backgroundRender ?? null,
  });

  await evalValue(
    cdp,
    `(() => {
      localStorage.removeItem("conclave:video-effects");
      localStorage.removeItem("conclave:meet-view");
      return true;
    })()`,
  );
};

const runPrejoinCameraOffJoinProbe = async (cdp, prejoinUrl) => {
  const url = `${prejoinUrl}&probe=camera-off-join`;
  await cdp.send("Page.navigate", { url });
  emit("prejoin_camera_off_join_navigate", { url });

  await waitFor(
    cdp,
    "prejoin camera-off join lobby",
    `(() => {
      const bodyText = document.body?.innerText || "";
      const hasNewMeeting = Array.from(document.querySelectorAll("button")).some(
        (button) => (button.textContent || "").replace(/\\s+/g, " ").trim() === "New meeting"
      );
      return hasNewMeeting || bodyText.includes("Camera is off");
    })()`,
    30000,
  );

  await evalValue(
    cdp,
    `(() => {
      const input = Array.from(document.querySelectorAll("input")).find((candidate) =>
        candidate.getAttribute("placeholder") === "Enter your name"
      ) ?? Array.from(document.querySelectorAll("input[type='text']")).find(
        (candidate) => !candidate.readOnly && !candidate.disabled
      );
      if (input instanceof HTMLInputElement) {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "Headless Camera Off");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    })()`,
  );

  await waitFor(
    cdp,
    "prejoin camera-off new meeting ready",
    `(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => (candidate.textContent || "").replace(/\\s+/g, " ").trim() === "New meeting"
      );
      return Boolean(button && !button.disabled);
    })()`,
    10000,
  );

  await clickTestId(cdp, "prejoin-backgrounds-effects");
  await waitFor(
    cdp,
    "prejoin camera-off effect panel before join",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      return panel?.getAttribute("data-video-effects-status") === "off" &&
        panel?.getAttribute("data-video-effects-filters-visible") === "true";
    })()`,
    10000,
  );
  await clickButton(cdp, "Blur your background");
  await waitFor(
    cdp,
    "prejoin camera-off selected effect queued before join",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      const raw = panel?.getAttribute("data-video-effects-stats");
      let stats = null;
      try { stats = raw ? JSON.parse(raw) : null; } catch {}
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      const liveVideoTracks = Array.from(document.querySelectorAll("video")).flatMap((video) => {
        const stream = video.srcObject;
        return stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
      }).filter((track) => track.readyState === "live");
      return panel?.getAttribute("data-video-effects-status") === "off" &&
        panel?.getAttribute("data-video-effects-active-count") === "1" &&
        panel?.getAttribute("data-video-effects-output-published") === "false" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "false" &&
        stats?.effects?.background === "blur-strong" &&
        stats?.frameSource === "none" &&
        stats?.outputTrackPublished === false &&
        liveVideoTracks.length === 0 &&
        meetDebug?.isCameraOff === true &&
        meetDebug?.localStream === null;
    })()`,
    10000,
  );
  const queuedPrejoinState = await collectState(
    cdp,
    "state_prejoin_camera_off_effect_queued",
  );

  await clickButton(cdp, "Close backgrounds and effects");
  await clickButton(cdp, "New meeting");
  await waitFor(
    cdp,
    "prejoin camera-off joined without camera",
    `(() => {
      const grid = document.querySelector("[data-meet-view-layout]");
      const cameraButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Turn on camera" ||
          (button.textContent || "").includes("Turn on camera")
      );
      const liveVideoTracks = Array.from(document.querySelectorAll("video")).flatMap((video) => {
        const stream = video.srcObject;
        return stream && typeof stream.getVideoTracks === "function"
          ? stream.getVideoTracks()
          : [];
      }).filter((track) => track.readyState === "live");
      const localTile = document.querySelector(".acm-video-tile");
      const localTileVideo = localTile?.querySelector("video[data-meet-tile-video='true']");
      const localTileVideoRect = localTileVideo?.getBoundingClientRect?.();
      const localTileVideoStyle = localTileVideo ? getComputedStyle(localTileVideo) : null;
      const localTileVideoVisible = Boolean(
        localTileVideoRect &&
        localTileVideoRect.width > 2 &&
        localTileVideoRect.height > 2 &&
        localTileVideoStyle?.display !== "none" &&
        localTileVideoStyle?.visibility !== "hidden" &&
        localTileVideoStyle?.opacity !== "0"
      );
      const localCameraPlaceholder = localTile?.querySelector(
        "[data-meet-local-camera-placeholder='true']",
      );
      const placeholderRect = localCameraPlaceholder?.getBoundingClientRect?.();
      const placeholderStyle = localCameraPlaceholder
        ? getComputedStyle(localCameraPlaceholder)
        : null;
      const localCameraPlaceholderVisible = Boolean(
        placeholderRect &&
        placeholderRect.width > 2 &&
        placeholderRect.height > 2 &&
        placeholderStyle?.display !== "none" &&
        placeholderStyle?.visibility !== "hidden" &&
        placeholderStyle?.opacity !== "0"
      );
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      return Boolean(grid) &&
        Boolean(cameraButton && !cameraButton.disabled) &&
        liveVideoTracks.length === 0 &&
        localTileVideoVisible === false &&
        localCameraPlaceholderVisible === true &&
        meetDebug?.connectionState === "joined" &&
        meetDebug?.isCameraOff === true &&
        meetDebug?.activeVideoEffectsCount === 1 &&
        meetDebug?.videoEffects?.background === "blur-strong" &&
        meetDebug?.videoProducer === null;
    })()`,
    30000,
  );
  const joinedCameraOffState = await collectState(
    cdp,
    "state_prejoin_camera_off_joined",
  );

  await openMeetingEffectsPanel(cdp, "prejoin camera-off joined effects panel");
  await waitFor(
    cdp,
    "prejoin camera-off joined effect panel queued",
    `(() => {
      const panel = document.querySelector('[data-testid="video-effects-panel"]');
      return panel?.getAttribute("data-video-effects-status") === "off" &&
        panel?.getAttribute("data-video-effects-active-count") === "1" &&
        panel?.getAttribute("data-video-effects-output-published") === "false" &&
        panel?.getAttribute("data-video-effects-preview-matches-output") === "false";
    })()`,
    10000,
  );
  await clickButton(cdp, "Close backgrounds and effects");
  await clickButton(cdp, "Turn on camera");
  await waitFor(
    cdp,
    "prejoin camera-off explicit camera-on applies queued effect",
    `(() => {
      const meetDebug = window.__conclaveGetMeetVideoDebug?.();
      const stats = meetDebug?.videoEffectsDebugStats;
      const render = stats?.backgroundRender;
      return meetDebug?.connectionState === "joined" &&
        meetDebug?.isCameraOff === false &&
        meetDebug?.activeVideoEffectsCount === 1 &&
        meetDebug?.videoEffectsStatus === "running" &&
        meetDebug?.videoEffects?.background === "blur-strong" &&
        meetDebug?.processedTrackReady === true &&
        meetDebug?.publish?.usingProcessedTrack === true &&
        stats?.outputTrackPublished === true &&
        stats?.outputMode === "track-generator" &&
        render?.background === "blur-strong" &&
        render?.active === true &&
        Number(render?.changedPixels || 0) > 0;
    })()`,
    30000,
  );
  const joinedCameraOnState = await collectState(
    cdp,
    "state_prejoin_camera_off_joined_camera_on",
  );
  await waitForMeetVideoPublish(
    cdp,
    "prejoin camera-off join explicit camera-on producer uses processed blur",
    "processed",
  );
  emit("prejoin_camera_off_join_probe", {
    queuedPrejoinStatus:
      queuedPrejoinState.panelAttrs?.["data-video-effects-status"],
    queuedPrejoinActiveCount:
      queuedPrejoinState.panelAttrs?.["data-video-effects-active-count"],
    joinedCameraOff: joinedCameraOffState.meetVideoDebug?.isCameraOff === true,
    joinedActiveCount: joinedCameraOffState.meetVideoDebug?.activeVideoEffectsCount,
    joinedVideoProducer: joinedCameraOffState.meetVideoDebug?.videoProducer ?? null,
    cameraOnStatus: joinedCameraOnState.meetVideoDebug?.videoEffectsStatus,
    cameraOnUsesProcessed:
      joinedCameraOnState.meetVideoDebug?.publish?.usingProcessedTrack === true,
    cameraOnOutputPublished:
      joinedCameraOnState.meetVideoDebug?.videoEffectsDebugStats
        ?.outputTrackPublished === true,
    cameraOnBackgroundRender:
      joinedCameraOnState.meetVideoDebug?.videoEffectsDebugStats
        ?.backgroundRender ?? null,
  });

  await evalValue(
    cdp,
    `(() => {
      localStorage.removeItem("conclave:video-effects");
      localStorage.removeItem("conclave:meet-view");
      return true;
    })()`,
  );
};

const runPrejoinPermissionDeniedEffectsProbe = async (cdp, prejoinUrl) => {
  const url = `${prejoinUrl}&probe=permission-blocked-effects`;
  await cdp.send("Page.navigate", { url });
  emit("prejoin_permission_blocked_navigate", { url });

  await waitFor(
    cdp,
    "prejoin permission-blocked lobby",
    `(() => {
      const bodyText = document.body?.innerText || "";
      const hasNewMeeting = Array.from(document.querySelectorAll("button")).some(
        (button) => (button.textContent || "").replace(/\\s+/g, " ").trim() === "New meeting"
      );
      return hasNewMeeting || bodyText.includes("Camera is off");
    })()`,
    30000,
  );

  await waitFor(
    cdp,
    "prejoin permission-blocked effects controls disabled",
    `(() => {
      const quickBlurButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Turn on background blur"
      );
      const effectsButton = document.querySelector('[data-testid="prejoin-backgrounds-effects"]');
      const effectsButtonLabel = (effectsButton?.getAttribute("aria-label") || "")
        .replace(/\\s+/g, " ")
        .trim();
      return Boolean(quickBlurButton && quickBlurButton.disabled) &&
        Boolean(effectsButton instanceof HTMLButtonElement && effectsButton.disabled) &&
        effectsButtonLabel === "Backgrounds and effects: Permission needed" &&
        !document.querySelector('[data-testid="video-effects-panel"]');
    })()`,
    10000,
  );
  await clickButton(cdp, "More options");
  await waitFor(
    cdp,
    "prejoin permission-blocked effects menu entry disabled",
    `(() => {
      const quickBlurButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.getAttribute("aria-label") === "Turn on background blur"
      );
      const effectsButton = document.querySelector('[data-testid="prejoin-more-backgrounds-effects"]');
      const effectsButtonLabel = (effectsButton?.getAttribute("aria-label") || "")
        .replace(/\\s+/g, " ")
        .trim();
      const effectsButtonText = (effectsButton?.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      return Boolean(quickBlurButton && quickBlurButton.disabled) &&
        Boolean(effectsButton instanceof HTMLButtonElement && effectsButton.disabled) &&
        effectsButtonLabel === "Backgrounds and effects: Permission needed" &&
        effectsButtonText.includes("Backgrounds and effects") &&
        effectsButtonText.includes("Permission needed") &&
        !document.querySelector('[data-testid="video-effects-panel"]');
    })()`,
    10000,
  );
  const state = await collectState(
    cdp,
    "state_prejoin_permission_blocked_effects_disabled",
  );
  emit("prejoin_permission_blocked_effects_probe", {
    status: state.meetVideoDebug?.videoEffectsStatus ?? "off",
    activeCount: state.meetVideoDebug?.activeVideoEffectsCount ?? 0,
    permissionLocked: true,
    quickBlurDisabled: true,
    menuEntryEnabled: false,
    panelOpen: state.hasEffectsPanel,
    filtersVisible:
      state.panelAttrs?.["data-video-effects-filters-visible"] === "true",
    outputPublished:
      state.panelAttrs?.["data-video-effects-output-published"] === "true",
    effects: state.meetVideoDebug?.videoEffects ?? state.panelStats?.effects ?? null,
  });

  await evalValue(
    cdp,
    `(() => {
      localStorage.removeItem("conclave:video-effects");
      localStorage.removeItem("conclave:meet-view");
      return true;
    })()`,
  );
};

const badLogPatterns = [
  /VideoFrame was garbage collected/i,
  /skip_replace_track_no_next_track/i,
  /Failed to produce video/i,
  /InvalidStateError: track ended/i,
  /release_processed_track_to_raw/i,
  /release_dark_processed_track_to_raw/i,
  /source_track_not_live/i,
  /black_output_probe/i,
  /dark_output_probe/i,
  /no_visible_frame_source/i,
  /final argument passed to .* changed size between renders/i,
];

const run = async () => {
  cleanupLegacyFakeVideos();
  ensureFakeVideo();
  const userDataDir = mkdtempSync(join(tmpdir(), "conclave-headless-chrome-"));
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const prejoinUrl = `${normalizedBaseUrl}/?admin=1&name=Headless%20Prejoin`;
  const url = `${normalizedBaseUrl}/${roomId}?autojoin=1&hide=1&admin=1&name=Headless%20Effects`;
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
    `--window-size=${headlessWindowSize}`,
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${fakeVideoPath}`,
    "--enable-logging=stderr",
    "--v=0",
    "about:blank",
  ];
  emit("chrome_launch", {
    chromePath,
    chromePort,
    fakeVideoPath,
    fakeVideo: {
      width: fakeVideoWidth,
      height: fakeVideoHeight,
      fps: fakeVideoFps,
      durationSeconds: fakeVideoDurationSeconds,
    },
    url,
    forceDarkVideoProbe,
    viewport: {
      width: headlessViewportWidth,
      height: headlessViewportHeight,
      deviceScaleFactor: headlessDeviceScaleFactor,
      mobile: headlessEmulateMobile,
      touch: headlessTouchEnabled,
    },
    command: `${shellEscape(chromePath)} ${args.map(shellEscape).join(" ")}`,
  });

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  chrome.stdout.on("data", (chunk) => {
    emit("chrome_stdout", { text: String(chunk).trim() });
  });
  chrome.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text.includes("INFO:CONSOLE")) return;
    if (text) emit("chrome_stderr", { text });
  });

  let cdp = null;
  let rapidEffectSwitchLogIndex = 0;
  try {
    const targets = await waitForJson(
      `http://127.0.0.1:${chromePort}/json/list`,
      "Chrome target list",
      chromeTargetListTimeoutMs,
    );
    emit("target_list", {
      targets: targets.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        url: item.url,
      })),
    });
    const target =
      targets.find((item) => item.type === "page" && item.url.includes(roomId)) ??
      targets.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("No debuggable Chrome page target found");
    }

    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: headlessViewportWidth,
      height: headlessViewportHeight,
      deviceScaleFactor: headlessDeviceScaleFactor,
      mobile: headlessEmulateMobile,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", {
      enabled: headlessTouchEnabled,
    });
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(
      () => {},
    );
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        try {
          window.localStorage.setItem("conclave:debug-video-effects", "1");
          window.localStorage.removeItem("conclave:debug-video-effects-verbose");
        } catch {}
      })();`,
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        try {
          if (!window.location.search.includes("probe=permission-blocked-effects")) {
            return;
          }
          if (window.__conclavePermissionBlockedEffectsProbeInstalled) {
            return;
          }
          window.__conclavePermissionBlockedEffectsProbeInstalled = true;

          const createDeniedPermissionStatus = () => {
            const status = new EventTarget();
            Object.defineProperty(status, "state", {
              configurable: true,
              enumerable: true,
              value: "denied",
            });
            status.onchange = null;
            return status;
          };

          const originalQuery = navigator.permissions?.query?.bind(
            navigator.permissions,
          );
          if (originalQuery) {
            Object.defineProperty(navigator.permissions, "query", {
              configurable: true,
              value: (descriptor) => {
                if (descriptor?.name === "camera") {
                  return Promise.resolve(createDeniedPermissionStatus());
                }
                return originalQuery(descriptor);
              },
            });
          }

          const originalGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(
            navigator.mediaDevices,
          );
          if (originalGetUserMedia) {
            Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
              configurable: true,
              value: (constraints) => {
                if (constraints?.video) {
                  return Promise.reject(
                    new DOMException(
                      "Camera denied by headless permission probe",
                      "NotAllowedError",
                    ),
                  );
                }
                return originalGetUserMedia(constraints);
              },
            });
          }
        } catch {}
      })();`,
    });
    emit("video_effects_debug_probe_enabled");
    if (forceDarkVideoProbe) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          if (window.__conclaveDarkVideoProbeInstalled) return;
          window.__conclaveDarkVideoProbeInstalled = true;
          const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function patchedDrawImage(image, ...args) {
            if (
              image instanceof HTMLVideoElement &&
              this.canvas?.width === 16 &&
              this.canvas?.height === 9
            ) {
              this.clearRect(0, 0, this.canvas.width, this.canvas.height);
              return;
            }
            return originalDrawImage.call(this, image, ...args);
          };
        })();`,
      });
      emit("dark_video_probe_simulation_installed");
    }

    if (headlessProbe !== "effects" && headlessProbe !== "meet-videopipe") {
      await runPrejoinPermissionDeniedEffectsProbe(cdp, prejoinUrl);
      if (headlessProbe === "permission-blocked-effects") {
        const badLogs = cdp.logs.filter((log) =>
          badLogPatterns.some((pattern) => pattern.test(log.text)),
        );
        if (badLogs.length > 0) {
          throw new Error(
            `Permission-blocked effects probe logged regressions: ${JSON.stringify({
              badLogs,
            })}`,
          );
        }
        emit("result", { ok: true, probe: headlessProbe });
        return;
      }
      await runPrejoinCameraOffJoinProbe(cdp, prejoinUrl);
      await runPrejoinHandoffProbe(cdp, prejoinUrl);
    }

    await cdp.send("Page.navigate", { url });
    emit("page_navigate", { url });

    await waitFor(
      cdp,
      "meeting surface",
      `(() => {
        const hasGrid = Boolean(document.querySelector("[data-meet-view-layout]"));
        const hasMobileGrid = Boolean(
          document.querySelector("[data-mobile-room-tiling-source='client']")
        );
        const hasEffectsButton = Array.from(document.querySelectorAll("button")).some(
          (button) => {
            const label = (button.getAttribute("aria-label") || "")
              .replace(/\\s+/g, " ")
              .trim();
            const text = (button.textContent || "").replace(/\\s+/g, " ").trim();
            return label === "Backgrounds and effects" ||
              text === "Backgrounds and effects" ||
              label === "More options";
          }
        );
        return hasGrid || hasMobileGrid || hasEffectsButton;
      })()`,
    );
    let state = await collectState(cdp, "state_after_join");
    if (headlessMobileViewport) {
      await collectMobileRoomTilingProbe(cdp, "mobile_room_tiling_after_join");
      await collectLayoutState(cdp, "mobile_layout_after_join");
    }
    if (
      state.meetVideoDebug?.isCameraOff !== true ||
      state.meetVideoDebug?.videoProducer !== null
    ) {
      throw new Error(
        `Hidden autojoin must start with camera off: ${JSON.stringify({
          isCameraOff: state.meetVideoDebug?.isCameraOff,
          videoProducer: state.meetVideoDebug?.videoProducer,
          localStream: state.meetVideoDebug?.localStream,
        })}`,
      );
    }
    emit("autojoin_camera_off_probe", {
      isCameraOff: state.meetVideoDebug?.isCameraOff === true,
      videoProducer: state.meetVideoDebug?.videoProducer ?? null,
      localStream: state.meetVideoDebug?.localStream ?? null,
    });

    let cameraToggleLivePrewarmRequested = false;
    let cameraToggleLivePrewarmDone = false;
    const cameraToggleLivePrewarmLogStartIndex = cdp.logs.length;
    if (state.meetVideoDebug?.isCameraOff === true) {
      const turnedOn = await evalValue(
        cdp,
        `(() => {
          const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
            candidate.getAttribute("aria-label") === "Turn on camera" ||
            (candidate.textContent || "").includes("Turn on camera")
          );
          if (!button || button.disabled) return false;
          button.click();
          return true;
        })()`,
      );
      emit("camera_toggle_attempt", { turnedOn });
      await sleep(3000);
      state = await collectState(cdp, "state_after_camera_toggle");
    }
    if (headlessMobileViewport) {
      await collectMobileRoomTilingProbe(
        cdp,
        "mobile_room_tiling_after_camera_toggle",
      );
      await collectLayoutState(cdp, "mobile_layout_after_camera_toggle");
    }
    cameraToggleLivePrewarmRequested = cdp.logs
      .slice(cameraToggleLivePrewarmLogStartIndex)
      .some(
        (log) =>
          /prewarm_requested/.test(log.text) &&
          /"reason":"camera-toggle-live"/.test(log.text),
      );
    cameraToggleLivePrewarmDone = cdp.logs
      .slice(cameraToggleLivePrewarmLogStartIndex)
      .some(
        (log) =>
          /prewarm_done/.test(log.text) &&
          /"reason":"camera-toggle-live"/.test(log.text),
      );
    emit("camera_toggle_live_prewarm_probe", {
      ok: cameraToggleLivePrewarmRequested && cameraToggleLivePrewarmDone,
      requested: cameraToggleLivePrewarmRequested,
      done: cameraToggleLivePrewarmDone,
    });

    if (!headlessMobileViewport) {
      await ensureMeetingToolbarControls(cdp);
    } else {
      await collectMobileMoreMenuProbe(cdp, "mobile_more_menu_probe");
    }
    const effectsPanelOpenLogStartIndex = cdp.logs.length;
    await openMeetingEffectsPanel(cdp, "effects panel");
    await collectState(cdp, "state_panel_open");
    assertEffectsPanelOpenPrewarmScope(cdp.logs, "effects panel open", {
      fromIndex: effectsPanelOpenLogStartIndex,
    });

    if (headlessProbe === "meet-videopipe") {
      await runMeetVideoPipeProbe(cdp, {
        cameraToggleLivePrewarmRequested,
        cameraToggleLivePrewarmDone,
      });
      return;
    }

    await clickButton(cdp, "Blur your background");
    await sleep(75);
    await clickButton(cdp, "Filters");
    await sleep(75);
    await clickButton(cdp, "Sparkles");
    await sleep(75);
    await clickButton(cdp, "Backgrounds");
    await sleep(75);
    await clickButton(cdp, "Slightly blur your background");
    await sleep(75);
    await clickButton(cdp, "Blur your background");
    await waitFor(
      cdp,
      "camera-off rapid effect start output healthy",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const backgroundRender = stats?.backgroundRender;
        const faceRender = stats?.faceFilterRender;
        const adaptation = stats?.adaptation;
        const framePipeline = stats?.framePipeline;
        const modelProcessingConfigId =
          framePipeline?.modelProcessingConfigId ?? framePipeline?.processingConfigId;
        const framePoller = framePipeline?.framePoller;
        const outputWriter = framePipeline?.outputWriter;
        const segmentationProcessor = framePipeline?.segmentationProcessor;
        const faceProcessor = framePipeline?.faceProcessor;
        const temporalMask = stats?.temporalMask;
        const frameMetadataDebug =
          typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
            ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
            : window.__conclaveVideoEffectsFrameMetadataDebug ?? null;
        const frameMetadata = stats?.frameMetadata || frameMetadataDebug?.current;
        const allowedWatchdogFallbacks =
          outputWriter?.mode === "worker" ? 2 : 0;
        const hasRvfcMetadata =
          framePoller?.lastMetadata &&
          Number(framePoller.lastMetadata.presentedFrames ?? 0) > 0 &&
          Number(framePoller.lastMetadata.mediaTime ?? -1) >= 0;
        const headlessWatchdogFramePump =
          Number(framePoller?.watchdogFallbackCount || 0) > allowedWatchdogFallbacks &&
          Number(framePoller?.timerPollCount || 0) > 0 &&
          Number(framePipeline?.outputFramesWritten || 0) >= 6 &&
          framePipeline?.lastFrame?.outputDelivered === true &&
          framePipeline?.lastFrame?.outputVisible === true;
        const faceProcessorResultHealthy =
          !${JSON.stringify(expectFaceLandmarks)}
            ? faceProcessor?.latestWorkerResult === null ||
              (
                Number(faceProcessor?.latestWorkerResult?.sequence || 0) > 0 &&
                faceProcessor?.latestWorkerResult?.processingConfigId ===
                  modelProcessingConfigId &&
                Number(faceProcessor?.latestWorkerResult?.width || 0) > 0 &&
                Number(faceProcessor?.latestWorkerResult?.height || 0) > 0 &&
                faceProcessor?.latestWorkerResult?.inputSource === "video-frame"
              )
              : Number(faceProcessor?.latestWorkerResult?.sequence || 0) > 0 &&
              faceProcessor?.latestWorkerResult?.processingConfigId ===
                modelProcessingConfigId &&
              Number(faceProcessor?.latestWorkerResult?.width || 0) > 0 &&
              Number(faceProcessor?.latestWorkerResult?.height || 0) > 0 &&
              faceProcessor?.latestWorkerResult?.inputSource === "video-frame" &&
              Number(faceProcessor?.latestWorkerResult?.landmarkCount || 0) > 0;
        const adaptationHealthy =
          [1400, 1200, 1100, 1000].includes(Number(adaptation?.adaptationTier)) &&
          Array.isArray(adaptation?.availableTiers) &&
          adaptation.availableTiers.includes(Number(adaptation?.adaptationTier)) &&
          adaptation?.adaptiveEffect === true &&
          Number(adaptation?.modelIntervalScale || 0) >= 1 &&
          Number(adaptation?.processingDelayMs) >= 0 &&
          Number(adaptation?.fullProcessingDelayMs) >= 0 &&
          Number(adaptation?.frameIntervalMs) > 0 &&
          Number(adaptation?.targetSegmentationIntervalMs) >= 42 &&
          Number(adaptation?.targetFaceIntervalMs) >= 42;
        const framePipelineHealthy =
          framePipeline?.processor === "main-thread-worker-renderer" &&
          framePipeline?.targetFps === 30 &&
          Number(framePipeline?.processingConfigId || 0) >= 1 &&
          ["video-frame", "track-processor"].includes(
            framePipeline?.schedulerMode
          ) &&
          ["requestVideoFrameCallback", "track-processor"].includes(
            framePoller?.mode
          ) &&
          (
            Number(framePoller?.callbackCount || 0) > 0 ||
            framePoller?.mode === "track-processor"
          ) &&
          Number(framePoller?.scheduleFailureCount || 0) === 0 &&
          (
            Number(framePoller?.watchdogFallbackCount || 0) <=
              allowedWatchdogFallbacks ||
            headlessWatchdogFramePump
          ) &&
          typeof framePoller?.lastProcessedFrameKey === "string" &&
          framePoller.lastProcessedFrameKey.length > 0 &&
          (
            hasRvfcMetadata ||
            headlessWatchdogFramePump ||
            framePoller?.mode === "track-processor"
          ) &&
          framePipeline?.outputMode === "track-generator" &&
          framePipeline?.outputReady === true &&
          framePipeline?.outputTrackPublished === true &&
          Number(framePipeline?.frameSequence || 0) > 0 &&
          Number(framePipeline?.outputFrameSequence || 0) >= 6 &&
          Number(framePipeline?.outputFramesWritten || 0) >= 6 &&
          Number(framePipeline?.firstSourceFrameAgeMs ?? -1) >= 0 &&
          Number(framePipeline?.firstOutputFrameAgeMs ?? -1) >= 0 &&
          Number(framePipeline?.firstVisibleOutputFrameAgeMs ?? -1) >= 0 &&
          Number(framePipeline?.firstPublishedTrackAgeMs ?? -1) >= 0 &&
          framePipeline?.lastFrame?.source &&
          framePipeline.lastFrame.processingConfigId ===
            framePipeline.processingConfigId &&
          framePipeline.lastFrame.outputDelivered === true &&
          framePipeline.lastFrame.outputVisible === true &&
          Number(framePipeline.lastFrame.renderLatencyMs ?? -1) >= 0 &&
          outputWriter?.mode === "worker" &&
          outputWriter?.workerSupported === true &&
          outputWriter?.workerReady === true &&
          outputWriter?.workerHasVideoFrame === true &&
          outputWriter?.workerHasWritableStream === true &&
          outputWriter?.workerHasOffscreenCanvas === true &&
          ["direct-video-frame", "offscreen-canvas"].includes(
            outputWriter?.workerRenderer
          ) &&
          outputWriter?.workerFirstFrameSeen === true &&
          Number(outputWriter?.workerFramesSent || 0) >= 6 &&
          Number(outputWriter?.workerFramesWritten || 0) >= 6 &&
          Number(outputWriter?.workerFrameMetadataCount || 0) >= 6 &&
          Number(outputWriter?.workerWriteFailures || 0) === 0 &&
          Number(outputWriter?.workerPostFailures || 0) === 0 &&
          Number(outputWriter?.workerPendingFrameCount || 0) <= 1 &&
          Number(outputWriter?.latestWorkerWriteMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerBackpressureMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerAckSequence || 0) > 0 &&
          ["direct-video-frame", "offscreen-canvas"].includes(
            outputWriter?.latestWorkerFrameMetadata?.renderer
          ) &&
          Number(outputWriter?.latestWorkerFrameMetadata?.sequence || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.width || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.height || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.writeMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.backpressureMs ?? -1) >= 0 &&
          segmentationProcessor?.mode === "worker" &&
          segmentationProcessor?.workerSupported === true &&
          segmentationProcessor?.workerReady === true &&
          ["GPU", "CPU"].includes(segmentationProcessor?.workerDelegate) &&
          Number(segmentationProcessor?.workerFramesSent || 0) >= 1 &&
          Number(segmentationProcessor?.workerResults || 0) >= 1 &&
          Number(segmentationProcessor?.workerStaleResults ?? 0) >= 0 &&
          Number(segmentationProcessor?.workerFailures || 0) === 0 &&
          segmentationProcessor?.workerFirstResultSeen === true &&
          Number(segmentationProcessor?.latestWorkerSequence || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerAckSequence || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerProcessingMs ?? -1) >= 0 &&
          Number(segmentationProcessor?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          Number(segmentationProcessor?.latestWorkerResult?.sequence || 0) > 0 &&
          segmentationProcessor?.latestWorkerResult?.processingConfigId ===
            modelProcessingConfigId &&
          Number(segmentationProcessor?.latestWorkerResult?.width || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerResult?.height || 0) > 0 &&
          segmentationProcessor?.latestWorkerResult?.inputSource === "video-frame" &&
          ["tasks-confidence", "tasks-category"].includes(
            segmentationProcessor?.latestWorkerResult?.source
          ) &&
          Array.isArray(
            segmentationProcessor?.latestWorkerResult?.qualityScores
          ) &&
          Number(
            segmentationProcessor?.latestWorkerResult?.confidenceMaskCount ?? 0
          ) >= 0 &&
          faceProcessor?.mode === "worker" &&
          faceProcessor?.workerSupported === true &&
          faceProcessor?.workerReady === true &&
          ["GPU", "CPU"].includes(faceProcessor?.workerDelegate) &&
          Number(faceProcessor?.workerFramesSent || 0) >= 1 &&
          Number(faceProcessor?.workerResults || 0) >= 1 &&
          Number(faceProcessor?.workerStaleResults ?? 0) >= 0 &&
          Number(faceProcessor?.workerFailures || 0) === 0 &&
          faceProcessor?.workerFirstResultSeen === true &&
          Number(faceProcessor?.latestWorkerSequence || 0) > 0 &&
          Number(faceProcessor?.latestWorkerAckSequence || 0) > 0 &&
          Number(faceProcessor?.latestWorkerProcessingMs ?? -1) >= 0 &&
          Number(faceProcessor?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          faceProcessorResultHealthy;
        const frameMetadataHealthy =
          frameMetadata?.type === "FRAME_METADATA" &&
          frameMetadata?.source === "client-video-effects" &&
          frameMetadata?.processingConfigId === framePipeline?.processingConfigId &&
          Number(frameMetadata?.sequence || 0) > 0 &&
          Number(frameMetadataDebug?.sequence || 0) >=
            Number(frameMetadata?.sequence || 0) &&
          Number(frameMetadata?.approximateTimestampMs ?? -1) >= 0 &&
          Number(frameMetadata?.exactTimestampMs ?? -1) >= 0 &&
          Number(frameMetadata?.frame?.width || 0) > 0 &&
          Number(frameMetadata?.frame?.height || 0) > 0 &&
          Number(frameMetadata?.frame?.frameSequence || 0) > 0 &&
          Number(frameMetadata?.roomTilingMetadata?.enabledFramesCount || 0) > 0 &&
          Number(frameMetadata?.roomTilingMetadata?.tileCount ?? -1) >= 0 &&
          typeof frameMetadata?.roomTilingMetadata?.tilesStable === "boolean" &&
          Number(frameMetadata?.roomTilingMetadata?.fallbackLevel ?? -1) >= 0 &&
          Number(frameMetadata?.humanTrackingMetadata?.lifetimeTrackCount ?? -1) >= 0 &&
          Number(frameMetadata?.humanTrackingMetadata?.activeTrackCount ?? -1) >= 0 &&
          Array.isArray(frameMetadata?.humanTrackingMetadata?.trackedHumans) &&
          frameMetadata?.continuousAutozoomMetadata?.enabled === false &&
          frameMetadata?.continuousAutozoomMetadata?.source === "off" &&
          Number(frameMetadata?.continuousAutozoomMetadata?.zoomFactor || 0) === 1 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.crop?.sw || 0) > 0 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.targetCrop?.sw || 0) > 0 &&
          (!${JSON.stringify(expectFaceLandmarks)} ||
            (Number(frameMetadata?.humanTrackingMetadata?.activeTrackCount || 0) > 0 &&
              frameMetadata.humanTrackingMetadata.trackedHumans.some(
                (track) => track.source === "face"
              )));
        const temporalMaskHealthy =
          temporalMask?.enabled === true &&
          (temporalMask?.source === "tasks-confidence" ||
            temporalMask?.source === "tasks-category") &&
          Number(temporalMask?.alpha || 0) > 0 &&
          Number(temporalMask?.frameCount || 0) > 0 &&
          Number(temporalMask?.shapeFrameCount || 0) > 0 &&
          Number(temporalMask?.smoothedFrameCount || 0) > 0 &&
          Number(temporalMask?.pixelCount || 0) > 0 &&
          temporalMask?.hasHistory === true;
        const outputHealthy = panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "2" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          backgroundRender?.background === "blur-strong" &&
          backgroundRender?.active === true &&
          Number(backgroundRender?.changedPixels || 0) > 0 &&
          stats?.needsFace === true &&
          ((stats?.framePipeline?.segmentationProcessor?.mode === "worker" && Number(stats?.framePipeline?.segmentationProcessor?.workerResults || 0) > 0) || Number(stats?.closedSegmentationMasks || 0) > 0) &&
          faceRender?.filter === "sparkles" &&
          ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
          stats?.outputMode === "track-generator" &&
          framePipelineHealthy &&
          frameMetadataHealthy &&
          temporalMaskHealthy &&
          adaptationHealthy;
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          faceRender?.drawn === true &&
          Number(faceRender?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_camera_off_rapid_effect_start");
    assertOutputWriterQuality(state, "camera-off rapid effect start");
    await waitForMeetVideoPublish(
      cdp,
      "rapid start producer uses processed effects",
      "processed",
    );
    if (headlessMobileViewport) {
      await collectMobileRoomTilingProbe(
        cdp,
        "mobile_room_tiling_after_effects_output",
      );
      await collectLayoutState(cdp, "mobile_layout_after_effects_output");
    }
    emit("camera_off_rapid_effect_start_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      backgroundRender: state.panelStats?.backgroundRender ?? null,
      faceFilterRender: state.panelStats?.faceFilterRender ?? null,
      framePipeline: state.panelStats?.framePipeline ?? null,
      frameMetadata:
        state.panelStats?.frameMetadata ??
        state.videoEffectsFrameMetadataDebug?.current ??
        null,
      frameMetadataDebug: state.videoEffectsFrameMetadataDebug ?? null,
      outputWriter: state.panelStats?.framePipeline?.outputWriter ?? null,
      segmentationProcessor:
        state.panelStats?.framePipeline?.segmentationProcessor ?? null,
      faceProcessor: state.panelStats?.framePipeline?.faceProcessor ?? null,
      temporalMask: state.panelStats?.temporalMask ?? null,
      adaptation: state.panelStats?.adaptation ?? null,
    });

    if (headlessMobileViewport && headlessProbe === "effects") {
      const badLogs = cdp.logs.filter((log) =>
        badLogPatterns.some((pattern) => pattern.test(log.text)),
      );
      const prewarmDoneKinds = new Set(
        cdp.logs
          .filter((log) => /processor_worker_prewarm_done/.test(log.text))
          .map((log) => {
            const match = log.text.match(/"kind":"([^"]+)"/);
            return match?.[1] ?? null;
          })
          .filter(Boolean),
      );
      const prewarmSuppressedKinds = new Set(
        cdp.logs
          .filter((log) =>
            /processor_worker_prewarm_(?:suppressed|cancelled)_busy/.test(
              log.text,
            ),
          )
          .map((log) => {
            const match = log.text.match(/"kind":"([^"]+)"/);
            return match?.[1] ?? null;
          })
          .filter(Boolean),
      );
      const prewarmFailureLogs = cdp.logs.filter((log) =>
        /processor_worker_prewarm_failed|output_writer_worker_prewarm_failed/.test(
          log.text,
        ),
      );
      const missingPrewarmKinds = ["segmentation", "face"].filter(
        (kind) =>
          !prewarmDoneKinds.has(kind) && !prewarmSuppressedKinds.has(kind),
      );
      const outputWriterPrewarmDone = cdp.logs.some((log) =>
        /output_writer_worker_prewarm_done/.test(log.text),
      );
      const outputWriterPrewarmSuppressed = cdp.logs.some((log) =>
        /output_writer_worker_prewarm_suppressed_busy/.test(log.text),
      );
      const mobileSwitchLatencyQuality = getEffectSwitchLatencyQuality(
        cdp.logs,
        state,
        "mobile-effects",
        {
          fromIndex: rapidEffectSwitchLogIndex,
          minSamples: Math.min(minEffectSwitchLatencySamples, 3),
        },
      );
      emit("mobile_effects_quality_probe", {
        ok:
          badLogs.length === 0 &&
          prewarmFailureLogs.length === 0 &&
          missingPrewarmKinds.length === 0 &&
          (outputWriterPrewarmDone || outputWriterPrewarmSuppressed) &&
          cameraToggleLivePrewarmRequested &&
          cameraToggleLivePrewarmDone &&
          mobileSwitchLatencyQuality.ok,
        badLogs,
        doneKinds: Array.from(prewarmDoneKinds),
        suppressedKinds: Array.from(prewarmSuppressedKinds),
        missingKinds: missingPrewarmKinds,
        outputWriterDone: outputWriterPrewarmDone,
        outputWriterSuppressed: outputWriterPrewarmSuppressed,
        cameraToggleLivePrewarmRequested,
        cameraToggleLivePrewarmDone,
        effectSwitchLatencyQuality: mobileSwitchLatencyQuality,
      });
      if (
        state.panelAttrs?.["data-video-effects-output-published"] !== "true" ||
        state.panelAttrs?.["data-video-effects-status"] !== "running" ||
        Number(
          state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
        ) !== 0 ||
        badLogs.length > 0 ||
        prewarmFailureLogs.length > 0 ||
        missingPrewarmKinds.length > 0 ||
        (!outputWriterPrewarmDone && !outputWriterPrewarmSuppressed) ||
        !cameraToggleLivePrewarmRequested ||
        !cameraToggleLivePrewarmDone ||
        !mobileSwitchLatencyQuality.ok
      ) {
        throw new Error(
          `Mobile effects headless regression failed: ${JSON.stringify({
            badLogs,
            prewarmFailureLogs,
            missingPrewarmKinds,
            outputWriterPrewarmDone,
            outputWriterPrewarmSuppressed,
            cameraToggleLivePrewarmRequested,
            cameraToggleLivePrewarmDone,
            mobileSwitchLatencyQuality,
            status: state.panelAttrs?.["data-video-effects-status"],
            outputPublished:
              state.panelAttrs?.["data-video-effects-output-published"],
            blackOutputFrameCount:
              state.panelAttrs?.["data-video-effects-black-output-count"],
          })}`,
        );
      }
      emit("result", { ok: true, probe: headlessProbe, mobile: true });
      return;
    }

    await clickButton(cdp, "Appearance");
    await clickButton(cdp, "Adjust video lighting");
    await sleep(75);
    await clickButton(cdp, "Framing");
    await waitFor(
      cdp,
      "appearance low-light and framing output healthy",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const switches = Array.from(panel?.querySelectorAll('[role="switch"]') ?? []);
        const lightingSwitch = switches.find((button) =>
          (button.textContent || "").includes("Adjust video lighting")
        );
        const framingSwitch = switches.find((button) =>
          (button.textContent || "").includes("Framing")
        );
        const lowLight = stats?.lowLightRender;
        const autoFrame = stats?.autoFrame;
        const backgroundRender = stats?.backgroundRender;
        const faceRender = stats?.faceFilterRender;
        const adaptation = stats?.adaptation;
        const visualTransition = stats?.visualTransition;
        const framePipeline = stats?.framePipeline;
        const modelProcessingConfigId =
          framePipeline?.modelProcessingConfigId ?? framePipeline?.processingConfigId;
        const outputWriter = framePipeline?.outputWriter;
        const frameMetadataDebug =
          typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
            ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
            : window.__conclaveVideoEffectsFrameMetadataDebug ?? null;
        const frameMetadata = stats?.frameMetadata || frameMetadataDebug?.current;
        const adaptationHealthy =
          [1400, 1200, 1100, 1000].includes(Number(adaptation?.adaptationTier)) &&
          Array.isArray(adaptation?.availableTiers) &&
          adaptation.availableTiers.includes(Number(adaptation?.adaptationTier)) &&
          adaptation?.adaptiveEffect === true &&
          Number(adaptation?.modelIntervalScale || 0) >= 1 &&
          Number(adaptation?.processingDelayMs) >= 0 &&
          Number(adaptation?.fullProcessingDelayMs) >= 0 &&
          Number(adaptation?.asyncProcessingDelayMs) >= 0 &&
          Number(adaptation?.frameIntervalMs) > 0 &&
          Number(adaptation?.targetSegmentationIntervalMs) >= 42 &&
          Number(adaptation?.targetFaceIntervalMs) >= 42;
        const frameMetadataHealthy =
          frameMetadata?.type === "FRAME_METADATA" &&
          frameMetadata?.processingConfigId === framePipeline?.processingConfigId &&
          Number(frameMetadata?.sequence || 0) > 0 &&
          Number(frameMetadataDebug?.sequence || 0) >=
            Number(frameMetadata?.sequence || 0) &&
          frameMetadata?.continuousAutozoomMetadata?.enabled === true &&
          ["face", "foreground", "center"].includes(
            frameMetadata?.continuousAutozoomMetadata?.source
          ) &&
          Number(frameMetadata?.continuousAutozoomMetadata?.zoomFactor || 0) > 1 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.crop?.sw || 0) > 0 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.targetCrop?.sw || 0) > 0 &&
          Number(frameMetadata?.roomTilingMetadata?.enabledFramesCount || 0) > 0 &&
          Number(frameMetadata?.humanTrackingMetadata?.activeTrackCount ?? -1) >= 0;
        const outputHealthy = panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "4" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          lightingSwitch?.getAttribute("aria-checked") === "true" &&
          framingSwitch?.getAttribute("aria-checked") === "true" &&
          lowLight?.enabled === true &&
          Number(lowLight?.brighteningStrength || 0) > 0 &&
          Number(lowLight?.targetBrighteningStrength || 0) > 0 &&
          Number(lowLight?.transitionMs || 0) === 1000 &&
          Number(lowLight?.transitionProgress || 0) >= 0 &&
          Number(lowLight?.transitionProgress || 0) <= 1 &&
          lowLight?.hasSegmentationMask === true &&
          Number(lowLight?.samplePixelCount || 0) > 0 &&
          ["render-output", "render-crop", "source-crop"].includes(
            lowLight?.maskSampleMode
          ) &&
          autoFrame?.enabled === true &&
          Number(autoFrame?.zoom || 0) > 1 &&
          ["face", "foreground", "center"].includes(autoFrame?.source) &&
          (
            Number(lowLight?.foregroundSampleWeight || 0) > 0 ||
            Number(lowLight?.backgroundSampleWeight || 0) > 0
          ) &&
          backgroundRender?.background === "blur-strong" &&
          backgroundRender?.active === true &&
          Number(backgroundRender?.changedPixels || 0) > 0 &&
          stats?.needsFace === true &&
          ((stats?.framePipeline?.segmentationProcessor?.mode === "worker" && Number(stats?.framePipeline?.segmentationProcessor?.workerResults || 0) > 0) || Number(stats?.closedSegmentationMasks || 0) > 0) &&
          faceRender?.filter === "sparkles" &&
          ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
          stats?.outputMode === "track-generator" &&
          frameMetadataHealthy &&
          adaptationHealthy;
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          Number(lowLight?.foregroundSampleWeight || 0) > 0 &&
          autoFrame?.source === "face" &&
          faceRender?.drawn === true &&
          Number(faceRender?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_appearance_low_light_framing");
    assertOutputWriterQuality(state, "appearance low-light and framing");
    await waitForMeetVideoPublish(
      cdp,
      "appearance producer uses processed effects",
      "processed",
    );
    emit("appearance_low_light_framing_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      schedulerMode: state.panelStats?.schedulerMode ?? null,
      outputMode: state.panelStats?.outputMode ?? null,
      backgroundRender: state.panelStats?.backgroundRender ?? null,
      faceFilterRender: state.panelStats?.faceFilterRender ?? null,
      lowLightRender: state.panelStats?.lowLightRender ?? null,
      autoFrame: state.panelStats?.autoFrame ?? null,
      frameMetadata:
        state.panelStats?.frameMetadata ??
        state.videoEffectsFrameMetadataDebug?.current ??
        null,
      frameMetadataDebug: state.videoEffectsFrameMetadataDebug ?? null,
      adaptation: state.panelStats?.adaptation ?? null,
    });

    const recenterCountBefore = Number(
      state.panelStats?.autoFrame?.recenterCount ?? 0,
    );
    await clickButton(cdp, "Recenter");
    await waitFor(
      cdp,
      "framing recenter signal processed",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const autoFrame = stats?.autoFrame;
        const recenterButton = panel?.querySelector(
          '[data-testid="video-effects-recenter-framing"]',
        );
        return panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          recenterButton instanceof HTMLButtonElement &&
          recenterButton.disabled === false &&
          autoFrame?.enabled === true &&
          Number(autoFrame?.recenterCount || 0) > ${JSON.stringify(recenterCountBefore)} &&
          Number(autoFrame?.lastRecenterAgeMs) >= 0 &&
          Number(autoFrame?.lastRecenterAgeMs) < 3000 &&
          Number(autoFrame?.zoom || 0) > 1 &&
          ["face", "foreground", "center"].includes(autoFrame?.source);
      })()`,
      10000,
    );
    state = await collectState(cdp, "state_after_framing_recenter");
    await waitForMeetVideoPublish(
      cdp,
      "framing recenter producer stays processed",
      "processed",
    );
    emit("framing_recenter_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      autoFrame: state.panelStats?.autoFrame ?? null,
    });

    if (expectFaceLandmarks) {
      await clickButton(cdp, "Active effects");
      await waitFor(
        cdp,
        "active effects stack opened before framing-only static crop",
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          const stack = panel?.querySelector("[data-video-effects-active-stack='true']");
          const removeAll = Array.from(stack?.querySelectorAll("button") ?? []).some(
            (button) => button.getAttribute("aria-label") === "Remove all visual effects"
          );
          return panel?.getAttribute("data-video-effects-active-count") !== "0" &&
            Boolean(stack) &&
            stack?.getAttribute("data-video-effects-active-stack-open") === "true" &&
            removeAll;
        })()`,
        10000,
      );
      await clickButton(cdp, "Remove all visual effects");
      await waitFor(
        cdp,
        "effects disabled before framing-only static crop",
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          return panel?.getAttribute("data-video-effects-status") === "off" &&
            panel?.getAttribute("data-video-effects-active-count") === "0" &&
            panel?.getAttribute("data-video-effects-output-published") === "false";
        })()`,
        10000,
      );
      await clickButton(cdp, "Appearance");
      await clickButton(cdp, "Framing");
      await waitFor(
        cdp,
        "framing-only static crop active",
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          const raw = panel?.getAttribute("data-video-effects-stats");
          let stats = null;
          try { stats = raw ? JSON.parse(raw) : null; } catch {}
          const autoFrame = stats?.autoFrame;
          const staticCrop = autoFrame?.staticCrop;
          const framePipeline = stats?.framePipeline;
          const frameMetadataDebug =
            typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
              ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
              : window.__conclaveVideoEffectsFrameMetadataDebug ?? null;
          const frameMetadata = stats?.frameMetadata || frameMetadataDebug?.current;
          return panel?.getAttribute("data-video-effects-status") === "running" &&
            panel?.getAttribute("data-video-effects-active-count") === "1" &&
            panel?.getAttribute("data-video-effects-output-published") === "true" &&
            panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
            Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
            stats?.needsFace === true &&
            stats?.needsSegmentation === false &&
            stats?.effects?.framing === true &&
            stats?.effects?.background === "none" &&
            stats?.effects?.filter === "none" &&
            stats?.effects?.style === "none" &&
            stats?.effects?.studioLighting === false &&
            stats?.effects?.studioLook === false &&
            autoFrame?.enabled === true &&
            autoFrame?.source === "face" &&
            Number(autoFrame?.zoom || 0) > 1 &&
            Number(stats?.faceLandmarkCount || 0) > 0 &&
            staticCrop?.eligible === true &&
            staticCrop?.active === true &&
            Number(staticCrop?.stableFrameCount || 0) >= Number(staticCrop?.enterThresholdFrames || 0) &&
            Number(staticCrop?.activationCount || 0) >= 1 &&
            Number(staticCrop?.modelSkipCount || 0) >= 1 &&
            Number(staticCrop?.faceRevalidationIntervalMs || 0) === 360 &&
            Number(staticCrop?.latestDriftPx ?? 99) <= Number(staticCrop?.exitDriftPx || 0) &&
            Number(stats?.intervals?.faceIntervalMs || 0) >= 360 &&
            Number(stats?.adaptation?.targetFaceIntervalMs || 0) >= 360 &&
            framePipeline?.outputTrackPublished === true &&
            framePipeline?.lastFrame?.outputDelivered === true &&
            framePipeline?.lastFrame?.outputVisible === true &&
            frameMetadata?.continuousAutozoomMetadata?.enabled === true &&
            frameMetadata?.continuousAutozoomMetadata?.source === "face";
        })()`,
        30000,
      );
      state = await collectState(cdp, "state_after_framing_only_static_crop");
      await waitForMeetVideoPublish(
        cdp,
        "framing-only static crop producer uses processed output",
        "processed",
      );
      emit("framing_only_static_crop_probe", {
        status: state.panelAttrs?.["data-video-effects-status"],
        activeCount: state.panelAttrs?.["data-video-effects-active-count"],
        outputPublished: state.panelStats?.outputTrackPublished === true,
        previewMatchesOutput:
          state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
          "true",
        blackOutputFrameCount: Number(
          state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
        ),
        autoFrame: state.panelStats?.autoFrame ?? null,
        intervals: state.panelStats?.intervals ?? null,
        adaptation: state.panelStats?.adaptation ?? null,
      });
    }
    await clickButton(cdp, "Backgrounds");

    const backgroundProbes = [];
    for (const label of backgroundLabels) {
      const expectedBackgroundId = backgroundIdByLabel.get(label);
      if (!expectedBackgroundId) {
        throw new Error(`Unknown background label configured: ${label}`);
      }
      const eventLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await clickButton(cdp, label);
      await waitFor(
        cdp,
        `${label} background render`,
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          const raw = panel?.getAttribute("data-video-effects-stats");
          let stats = null;
          try { stats = raw ? JSON.parse(raw) : null; } catch {}
          const render = stats?.backgroundRender;
          const previewMatchesOutput =
            panel?.getAttribute("data-video-effects-preview-matches-output") === "true";
          const imageReady = ${JSON.stringify(imageBackedBackgroundIds.has(expectedBackgroundId))}
            ? render?.hasBackgroundImage === true
            : true;
          return panel?.getAttribute("data-video-effects-status") === "running" &&
            panel?.getAttribute("data-video-effects-output-published") === "true" &&
            Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
            previewMatchesOutput &&
            render?.background === ${JSON.stringify(expectedBackgroundId)} &&
            render?.active === true &&
            Number(render?.changedPixels || 0) > 0 &&
            imageReady;
        })()`,
        30000,
      );
      state = await collectState(cdp, `state_after_background_${eventLabel}`);
      await waitForMeetVideoPublish(
        cdp,
        `${label} producer uses processed background`,
        "processed",
      );
      const render = state.panelStats?.backgroundRender ?? null;
      const backgroundProbe = {
        label,
        expectedBackgroundId,
        requiresBackgroundImage: imageBackedBackgroundIds.has(expectedBackgroundId),
        outputTrackPublished: state.panelStats?.outputTrackPublished === true,
        previewMatchesOutput:
          state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
          "true",
        render,
      };
      backgroundProbes.push(backgroundProbe);
      emit("background_probe", backgroundProbe);
    }
    emit("background_probe_summary", { backgroundProbes });

    await uploadCustomBackground(cdp);
    await waitFor(
      cdp,
      "custom background render",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        const render = stats?.backgroundRender;
        const savedTileCount = document.querySelectorAll(
          '[data-testid="custom-background-saved-tile"]',
        ).length;
        return stored?.background === "custom" &&
          typeof stored?.customBackgroundId === "string" &&
          stored.customBackgroundId.startsWith("custom-") &&
          !stored?.customBackgroundDataUrl &&
          stored?.customBackgroundName === "conclave-custom-background.png" &&
          savedTileCount >= 1 &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          render?.background === "custom" &&
          render?.active === true &&
          render?.hasBackgroundImage === true &&
          Number(render?.changedPixels || 0) > 0 &&
          stats?.effects?.customBackground === true &&
          stats?.effects?.customBackgroundId === stored.customBackgroundId &&
          stats?.needsSegmentation === true &&
          ((stats?.framePipeline?.segmentationProcessor?.mode === "worker" && Number(stats?.framePipeline?.segmentationProcessor?.workerResults || 0) > 0) || Number(stats?.closedSegmentationMasks || 0) > 0);
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_custom_background_upload");
    await waitForMeetVideoPublish(
      cdp,
      "custom background producer uses processed output",
      "processed",
    );
    emit("custom_background_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      effects: state.panelStats?.effects ?? null,
      backgroundRender: state.panelStats?.backgroundRender ?? null,
    });

    await cdp.send("Page.reload", { ignoreCache: true });
    emit("page_reload_after_custom_background", { url });
    await waitFor(
      cdp,
      "meeting surface after custom background reload",
      `(() => {
        const hasGrid = Boolean(document.querySelector("[data-meet-view-layout]"));
        const hasEffectsButton = Array.from(document.querySelectorAll("button")).some(
          (button) => (button.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim() === "Backgrounds and effects"
        );
        return hasGrid || hasEffectsButton;
      })()`,
      30000,
    );
    await turnCameraOnIfNeeded(
      cdp,
      "camera on after custom background reload",
    );
    await openMeetingEffectsPanel(
      cdp,
      "custom background restored effects panel",
    );
    await waitFor(
      cdp,
      "custom background restored from indexeddb",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        const render = stats?.backgroundRender;
        const savedTileCount = document.querySelectorAll(
          '[data-testid="custom-background-saved-tile"]',
        ).length;
        return stored?.background === "custom" &&
          typeof stored?.customBackgroundId === "string" &&
          stored.customBackgroundId.startsWith("custom-") &&
          !stored?.customBackgroundDataUrl &&
          stored?.customBackgroundName === "conclave-custom-background.png" &&
          savedTileCount >= 1 &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          render?.background === "custom" &&
          render?.active === true &&
          render?.hasBackgroundImage === true &&
          Number(render?.changedPixels || 0) > 0 &&
          stats?.effects?.customBackground === true &&
          stats?.effects?.customBackgroundId === stored.customBackgroundId &&
          stats?.needsSegmentation === true &&
          ((stats?.framePipeline?.segmentationProcessor?.mode === "worker" && Number(stats?.framePipeline?.segmentationProcessor?.workerResults || 0) > 0) || Number(stats?.closedSegmentationMasks || 0) > 0);
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_custom_background_reload");
    await waitForMeetVideoPublish(
      cdp,
      "custom background reload producer uses processed output",
      "processed",
    );
    emit("custom_background_reload_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      effects: state.panelStats?.effects ?? null,
      backgroundRender: state.panelStats?.backgroundRender ?? null,
    });

    await clickButton(cdp, "Blur your background");
    await waitFor(
      cdp,
      "blur restored after custom background",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        return stored?.background === "blur-strong" &&
          typeof stored?.customBackgroundId === "string" &&
          stored.customBackgroundId.startsWith("custom-") &&
          !stored?.customBackgroundDataUrl &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          stats?.backgroundRender?.background === "blur-strong" &&
          stats?.backgroundRender?.active === true;
      })()`,
      30000,
    );

    await clickButton(cdp, "Filters");
    await sleep(500);

    const faceProbes = [];
    for (const label of faceFilterLabels) {
      const expectedFilterId = faceFilterIdByLabel.get(label);
      if (!expectedFilterId) {
        throw new Error(`Unknown face filter label configured: ${label}`);
      }
      const eventLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await clickButton(cdp, label);
      await waitFor(
        cdp,
        `${label} face filter output`,
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          const raw = panel?.getAttribute("data-video-effects-stats");
          let stats = null;
          try { stats = raw ? JSON.parse(raw) : null; } catch {}
          const render = stats?.faceFilterRender;
          const anchor = render?.anchor;
          const bounds = render?.bounds;
          const eyeCenterDistance = Number(anchor?.eyeCenterDistance || 0);
          const outerEyeDistance = Number(anchor?.outerEyeDistance || 0);
          const faceWidth = Number(anchor?.faceWidth || 0);
          const faceHeight = Number(anchor?.faceHeight || 0);
          const headTopY = Number(anchor?.headTopY || 0);
          const headCenterX = Number(anchor?.headCenterX || 0);
          const chinY = Number(anchor?.chinY || 0);
          const noseY = Number(anchor?.noseY || 0);
          const mouthCenterX = Number(anchor?.mouthCenterX || 0);
          const mouthCenterY = Number(anchor?.mouthCenterY || 0);
          const mouthWidth = Number(anchor?.mouthWidth || 0);
          const faceIntervalMs = Number(stats?.intervals?.faceIntervalMs || 999);
          const landmarkSmoothingAlpha = Number(stats?.faceDetection?.landmarkSmoothing?.alpha || 0);
          const filterLandmarkSmoothingAlpha = Number(stats?.faceDetection?.filterLandmarkSmoothing?.alpha || 0);
          const anchorHealthy = Boolean(anchor) &&
            ["iris", "contour"].includes(anchor?.eyeAnchorBasis) &&
            eyeCenterDistance > 0 &&
            outerEyeDistance >= eyeCenterDistance;
          const filterTrackingHealthy =
            Number(stats?.faceFilterLandmarkCount || 0) > 0 &&
            filterLandmarkSmoothingAlpha >= 0.7 &&
            filterLandmarkSmoothingAlpha >= landmarkSmoothingAlpha &&
            faceIntervalMs <= 70;
          const geometryHealthy =
            faceWidth > 0 &&
            faceHeight >= faceWidth * 0.85 &&
            faceHeight <= faceWidth * 2.1 &&
            headTopY <= -faceWidth * 0.2 &&
            chinY >= faceWidth * 0.35 &&
            noseY >= 0 &&
            noseY <= chinY + faceWidth * 0.2 &&
            Math.abs(headCenterX) <= faceWidth * 0.25 &&
            Math.abs(mouthCenterX) <= faceWidth * 0.35 &&
            mouthCenterY >= noseY &&
            mouthCenterY <= chinY + faceWidth * 0.18 &&
            mouthWidth >= faceWidth * 0.15 &&
            mouthWidth <= faceWidth * 0.45;
          const boundsCenterX = Number(bounds?.x || 0) + Number(bounds?.width || 0) / 2;
          const boundsHealthy = !bounds || (
            Number(bounds.width || 0) > 0 &&
            Number(bounds.height || 0) > 0 &&
            Math.abs(boundsCenterX - Number(anchor?.centerX || 0)) <= Math.max(80, faceWidth * 0.85) &&
            Number(bounds.y || 0) >= Number(anchor?.centerY || 0) + headTopY - faceWidth * 0.78 &&
            Number(bounds.y || 0) + Number(bounds.height || 0) <=
              Number(anchor?.centerY || 0) + chinY + faceWidth * 0.42
          );
          const outputHealthy = panel?.getAttribute("data-video-effects-status") === "running" &&
            panel?.getAttribute("data-video-effects-output-published") === "true" &&
            panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
            Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
            stats?.needsFace === true;
          if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
          return outputHealthy &&
            Number(stats?.faceLandmarkCount || 0) > 0 &&
            render?.filter === ${JSON.stringify(expectedFilterId)} &&
            render?.drawn === true &&
            Number(render?.changedPixels || 0) > 0 &&
            anchorHealthy &&
            filterTrackingHealthy &&
            geometryHealthy &&
            boundsHealthy;
        })()`,
        30000,
      );
      state = await collectState(cdp, `state_after_filter_${eventLabel}`);
      await waitForMeetVideoPublish(
        cdp,
        `${label} producer uses processed filter`,
        "processed",
      );
      const render = state.panelStats?.faceFilterRender ?? null;
      const faceProbe = {
        label,
        expectedFilterId,
        expectFaceLandmarks,
        faceLandmarkCount: Number(state.panelStats?.faceLandmarkCount ?? 0),
        latestFaceLandmarksAgeMs:
          typeof state.panelStats?.latestFaceLandmarksAgeMs === "number"
            ? state.panelStats.latestFaceLandmarksAgeMs
            : null,
        needsFace: state.panelStats?.needsFace === true,
        outputTrackPublished: state.panelStats?.outputTrackPublished === true,
        previewMatchesOutput:
          state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
          "true",
        taskFaceRuns: Number(state.panelStats?.taskFaceRuns ?? 0),
        alignment: render?.anchor
          ? {
              faceWidth: render.anchor.faceWidth ?? null,
              faceHeight: render.anchor.faceHeight ?? null,
              headTopY: render.anchor.headTopY ?? null,
              headCenterX: render.anchor.headCenterX ?? null,
              chinY: render.anchor.chinY ?? null,
              noseY: render.anchor.noseY ?? null,
              mouthCenterX: render.anchor.mouthCenterX ?? null,
              mouthCenterY: render.anchor.mouthCenterY ?? null,
              mouthWidth: render.anchor.mouthWidth ?? null,
              faceIntervalMs:
                typeof state.panelStats?.intervals?.faceIntervalMs === "number"
                  ? state.panelStats.intervals.faceIntervalMs
                  : null,
              landmarkSmoothing:
                state.panelStats?.faceDetection?.landmarkSmoothing ?? null,
              filterLandmarkSmoothing:
                state.panelStats?.faceDetection?.filterLandmarkSmoothing ?? null,
              bounds: render.bounds ?? null,
            }
          : null,
        render,
      };
      faceProbes.push(faceProbe);
      emit("face_filter_probe", faceProbe);
    }

    emit("face_filter_probe_summary", { faceProbes });

    await clickButton(cdp, "Active effects");
    await waitFor(
      cdp,
      "active effects stack opened before removing all",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const stack = panel?.querySelector("[data-video-effects-active-stack='true']");
        const removeAll = Array.from(stack?.querySelectorAll("button") ?? []).some(
          (button) => button.getAttribute("aria-label") === "Remove all visual effects"
        );
        return panel?.getAttribute("data-video-effects-active-count") !== "0" &&
          Boolean(stack) &&
          stack?.getAttribute("data-video-effects-active-stack-open") === "true" &&
          removeAll;
      })()`,
      10000,
    );
    await clickButton(cdp, "Remove all visual effects");
    await waitFor(
      cdp,
      "effects disabled raw camera healthy",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const debug =
          typeof window.__conclaveGetMeetVideoDebug === "function"
            ? window.__conclaveGetMeetVideoDebug()
            : window.__conclaveMeetVideoDebug ?? null;
        const producerTrack = debug?.videoProducer?.track;
        const rawTrack = debug?.rawTrack;
        const rawPublishHealthy =
          debug?.connectionState === "joined" &&
          debug?.isCameraOff === false &&
          debug?.publish?.shouldPublishProcessed === false &&
          debug?.publish?.usingRawTrack === true &&
          debug?.publish?.producerTrackLive === true &&
          producerTrack?.readyState === "live" &&
          producerTrack?.enabled !== false &&
          rawTrack?.readyState === "live";
        return panel?.getAttribute("data-video-effects-status") === "off" &&
          panel?.getAttribute("data-video-effects-active-count") === "0" &&
          panel?.getAttribute("data-video-effects-output-published") === "false" &&
          panel?.getAttribute("data-video-effects-frame-source") === "raw" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 0) === 0 &&
          rawPublishHealthy;
      })()`,
      20000,
    );
    const disabledState = await collectState(cdp, "state_after_effects_disabled");
    await waitForMeetVideoPublish(
      cdp,
      "effects disabled producer uses raw camera",
      "raw",
    );
    emit("effects_disabled_probe", {
      status: disabledState.panelAttrs?.["data-video-effects-status"],
      activeCount: disabledState.panelAttrs?.["data-video-effects-active-count"],
      outputPublished:
        disabledState.panelAttrs?.["data-video-effects-output-published"],
      previewTrackState:
        disabledState.panelAttrs?.["data-video-effects-preview-track-state"],
      videos: disabledState.videos,
    });

    await clickButton(cdp, "Backgrounds");
    await clickButton(cdp, "Blur your background");
    const reenabledPassthrough = await waitFor(
      cdp,
      "visible passthrough while background warms after effects disabled",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const lastFrame = stats?.framePipeline?.lastFrame;
        return panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          stats?.effects?.background === "blur-strong" &&
          stats?.needsSegmentation === true &&
          lastFrame?.processingConfigId === stats?.framePipeline?.processingConfigId &&
          lastFrame?.outputDelivered === true &&
          lastFrame?.outputVisible === true;
      })()`,
      5000,
    );
    emit("effects_reenabled_passthrough_probe", { ok: reenabledPassthrough });
    await waitFor(
      cdp,
      "background output after effects disabled",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const render = stats?.backgroundRender;
        return panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          render?.background === "blur-strong" &&
          render?.active === true &&
          Number(render?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    await clickButton(cdp, "Filters");
    await clickButton(cdp, "Sparkles");
    await waitFor(
      cdp,
      "filter output after effects disabled",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const render = stats?.faceFilterRender;
        const outputHealthy = panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          stats?.needsFace === true;
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          render?.filter === "sparkles" &&
          render?.drawn === true &&
          Number(render?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_effects_reenabled");
    assertOutputWriterQuality(state, "effects reenabled");
    await waitForMeetVideoPublish(
      cdp,
      "effects reenabled producer uses processed output",
      "processed",
    );
    state = await forceCloseLocalVideoProducerForDebug(
      cdp,
      "effects reenabled producer close",
    );
    assertOutputWriterQuality(state, "effects reenabled producer close recovery");
    await waitForMeetVideoPublish(
      cdp,
      "effects reenabled producer close keeps processed output",
      "processed",
    );

    await clickButton(cdp, "Backgrounds");
    rapidEffectSwitchLogIndex = cdp.logs.length;
    for (const label of ["Office shelf", "Color field", "Slight blur", "Blur"]) {
      await clickButton(cdp, label);
      await sleep(75);
    }
    await clickButton(cdp, "Filters");
    const rapidFilterLabels = expectFaceLandmarks
      ? ["Glasses", "No filter", "Light halo", "Sparkles"]
      : ["No filter", "Sparkles"];
    for (const label of rapidFilterLabels) {
      await clickButton(cdp, label);
      await sleep(75);
    }
    await waitFor(
      cdp,
      "rapid effect switch output healthy",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const backgroundRender = stats?.backgroundRender;
        const faceRender = stats?.faceFilterRender;
        const adaptation = stats?.adaptation;
        const visualTransition = stats?.visualTransition;
        const framePipeline = stats?.framePipeline;
        const modelProcessingConfigId =
          framePipeline?.modelProcessingConfigId ?? framePipeline?.processingConfigId;
        const outputWriter = framePipeline?.outputWriter;
        const segmentationProcessor = framePipeline?.segmentationProcessor;
        const faceProcessor = framePipeline?.faceProcessor;
        const frameMetadataDebug =
          typeof window.__conclaveGetVideoEffectsFrameMetadataDebug === "function"
            ? window.__conclaveGetVideoEffectsFrameMetadataDebug()
            : window.__conclaveVideoEffectsFrameMetadataDebug ?? null;
        const frameMetadata = stats?.frameMetadata || frameMetadataDebug?.current;
        const adaptationHealthy =
          [1400, 1200, 1100, 1000].includes(Number(adaptation?.adaptationTier)) &&
          Array.isArray(adaptation?.availableTiers) &&
          adaptation.availableTiers.includes(Number(adaptation?.adaptationTier)) &&
          adaptation?.adaptiveEffect === true &&
          Number(adaptation?.modelIntervalScale || 0) >= 1 &&
          Number(adaptation?.processingDelayMs) >= 0 &&
          Number(adaptation?.frameIntervalMs) > 0 &&
          Number(adaptation?.targetSegmentationIntervalMs) >= 42 &&
          Number(adaptation?.targetFaceIntervalMs) >= 42;
        const transitionHealthy =
          (() => {
            const transitionMs = Number(visualTransition?.transitionMs || 0);
            const transitionReason =
              visualTransition?.reason && visualTransition.reason !== "none"
                ? visualTransition.reason
                : visualTransition?.lastReason;
            const expectedTransitionMsByReason = {
              background: 180,
              "custom-background": 180,
              filter: 90,
              style: 120,
              appearance: 120,
              framing: 100,
              mixed: 140,
            };
            const expectedTransitionMs =
              expectedTransitionMsByReason[transitionReason];
            return expectedTransitionMs
              ? transitionMs === expectedTransitionMs
              : [90, 100, 120, 140, 180].includes(transitionMs);
          })() &&
          visualTransition?.enabled === true &&
          Number(visualTransition?.runCount || 0) >= 4 &&
          Number(visualTransition?.completedCount || 0) >= 1 &&
          Number(visualTransition?.skippedCount || 0) === 0 &&
          ["background", "filter", "mixed"].includes(visualTransition?.lastReason) &&
          Number(visualTransition?.progress ?? -1) >= 0 &&
          Number(visualTransition?.progress ?? 2) <= 1 &&
          Number(visualTransition?.easedProgress ?? -1) >= 0 &&
          Number(visualTransition?.easedProgress ?? 2) <= 1 &&
          Number(visualTransition?.previousOpacity ?? -1) >= 0 &&
          Number(visualTransition?.previousOpacity ?? 2) <= 1 &&
          visualTransition?.canvas?.width > 0 &&
          visualTransition?.canvas?.height > 0;
        const outputWriterHealthy =
          outputWriter?.mode === "worker" &&
          outputWriter?.workerSupported === true &&
          outputWriter?.workerReady === true &&
          outputWriter?.workerHasVideoFrame === true &&
          outputWriter?.workerHasWritableStream === true &&
          outputWriter?.workerHasOffscreenCanvas === true &&
          ["direct-video-frame", "offscreen-canvas"].includes(
            outputWriter?.workerRenderer
          ) &&
          outputWriter?.workerFirstFrameSeen === true &&
          Number(outputWriter?.workerFramesSent || 0) >= 6 &&
          Number(outputWriter?.workerFramesWritten || 0) >= 6 &&
          Number(outputWriter?.workerFrameMetadataCount || 0) >= 6 &&
          Number(outputWriter?.workerWriteFailures || 0) === 0 &&
          Number(outputWriter?.workerPostFailures || 0) === 0 &&
          Number(outputWriter?.workerPendingFrameCount || 0) <= 1 &&
          Number(outputWriter?.latestWorkerWriteMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerAckSequence || 0) > 0 &&
          ["direct-video-frame", "offscreen-canvas"].includes(
            outputWriter?.latestWorkerFrameMetadata?.renderer
          ) &&
          Number(outputWriter?.latestWorkerFrameMetadata?.sequence || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.width || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.height || 0) > 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.writeMs ?? -1) >= 0 &&
          Number(outputWriter?.latestWorkerFrameMetadata?.backpressureMs ?? -1) >= 0;
        const faceProcessorHealthy =
          faceProcessor?.mode === "worker" &&
          faceProcessor?.workerSupported === true &&
          faceProcessor?.workerReady === true &&
          ["GPU", "CPU"].includes(faceProcessor?.workerDelegate) &&
          Number(faceProcessor?.workerFramesSent || 0) >= 1 &&
          Number(faceProcessor?.workerResults || 0) >= 1 &&
          Number(faceProcessor?.workerStaleResults ?? 0) >= 0 &&
          Number(faceProcessor?.workerFailures || 0) === 0 &&
          faceProcessor?.workerFirstResultSeen === true &&
          Number(faceProcessor?.latestWorkerSequence || 0) > 0 &&
          Number(faceProcessor?.latestWorkerAckSequence || 0) > 0 &&
          Number(faceProcessor?.latestWorkerProcessingMs ?? -1) >= 0 &&
          Number(faceProcessor?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          Number(faceProcessor?.latestWorkerResult?.sequence || 0) > 0 &&
          faceProcessor?.latestWorkerResult?.processingConfigId ===
            modelProcessingConfigId &&
          Number(faceProcessor?.latestWorkerResult?.width || 0) > 0 &&
          Number(faceProcessor?.latestWorkerResult?.height || 0) > 0 &&
          faceProcessor?.latestWorkerResult?.inputSource === "video-frame" &&
          (!${JSON.stringify(expectFaceLandmarks)} ||
            Number(faceProcessor?.latestWorkerResult?.landmarkCount || 0) > 0);
        const segmentationProcessorHealthy =
          segmentationProcessor?.mode === "worker" &&
          segmentationProcessor?.workerSupported === true &&
          segmentationProcessor?.workerReady === true &&
          ["GPU", "CPU"].includes(segmentationProcessor?.workerDelegate) &&
          Number(segmentationProcessor?.workerFramesSent || 0) >= 1 &&
          Number(segmentationProcessor?.workerResults || 0) >= 1 &&
          Number(segmentationProcessor?.workerStaleResults ?? 0) >= 0 &&
          Number(segmentationProcessor?.workerFailures || 0) === 0 &&
          segmentationProcessor?.workerFirstResultSeen === true &&
          Number(segmentationProcessor?.latestWorkerSequence || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerAckSequence || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerProcessingMs ?? -1) >= 0 &&
          Number(segmentationProcessor?.latestWorkerRoundTripMs ?? -1) >= 0 &&
          Number(segmentationProcessor?.latestWorkerResult?.sequence || 0) > 0 &&
          segmentationProcessor?.latestWorkerResult?.processingConfigId ===
            modelProcessingConfigId &&
          Number(segmentationProcessor?.latestWorkerResult?.width || 0) > 0 &&
          Number(segmentationProcessor?.latestWorkerResult?.height || 0) > 0 &&
          segmentationProcessor?.latestWorkerResult?.inputSource === "video-frame" &&
          ["tasks-confidence", "tasks-category"].includes(
            segmentationProcessor?.latestWorkerResult?.source
          ) &&
          Array.isArray(
            segmentationProcessor?.latestWorkerResult?.qualityScores
          ) &&
          Number(
            segmentationProcessor?.latestWorkerResult?.confidenceMaskCount ?? 0
          ) >= 0;
        const frameMetadataHealthy =
          frameMetadata?.type === "FRAME_METADATA" &&
          frameMetadata?.source === "client-video-effects" &&
          frameMetadata?.processingConfigId === framePipeline?.processingConfigId &&
          Number(frameMetadata?.sequence || 0) > 0 &&
          Number(frameMetadataDebug?.sequence || 0) >=
            Number(frameMetadata?.sequence || 0) &&
          Number(frameMetadata?.approximateTimestampMs ?? -1) >= 0 &&
          Number(frameMetadata?.exactTimestampMs ?? -1) >= 0 &&
          Number(frameMetadata?.frame?.width || 0) > 0 &&
          Number(frameMetadata?.frame?.height || 0) > 0 &&
          Number(frameMetadata?.frame?.frameSequence || 0) > 0 &&
          Number(frameMetadata?.roomTilingMetadata?.enabledFramesCount || 0) > 0 &&
          Number(frameMetadata?.roomTilingMetadata?.tileCount ?? -1) >= 0 &&
          typeof frameMetadata?.roomTilingMetadata?.tilesStable === "boolean" &&
          Number(frameMetadata?.roomTilingMetadata?.fallbackLevel ?? -1) >= 0 &&
          Number(frameMetadata?.humanTrackingMetadata?.lifetimeTrackCount ?? -1) >= 0 &&
          Number(frameMetadata?.humanTrackingMetadata?.activeTrackCount ?? -1) >= 0 &&
          Array.isArray(frameMetadata?.humanTrackingMetadata?.trackedHumans) &&
          frameMetadata?.continuousAutozoomMetadata?.enabled === false &&
          frameMetadata?.continuousAutozoomMetadata?.source === "off" &&
          Number(frameMetadata?.continuousAutozoomMetadata?.zoomFactor || 0) === 1 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.crop?.sw || 0) > 0 &&
          Number(frameMetadata?.continuousAutozoomMetadata?.targetCrop?.sw || 0) > 0 &&
          (!${JSON.stringify(expectFaceLandmarks)} ||
            (Number(frameMetadata?.humanTrackingMetadata?.activeTrackCount || 0) > 0 &&
              frameMetadata.humanTrackingMetadata.trackedHumans.some(
                (track) => track.source === "face"
              )));
        const outputHealthy = panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          Number(framePipeline?.processingConfigId || 0) >= 1 &&
          framePipeline?.outputReady === true &&
          framePipeline?.outputTrackPublished === true &&
          framePipeline?.lastFrame?.processingConfigId ===
            framePipeline.processingConfigId &&
          framePipeline?.lastFrame?.outputDelivered === true &&
          framePipeline?.lastFrame?.outputVisible === true &&
          backgroundRender?.background === "blur-strong" &&
          backgroundRender?.active === true &&
          Number(backgroundRender?.changedPixels || 0) > 0 &&
          stats?.needsFace === true &&
          faceRender?.filter === "sparkles" &&
          ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
          stats?.outputMode === "track-generator" &&
          transitionHealthy &&
          outputWriterHealthy &&
          segmentationProcessorHealthy &&
          faceProcessorHealthy &&
          frameMetadataHealthy &&
          adaptationHealthy;
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          faceRender?.drawn === true &&
          Number(faceRender?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_rapid_effect_switches");
    assertOutputWriterQuality(state, "rapid effect switches");
    await waitForMeetVideoPublish(
      cdp,
      "rapid switches producer uses processed output",
      "processed",
    );
    emit("rapid_effect_switch_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      backgroundRender: state.panelStats?.backgroundRender ?? null,
      faceFilterRender: state.panelStats?.faceFilterRender ?? null,
      visualTransition: state.panelStats?.visualTransition ?? null,
      framePipeline: state.panelStats?.framePipeline ?? null,
      frameMetadata:
        state.panelStats?.frameMetadata ??
        state.videoEffectsFrameMetadataDebug?.current ??
        null,
      frameMetadataDebug: state.videoEffectsFrameMetadataDebug ?? null,
      outputWriter: state.panelStats?.framePipeline?.outputWriter ?? null,
      segmentationProcessor:
        state.panelStats?.framePipeline?.segmentationProcessor ?? null,
      faceProcessor: state.panelStats?.framePipeline?.faceProcessor ?? null,
      faceDetection: state.panelStats?.faceDetection ?? null,
      intervals: state.panelStats?.intervals ?? null,
      adaptation: state.panelStats?.adaptation ?? null,
    });
    assertEffectSwitchLatencyQuality(
      cdp.logs,
      state,
      "rapid effect switches",
      { fromIndex: rapidEffectSwitchLogIndex },
    );
    if (!expectFaceLandmarks) {
      const faceNoResultBackoff = await waitFor(
        cdp,
        "face no-result cadence backoff",
        `(() => {
          const panel = document.querySelector('[data-testid="video-effects-panel"]');
          const raw = panel?.getAttribute("data-video-effects-stats");
          let panelStats = null;
          try { panelStats = raw ? JSON.parse(raw) : null; } catch {}
          const debug = typeof window.__conclaveGetMeetVideoDebug === "function"
            ? window.__conclaveGetMeetVideoDebug()
            : window.__conclaveMeetVideoDebug;
          const stats = panelStats?.faceDetection
            ? panelStats
            : debug?.videoEffectsDebugStats || panelStats;
          const faceDetection = stats?.faceDetection;
          const intervals = stats?.intervals;
          const adaptation = stats?.adaptation;
          return faceDetection?.noResultBackoffActive === true &&
            faceDetection?.noResultBackoffReason === "no-face-result" &&
            Number(faceDetection?.consecutiveNoResultCount || 0) >= 6 &&
            Number(faceDetection?.noResultBackoffIntervalMs || 0) >= 200 &&
            Number(intervals?.faceIntervalMs || 0) >= 200 &&
            Number(adaptation?.targetFaceIntervalMs || 0) >= 200
              ? {
                  ok: true,
                  faceDetection,
                  intervals,
                  adaptation: {
                    targetFaceIntervalMs: adaptation?.targetFaceIntervalMs ?? null,
                    qualityTier: adaptation?.qualityTier ?? null,
                    modelIntervalScale: adaptation?.modelIntervalScale ?? null,
                    policyReason: adaptation?.policyReason ?? null,
                  },
                  faceProcessor: stats?.framePipeline?.faceProcessor ?? null,
                }
              : false;
        })()`,
        15000,
      );
      emit("face_no_result_backoff_probe", faceNoResultBackoff);
      state = await collectState(cdp, "state_after_face_no_result_backoff");
    }

    await clickButton(cdp, "Active effects");
    await waitFor(
      cdp,
      "active effects stack contains blur and sparkles",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        if (!panel) return false;
        const stack = panel.querySelector("[data-video-effects-active-stack='true']");
        if (!stack) return false;
        const backgroundItem = stack.querySelector("[data-video-effects-active-item='background']");
        const filterItem = stack.querySelector("[data-video-effects-active-item='filter']");
        const removeBlur = Array.from(stack.querySelectorAll("button")).some(
          (button) => button.getAttribute("aria-label") === "Remove Blur"
        );
        const removeSparkles = Array.from(stack.querySelectorAll("button")).some(
          (button) => button.getAttribute("aria-label") === "Remove Sparkles"
        );
        return panel.getAttribute("data-video-effects-active-count") === "2" &&
          stack.getAttribute("data-video-effects-active-stack-open") === "true" &&
          Boolean(backgroundItem) &&
          Boolean(filterItem) &&
          removeBlur &&
          removeSparkles;
      })()`,
      10000,
    );
    await clickButton(cdp, "Remove Blur");
    await waitFor(
      cdp,
      "single active filter after removing background stack item",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        const stack = panel?.querySelector("[data-video-effects-active-stack='true']");
        const hasBackgroundItem = Boolean(stack?.querySelector("[data-video-effects-active-item='background']"));
        const hasFilterItem = Boolean(stack?.querySelector("[data-video-effects-active-item='filter']"));
        const faceRender = stats?.faceFilterRender;
        const outputHealthy = stored?.background === "none" &&
          stored?.filter === "sparkles" &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "1" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          hasFilterItem &&
          !hasBackgroundItem &&
          stats?.needsFace === true &&
          faceRender?.filter === "sparkles";
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          faceRender?.drawn === true &&
          Number(faceRender?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_active_stack_remove_background");
    await waitForMeetVideoPublish(
      cdp,
      "single filter producer uses processed output",
      "processed",
    );
    emit("active_stack_remove_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      background: state.panelStats?.backgroundRender?.background ?? null,
      faceFilterRender: state.panelStats?.faceFilterRender ?? null,
    });

    await clickButton(cdp, "Backgrounds");
    await clickButton(cdp, "Blur your background");
    await waitFor(
      cdp,
      "active effects restored after stack removal test",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        return stored?.background === "blur-strong" &&
          stored?.filter === "sparkles" &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "2" &&
          stats?.backgroundRender?.background === "blur-strong" &&
          stats?.faceFilterRender?.filter === "sparkles";
      })()`,
      30000,
    );

    await clickButton(cdp, "Appearance");
    await clickTestId(cdp, "video-effects-appearance-studio-look");
    await clickTestId(cdp, "video-effects-appearance-style-mono");
    await waitFor(
      cdp,
      "appearance effects output healthy",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        const switches = Array.from(panel?.querySelectorAll('[role="switch"]') ?? []);
        const touchUpSwitch = switches.find((button) =>
          (button.textContent || "").includes("Touch-up appearance")
        );
        const selected = Array.from(panel?.querySelectorAll("button") ?? []).some(
          (button) =>
            (button.textContent || "").replace(/\\s+/g, " ").trim().includes("Black and white") &&
            button.getAttribute("aria-pressed") === "true"
        );
        const effects = stats?.effects;
        return stored?.background === "blur-strong" &&
          stored?.filter === "sparkles" &&
          stored?.style === "mono" &&
          stored?.studioLook === true &&
          effects?.style === "mono" &&
          effects?.studioLook === true &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "4" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          touchUpSwitch?.getAttribute("aria-checked") === "true" &&
          selected &&
          stats?.needsFace === true &&
          ["video-frame", "track-processor"].includes(stats?.schedulerMode) &&
          stats?.outputMode === "track-generator";
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_appearance_effects");
    await waitForMeetVideoPublish(
      cdp,
      "appearance stack producer uses processed output",
      "processed",
    );
    emit("appearance_effects_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      effects: state.panelStats?.effects ?? null,
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
    });

    await waitFor(
      cdp,
      "stored video effects after rapid switches",
      `(() => {
        let stored = null;
        try {
          stored = JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
        } catch {}
        return stored?.background === "blur-strong" &&
          stored?.filter === "sparkles" &&
          stored?.style === "mono" &&
          stored?.studioLighting === false &&
          stored?.studioLook === true &&
          stored?.framing === false;
      })()`,
      10000,
    );

    await cdp.send("Page.reload", { ignoreCache: true });
    emit("page_reload", { url });
    await waitFor(
      cdp,
      "meeting surface after effects reload",
      `(() => {
        const hasGrid = Boolean(document.querySelector("[data-meet-view-layout]"));
        const hasEffectsButton = Array.from(document.querySelectorAll("button")).some(
          (button) => (button.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim() === "Backgrounds and effects"
        );
        return hasGrid || hasEffectsButton;
      })()`,
      30000,
    );
    await turnCameraOnIfNeeded(cdp, "camera on after effects reload");
    await openMeetingEffectsPanel(cdp, "restored effects panel after reload");
    await waitFor(
      cdp,
      "restored effects output after reload",
      `(() => {
        const panel = document.querySelector('[data-testid="video-effects-panel"]');
        const raw = panel?.getAttribute("data-video-effects-stats");
        let stats = null;
        try { stats = raw ? JSON.parse(raw) : null; } catch {}
        const backgroundRender = stats?.backgroundRender;
        const faceRender = stats?.faceFilterRender;
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:video-effects") || "null");
          } catch {
            return null;
          }
        })();
        const outputHealthy = stored?.background === "blur-strong" &&
          stored?.filter === "sparkles" &&
          stored?.style === "mono" &&
          stored?.studioLook === true &&
          stats?.effects?.style === "mono" &&
          stats?.effects?.studioLook === true &&
          panel?.getAttribute("data-video-effects-status") === "running" &&
          panel?.getAttribute("data-video-effects-active-count") === "4" &&
          panel?.getAttribute("data-video-effects-output-published") === "true" &&
          panel?.getAttribute("data-video-effects-preview-matches-output") === "true" &&
          Number(panel?.getAttribute("data-video-effects-black-output-count") || 1) === 0 &&
          backgroundRender?.background === "blur-strong" &&
          backgroundRender?.active === true &&
          Number(backgroundRender?.changedPixels || 0) > 0 &&
          stats?.needsFace === true &&
          faceRender?.filter === "sparkles";
        if (!${JSON.stringify(expectFaceLandmarks)}) return outputHealthy;
        return outputHealthy &&
          Number(stats?.faceLandmarkCount || 0) > 0 &&
          faceRender?.drawn === true &&
          Number(faceRender?.changedPixels || 0) > 0;
      })()`,
      30000,
    );
    state = await collectState(cdp, "state_after_reload_restored_effects");
    await waitForMeetVideoPublish(
      cdp,
      "reload restored producer uses processed output",
      "processed",
    );
    emit("restored_effects_probe", {
      status: state.panelAttrs?.["data-video-effects-status"],
      activeCount: state.panelAttrs?.["data-video-effects-active-count"],
      outputPublished: state.panelStats?.outputTrackPublished === true,
      previewMatchesOutput:
        state.panelAttrs?.["data-video-effects-preview-matches-output"] ===
        "true",
      blackOutputFrameCount: Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      ),
      backgroundRender: state.panelStats?.backgroundRender ?? null,
      faceFilterRender: state.panelStats?.faceFilterRender ?? null,
      faceLandmarkCount: Number(state.panelStats?.faceLandmarkCount ?? 0),
    });

    const assertEffectsProbeHealthy = (probeLabel) => {
      const badLogs = cdp.logs.filter((log) =>
        badLogPatterns.some((pattern) => pattern.test(log.text)),
      );
      emit("browser_logs", {
        count: cdp.logs.length,
        badLogs,
        recent: cdp.logs.slice(-40),
      });
      const prewarmDoneKinds = new Set(
        cdp.logs
          .filter((log) => /processor_worker_prewarm_done/.test(log.text))
          .map((log) => {
            const match = log.text.match(/"kind":"([^"]+)"/);
            return match?.[1] ?? null;
          })
          .filter(Boolean),
      );
      const prewarmSuppressedKinds = new Set(
        cdp.logs
          .filter((log) =>
            /processor_worker_prewarm_(?:suppressed|cancelled)_busy/.test(
              log.text,
            ),
          )
          .map((log) => {
            const match = log.text.match(/"kind":"([^"]+)"/);
            return match?.[1] ?? null;
          })
          .filter(Boolean),
      );
      const prewarmFailureLogs = cdp.logs.filter((log) =>
        /processor_worker_prewarm_failed|output_writer_worker_prewarm_failed/.test(
          log.text,
        ),
      );
      const outputWriterPrewarmDone = cdp.logs.some((log) =>
        /output_writer_worker_prewarm_done/.test(log.text),
      );
      const outputWriterPrewarmSuppressed = cdp.logs.some((log) =>
        /output_writer_worker_prewarm_suppressed_busy/.test(log.text),
      );
      const cameraLivePrewarmRequested = cdp.logs.some(
        (log) =>
          /prewarm_requested/.test(log.text) &&
          /"reason":"camera-live"/.test(log.text),
      );
      const cameraLivePrewarmDone = cdp.logs.some(
        (log) =>
          /prewarm_done/.test(log.text) &&
          /"reason":"camera-live"/.test(log.text),
      );
      const shellRuntimePrewarmRequested = cdp.logs.some(
        (log) =>
          /runtime_prewarm_requested/.test(log.text) &&
          /"reason":"meet-shell-runtime"/.test(log.text),
      );
      const shellRuntimePrewarmDone = cdp.logs.some(
        (log) =>
          /runtime_prewarm_done/.test(log.text) &&
          /"reason":"meet-shell-runtime"/.test(log.text),
      );
      const missingPrewarmKinds = ["segmentation", "face"].filter(
        (kind) =>
          !prewarmDoneKinds.has(kind) && !prewarmSuppressedKinds.has(kind),
      );
      const processorPrewarmFailed =
        missingPrewarmKinds.length > 0 ||
        (!outputWriterPrewarmDone && !outputWriterPrewarmSuppressed) ||
        prewarmFailureLogs.length > 0;
      emit("processor_worker_prewarm_probe", {
        label: probeLabel,
        ok: !processorPrewarmFailed,
        doneKinds: Array.from(prewarmDoneKinds),
        suppressedKinds: Array.from(prewarmSuppressedKinds),
        missingKinds: missingPrewarmKinds,
        outputWriterDone: outputWriterPrewarmDone,
        outputWriterSuppressed: outputWriterPrewarmSuppressed,
        failures: prewarmFailureLogs,
      });
      emit("camera_live_prewarm_probe", {
        label: probeLabel,
        ok: cameraLivePrewarmRequested && cameraLivePrewarmDone,
        requested: cameraLivePrewarmRequested,
        done: cameraLivePrewarmDone,
      });
      emit("meet_shell_runtime_prewarm_probe", {
        label: probeLabel,
        ok: shellRuntimePrewarmRequested && shellRuntimePrewarmDone,
        requested: shellRuntimePrewarmRequested,
        done: shellRuntimePrewarmDone,
      });

      const blackOutputCount = Number(
        state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
      );
      const faceProbeFailures = expectFaceLandmarks
        ? faceProbes.filter(
            (probe) =>
              probe.faceLandmarkCount <= 0 ||
              Number(probe.alignment?.filterLandmarkSmoothing?.alpha ?? 0) <
                0.7 ||
              Number(probe.alignment?.filterLandmarkSmoothing?.alpha ?? 0) <
                Number(probe.alignment?.landmarkSmoothing?.alpha ?? 0) ||
              Number(probe.alignment?.faceIntervalMs ?? 999) > 70 ||
              probe.previewMatchesOutput !== true ||
              probe.render?.filter !== probe.expectedFilterId ||
              probe.render?.drawn !== true ||
              Number(probe.render?.changedPixels || 0) <= 0,
          )
        : [];
      const backgroundProbeFailures = backgroundProbes.filter(
        (probe) =>
          probe.previewMatchesOutput !== true ||
          probe.render?.background !== probe.expectedBackgroundId ||
          probe.render?.active !== true ||
          Number(probe.render?.changedPixels || 0) <= 0 ||
          (probe.requiresBackgroundImage &&
            probe.render?.hasBackgroundImage !== true),
      );
      const sourceFrame = state.panelStats?.framePipeline?.sourceFrame ?? null;
      const darkVideoProbeFallbackFailed =
        forceDarkVideoProbe &&
        !(
          ["track-processor", "image-capture"].includes(sourceFrame?.selection) &&
          sourceFrame?.fallbackReason === "dark-video" &&
          Number(sourceFrame?.blackSourceVideoFrameCount || 0) > 0 &&
          Number(sourceFrame?.fallbackCount || 0) > 0
        );
      const effectSwitchLatencyQuality = getEffectSwitchLatencyQuality(
        cdp.logs,
        state,
        probeLabel,
        { fromIndex: rapidEffectSwitchLogIndex },
      );
      emit("effect_switch_latency_quality_probe", effectSwitchLatencyQuality);
      if (
        state.panelAttrs?.["data-video-effects-output-published"] !== "true" ||
        state.panelAttrs?.["data-video-effects-status"] !== "running" ||
        blackOutputCount !== 0 ||
        faceProbeFailures.length > 0 ||
        backgroundProbeFailures.length > 0 ||
        darkVideoProbeFallbackFailed ||
        processorPrewarmFailed ||
        !cameraToggleLivePrewarmRequested ||
        !cameraToggleLivePrewarmDone ||
        !cameraLivePrewarmRequested ||
        !cameraLivePrewarmDone ||
        !shellRuntimePrewarmRequested ||
        !shellRuntimePrewarmDone ||
        !effectSwitchLatencyQuality.ok ||
        badLogs.length > 0
      ) {
        throw new Error(
          `Video effects headless regression failed: ${JSON.stringify({
            probe: probeLabel,
            faceProbeFailures,
            backgroundProbeFailures,
            darkVideoProbeFallbackFailed,
            processorPrewarmFailed,
            missingPrewarmKinds,
            prewarmFailureLogs,
            cameraToggleLivePrewarmRequested,
            cameraToggleLivePrewarmDone,
            cameraLivePrewarmRequested,
            cameraLivePrewarmDone,
            shellRuntimePrewarmRequested,
            shellRuntimePrewarmDone,
            effectSwitchLatencyQuality,
            sourceFrame,
            badLogs,
            blackOutputCount,
          })}`,
        );
      }
    };

    if (headlessProbe === "effects") {
      assertEffectsProbeHealthy(headlessProbe);
      emit("result", { ok: true, probe: headlessProbe });
      return;
    }

    await clickButton(cdp, "Close backgrounds and effects");
    await clickButton(cdp, "Dev Tools");
    await setRangeValue(cdp, '[data-testid="dev-spawn-count"]', 8);
    await setRangeValue(cdp, '[data-testid="dev-spawn-delay"]', 25);
    await clickButton(cdp, "Spawn");
    await waitFor(
      cdp,
      "dev participants joined",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const bots = typeof window.__conclaveGetDevHeadlessBots === "function"
          ? window.__conclaveGetDevHeadlessBots()
          : [];
        return Number(grid?.getAttribute("data-meet-view-ordered-count") || 0) >= 8 &&
          bots.length >= 8 &&
          bots.every((bot) => bot.connected === true);
      })()`,
      20000,
    );
    await waitFor(
      cdp,
      "auto dynamic cropped tile videos",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const videos = Array.from(document.querySelectorAll(".acm-video-tile video[data-meet-tile-video='true']"))
          .filter((video) => {
            const rect = video.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8 && getComputedStyle(video).display !== "none";
          });
        let roomTilingScores = [];
        try {
          roomTilingScores = JSON.parse(grid?.getAttribute("data-meet-room-tiling-scores") || "[]");
        } catch {}
        const roomTilingVisibleIds = (grid?.getAttribute("data-meet-room-tiling-visible-ids") || "")
          .split(",")
          .filter(Boolean);
        const roomTilingPrimaryIds = (grid?.getAttribute("data-meet-room-tiling-primary-ids") || "")
          .split(",")
          .filter(Boolean);
        const roomTilingFeaturedSpeaker =
          grid?.getAttribute("data-meet-room-tiling-featured-speaker") || "";
        const roomTilingDebug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
          ? window.__conclaveGetMeetRoomTilingDebug()
          : null;
        const currentTiling = roomTilingDebug?.current;
        const localToggle = document.querySelector("[data-meet-tile-crop-toggle='local']");
        const localTile = localToggle?.closest(".acm-video-tile");
        const localVideo = localTile?.querySelector("video[data-meet-tile-video='true']");
        const localCropPosition = grid?.getAttribute("data-meet-view-local-crop-position") || "";
        const localTrackingHealthy = !${JSON.stringify(expectFaceLandmarks)} || (
          grid?.getAttribute("data-meet-view-local-tracking") === "true" &&
          grid?.getAttribute("data-meet-view-local-tracking-source") === "face" &&
          localCropPosition.length > 0 &&
          localVideo?.getAttribute("data-meet-local-tracking") === "true" &&
          localVideo?.getAttribute("data-meet-local-tracking-source") === "face" &&
          localVideo?.getAttribute("data-meet-local-crop-position") === localCropPosition &&
          currentTiling?.localVideo?.active === true &&
          currentTiling?.localVideo?.source === "face" &&
          Number(currentTiling?.localVideo?.trackCount || 0) >= 1 &&
          Number(currentTiling?.localVideo?.metadataSequence || 0) > 0 &&
          currentTiling?.localVideo?.objectPosition === localCropPosition &&
          currentTiling?.localVideo?.primaryTrack?.source === "face" &&
          Number(currentTiling?.localVideo?.primaryTrack?.coverage || 0) > 0
        );
        return grid?.getAttribute("data-meet-view-requested") === "auto" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-dynamic-crop") === "true" &&
          grid?.getAttribute("data-meet-view-grid-video-fit") === "cover" &&
          grid?.getAttribute("data-meet-room-tiling-source") === "client" &&
          grid?.getAttribute("data-meet-room-tiling-metadata-interval") === "200" &&
          grid?.getAttribute("data-meet-room-tiling-promote-delay") === "220" &&
          grid?.getAttribute("data-meet-room-tiling-min-switch-interval") === "2200" &&
          Number(grid?.getAttribute("data-meet-room-tiling-fallback-level") ?? -1) >= 0 &&
          roomTilingVisibleIds.length >= 3 &&
          roomTilingPrimaryIds.includes("local") &&
          roomTilingScores.length >= 3 &&
          roomTilingScores.every((item, index) =>
            typeof item.id === "string" &&
            item.rank === index &&
            typeof item.score === "number" &&
            typeof item.featured === "boolean" &&
            item.visible === true &&
            item.hidden === false
          ) &&
          roomTilingDebug?.intervalMs === 200 &&
          roomTilingDebug?.sequence >= 1 &&
          roomTilingDebug?.history?.length >= 1 &&
          currentTiling?.source === "client" &&
          currentTiling?.intervalMs === 200 &&
          currentTiling?.promoteDelayMs === 220 &&
          currentTiling?.minSwitchIntervalMs === 2200 &&
          Number(currentTiling?.fallbackLevel ?? -1) >= 0 &&
          (currentTiling?.featuredSpeakerId ?? "") === roomTilingFeaturedSpeaker &&
          currentTiling?.requestedMode === "auto" &&
          currentTiling?.renderedMode === "tiled" &&
          currentTiling?.dynamicCrop === true &&
          currentTiling?.primaryIds?.includes("local") &&
          currentTiling?.visibleRemoteIds?.length >= 3 &&
          currentTiling?.scores?.length >= 3 &&
          currentTiling?.scores?.every((item, index) =>
            typeof item.id === "string" &&
            item.rank === index &&
            typeof item.score === "number" &&
            typeof item.featured === "boolean" &&
            item.visible === true &&
            item.hidden === false
          ) &&
          currentTiling?.counts?.orderedRemote >= 3 &&
          currentTiling?.stage?.mainKind === "none" &&
          currentTiling?.stage?.candidateMainKind === "remote" &&
          currentTiling?.layout?.gridVideoFit === "cover" &&
          currentTiling?.signature?.length > 20 &&
          localTrackingHealthy &&
          videos.length >= 1 &&
          videos.every((video) => video.getAttribute("data-video-object-fit") === "cover");
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_dev_spawn");

    const roomTilingHeartbeatStart = await evalValue(
      cdp,
      `(() => {
        const debug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
          ? window.__conclaveGetMeetRoomTilingDebug()
          : null;
        return {
          sequence: Number(debug?.sequence || 0),
          signature: debug?.current?.signature || null,
        };
      })()`,
    );
    const roomTilingHeartbeatProbe = await waitFor(
      cdp,
      "room tiling metadata heartbeat",
      `(() => {
        const debug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
          ? window.__conclaveGetMeetRoomTilingDebug()
          : null;
        const current = debug?.current;
        const history = Array.isArray(debug?.history) ? debug.history : [];
        const recent = history.slice(-6);
        const hasStableSignatureHeartbeat = recent.some((item, index) => {
          if (index === 0) return false;
          const previous = recent[index - 1];
          return Boolean(
            item?.signature &&
            item.signature === previous?.signature &&
            Number(item.sequence || 0) === Number(previous?.sequence || 0) + 1
          );
        });
        const ageMs = current
          ? Math.max(0, performance.now() - Number(current.performanceTime || 0))
          : null;
        const sequence = Number(debug?.sequence || 0);
        const startSequence = ${JSON.stringify(roomTilingHeartbeatStart.sequence)};
        const ok =
          sequence >= startSequence + 2 &&
          hasStableSignatureHeartbeat &&
          ageMs !== null &&
          ageMs < 600 &&
          current?.intervalMs === 200;
        return ok ? {
          ok,
          startSequence,
          sequence,
          ageMs,
          historyLength: history.length,
          stableSignatureHeartbeat: hasStableSignatureHeartbeat,
          intervalMs: current?.intervalMs ?? null,
          currentSignature: current?.signature ?? null,
          startSignature: ${JSON.stringify(roomTilingHeartbeatStart.signature)},
        } : false;
      })()`,
      4000,
    );
    emit("room_tiling_heartbeat_probe", roomTilingHeartbeatProbe);

    const roomTilingAdaptation = await waitFor(
      cdp,
      "effects room tiling pressure adaptation",
      `(() => {
        const statsByInstance = window.__conclaveVideoEffectsStats || {};
        const stats = Object.values(statsByInstance)
          .filter((item) => item?.effects?.active === true && item?.adaptation)
          .sort((left, right) =>
            Number(left?.framePipeline?.frameSequence || 0) -
            Number(right?.framePipeline?.frameSequence || 0)
          )
          .at(-1);
        const adaptation = stats?.adaptation;
        const lastFrame = stats?.framePipeline?.lastFrame;
        const outputWriter = stats?.framePipeline?.outputWriter;
        const room = adaptation?.roomTiling;
        const policyReason = String(adaptation?.policyReason || "");
        const runtimePressureReason = String(
          adaptation?.lastRuntimePressureReason || ""
        );
        const qualityTier = Number(adaptation?.qualityTier || 0);
        const oldestPendingFrameAgeMs = Number(
          outputWriter?.workerOldestPendingFrameAgeMs ?? 0
        );
        const runtimePressureHealthy =
          Number(adaptation?.runtimePressureMs) >= 0 &&
          Number(adaptation?.lastRuntimePressureMs) >= 0 &&
          (
            adaptation?.lastRuntimePressureReason === null ||
            typeof adaptation?.lastRuntimePressureReason === "string"
          );
        const pendingWriterPressureHealthy =
          !runtimePressureReason.includes("pending-limit") &&
          (
            !runtimePressureReason.includes("stale-pending") ||
            oldestPendingFrameAgeMs >= ${maxNormalOutputWriterPendingAgeMs}
          );
        const stableOutputSurface =
          Number(lastFrame?.outputWidth || 0) === ${expectedStableOutputWidth} &&
          Number(lastFrame?.outputHeight || 0) === ${expectedStableOutputHeight} &&
          Math.abs(Number(lastFrame?.outputScale || 0) - ${expectedStableOutputScale}) <= 0.01;
        const ok = Boolean(
          room &&
          Number(room.totalGridCount || 0) >= 4 &&
          Number(room.tileWidth || 0) > 0 &&
          Number(room.tileHeight || 0) > 0 &&
          Number(room.fallbackLevel ?? -1) >= 0 &&
          policyReason.includes("room-tiling") &&
          (qualityTier === 1000 || qualityTier === 1100) &&
          runtimePressureHealthy &&
          pendingWriterPressureHealthy &&
          stableOutputSurface
        );
        return ok ? {
          ok,
          policyReason,
          qualityTier,
          adaptationTier: adaptation?.adaptationTier ?? null,
          modelInputScale: adaptation?.modelInputScale ?? null,
          modelIntervalScale: adaptation?.modelIntervalScale ?? null,
          outputScale: adaptation?.outputScale ?? null,
          runtimePressure: {
            runtimePressureMs: adaptation?.runtimePressureMs ?? null,
            lastRuntimePressureMs: adaptation?.lastRuntimePressureMs ?? null,
            lastRuntimePressureReason:
              adaptation?.lastRuntimePressureReason ?? null,
          },
          outputWriterPressure: {
            pendingWriterPressureHealthy,
            pendingCount: outputWriter?.workerPendingFrameCount ?? null,
            pendingLimit: outputWriter?.workerPendingFrameLimit ?? null,
            oldestPendingFrameAgeMs:
              outputWriter?.workerOldestPendingFrameAgeMs ?? null,
          },
          stableOutputSurface,
          outputSurface: {
            expectedWidth: ${expectedStableOutputWidth},
            expectedHeight: ${expectedStableOutputHeight},
            expectedScale: ${expectedStableOutputScale},
            width: lastFrame?.outputWidth ?? null,
            height: lastFrame?.outputHeight ?? null,
            scale: lastFrame?.outputScale ?? null,
          },
          room,
        } : false;
      })()`,
      15000,
    );
    emit("effects_room_tiling_adaptation_probe", roomTilingAdaptation);

    await clickButton(cdp, "Show the full video");
    await waitFor(
      cdp,
      "auto dynamic show full video override",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const toggle = document.querySelector("[data-meet-tile-crop-toggle='local']");
        const localTile = toggle?.closest(".acm-video-tile");
        const localVideo = localTile?.querySelector("video[data-meet-tile-video='true']");
        return grid?.getAttribute("data-meet-view-requested") === "auto" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-dynamic-crop") === "true" &&
          grid?.getAttribute("data-meet-view-full-video-tiles")?.split(",").includes("local") &&
          toggle?.getAttribute("data-meet-tile-crop-state") === "full" &&
          localVideo?.getAttribute("data-meet-local-tracking") ===
            (${JSON.stringify(expectFaceLandmarks)} ? "true" : localVideo?.getAttribute("data-meet-local-tracking")) &&
          localVideo?.getAttribute("data-meet-local-crop-position") === "" &&
          localVideo?.getAttribute("data-video-object-fit") === "contain";
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_show_full_video");

    await clickButton(cdp, "Crop this video");
    await waitFor(
      cdp,
      "auto dynamic crop video restored",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const toggle = document.querySelector("[data-meet-tile-crop-toggle='local']");
        const localTile = toggle?.closest(".acm-video-tile");
        const localVideo = localTile?.querySelector("video[data-meet-tile-video='true']");
        return grid?.getAttribute("data-meet-view-requested") === "auto" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-dynamic-crop") === "true" &&
          !grid?.getAttribute("data-meet-view-full-video-tiles")?.split(",").includes("local") &&
          toggle?.getAttribute("data-meet-tile-crop-state") === "cropped" &&
          (!${JSON.stringify(expectFaceLandmarks)} ||
            (grid?.getAttribute("data-meet-view-local-tracking") === "true" &&
              grid?.getAttribute("data-meet-view-local-tracking-source") === "face" &&
              (grid?.getAttribute("data-meet-view-local-crop-position") || "").length > 0 &&
              localVideo?.getAttribute("data-meet-local-crop-position") ===
                grid?.getAttribute("data-meet-view-local-crop-position"))) &&
          localVideo?.getAttribute("data-video-object-fit") === "cover";
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_crop_video_restored");

    await clickButton(cdp, "More options");
    await clickButton(cdp, "Adjust view");
    await waitFor(
      cdp,
      "adjust view panel",
      `Boolean(document.querySelector('[aria-label="Adjust view"]'))`,
      10000,
    );
    await setRangeValue(cdp, "#meet-max-tiles", 49);
    await waitFor(
      cdp,
      "auto measured tile limit caps oversized page",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const requestedMaxTiles = Number(grid?.getAttribute("data-meet-view-requested-max-tiles") || 0);
        const maxTiles = Number(grid?.getAttribute("data-meet-view-max-tiles") || 0);
        const autoTileLimit = Number(grid?.getAttribute("data-meet-view-auto-tile-limit") || 0);
        const gridSize = grid?.getAttribute("data-meet-view-grid-size") || "0x0";
        return grid?.getAttribute("data-meet-view-requested") === "auto" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-auto-tile-limit-active") === "true" &&
          requestedMaxTiles === 49 &&
          autoTileLimit === maxTiles &&
          maxTiles >= 2 &&
          maxTiles < requestedMaxTiles &&
          !gridSize.startsWith("0x");
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_auto_tile_limit");

    await clickButton(cdp, "Floating");
    await waitFor(
      cdp,
      "floating self-view layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        const minimizedSelfView = document.querySelector("[data-meet-minimized-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "floating" &&
          grid?.getAttribute("data-meet-view-self-view-requested") === "floating" &&
          grid?.getAttribute("data-meet-view-self-view-effective") === "floating" &&
          grid?.getAttribute("data-meet-view-self-view-placement") === "floating" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "bottom-right" &&
          grid?.getAttribute("data-meet-view-self-view-tile") === "false" &&
          grid?.getAttribute("data-meet-view-floating-self-view") === "true" &&
          grid?.getAttribute("data-meet-view-minimized-self-view") === "false" &&
          floatingSelfView?.getAttribute("data-meet-self-view-corner") === "bottom-right" &&
          Boolean(floatingSelfView) &&
          !minimizedSelfView;
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_floating");

    await dragButtonToCorner(cdp, "Move self-view", "top-left");
    await waitFor(
      cdp,
      "floating self-view dragged to top-left",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "floating" &&
          stored?.selfViewCorner === "top-left" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "top-left" &&
          floatingSelfView?.getAttribute("data-meet-self-view-corner") === "top-left" &&
          floatingSelfView?.getAttribute("data-meet-self-view-dragging") === "false";
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_floating_dragged");

    await clickButton(cdp, "Minimize self-view");
    await waitFor(
      cdp,
      "minimized self-view layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        const minimizedSelfView = document.querySelector("[data-meet-minimized-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "minimized" &&
          stored?.selfViewCorner === "top-left" &&
          grid?.getAttribute("data-meet-view-self-view-requested") === "minimized" &&
          grid?.getAttribute("data-meet-view-self-view-effective") === "minimized" &&
          grid?.getAttribute("data-meet-view-self-view-placement") === "minimized" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "top-left" &&
          grid?.getAttribute("data-meet-view-self-view-tile") === "false" &&
          grid?.getAttribute("data-meet-view-floating-self-view") === "false" &&
          grid?.getAttribute("data-meet-view-minimized-self-view") === "true" &&
          !floatingSelfView &&
          minimizedSelfView?.getAttribute("data-meet-self-view-corner") === "top-left";
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_minimized");

    await dragButtonToCorner(cdp, "Move minimized self-view", "bottom-left");
    await waitFor(
      cdp,
      "minimized self-view dragged to bottom-left",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const minimizedSelfView = document.querySelector("[data-meet-minimized-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "minimized" &&
          stored?.selfViewCorner === "bottom-left" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "bottom-left" &&
          minimizedSelfView?.getAttribute("data-meet-self-view-corner") === "bottom-left" &&
          minimizedSelfView?.getAttribute("data-meet-self-view-dragging") === "false";
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_minimized_dragged");

    await clickButton(cdp, "Restore self-view");
    await waitFor(
      cdp,
      "restored floating self-view from minimized",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        const minimizedSelfView = document.querySelector("[data-meet-minimized-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "floating" &&
          stored?.selfViewCorner === "bottom-left" &&
          grid?.getAttribute("data-meet-view-self-view-placement") === "floating" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "bottom-left" &&
          floatingSelfView?.getAttribute("data-meet-self-view-corner") === "bottom-left" &&
          !minimizedSelfView;
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_restored");

    await clickButton(cdp, "In a tile");
    await waitFor(
      cdp,
      "tile self-view layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        const minimizedSelfView = document.querySelector("[data-meet-minimized-self-view]");
        const stored = (() => {
          try {
            return JSON.parse(localStorage.getItem("conclave:meet-view") || "null");
          } catch {
            return null;
          }
        })();
        return stored?.selfViewMode === "tile" &&
          stored?.selfViewCorner === "bottom-left" &&
          grid?.getAttribute("data-meet-view-self-view-requested") === "tile" &&
          grid?.getAttribute("data-meet-view-self-view-effective") === "tile" &&
          grid?.getAttribute("data-meet-view-self-view-placement") === "tile" &&
          grid?.getAttribute("data-meet-view-self-view-corner") === "bottom-left" &&
          grid?.getAttribute("data-meet-view-self-view-tile") === "true" &&
          grid?.getAttribute("data-meet-view-floating-self-view") === "false" &&
          grid?.getAttribute("data-meet-view-minimized-self-view") === "false" &&
          !floatingSelfView &&
          !minimizedSelfView &&
          Boolean(document.querySelector("[data-meet-tile-crop-toggle='local']"));
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_self_view_tile");

    await clickButton(cdp, "Auto");
    await clickTestId(cdp, "presentation-diagnostic-toggle");
    await waitFor(
      cdp,
      "presentation auto stage layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const diagnostic = document.querySelector("[data-testid='presentation-diagnostic']");
        const stageMain = document.querySelector("[data-meet-stage-main='__presentation__']");
        const presentationVideo = stageMain?.querySelector("video[data-meet-presentation-video='true']");
        const rect = presentationVideo?.getBoundingClientRect();
        const stream = presentationVideo?.srcObject;
        const tracks = stream && typeof stream.getTracks === "function"
          ? stream.getTracks()
          : [];
        return diagnostic?.getAttribute("data-presentation-diagnostic-enabled") === "true" &&
          grid?.getAttribute("data-meet-view-requested") === "auto" &&
          grid?.getAttribute("data-meet-view-presenting") === "true" &&
          grid?.getAttribute("data-meet-view-stage-main-kind") === "presentation" &&
          (grid?.getAttribute("data-meet-view-layout") === "spotlight" ||
            grid?.getAttribute("data-meet-view-layout") === "sideBySide") &&
          Boolean(stageMain) &&
          Boolean(presentationVideo) &&
          presentationVideo.readyState >= 2 &&
          rect?.width > 120 &&
          rect?.height > 80 &&
          tracks.some((track) => track.kind === "video" && track.readyState === "live");
      })()`,
      15000,
    );
    await collectLayoutState(cdp, "layout_after_presentation_auto");

    await clickButton(cdp, "Sidebar");
    await waitFor(
      cdp,
      "presentation sidebar layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const stageMain = document.querySelector("[data-meet-stage-main='__presentation__']");
        const presentationVideo = stageMain?.querySelector("video[data-meet-presentation-video='true']");
        const railCount = Number(grid?.getAttribute("data-meet-view-stage-rail-count") || 0);
        const railCapacity = Number(grid?.getAttribute("data-meet-view-stage-rail-capacity") || 0);
        const railRemoteCapacity = Number(grid?.getAttribute("data-meet-view-stage-rail-remote-capacity") || 0);
        const railFixedCount = Number(grid?.getAttribute("data-meet-view-stage-rail-fixed-count") || 0);
        const railOverflow = grid?.getAttribute("data-meet-view-stage-rail-overflow") === "true";
        return grid?.getAttribute("data-meet-view-requested") === "sidebar" &&
          grid?.getAttribute("data-meet-view-layout") === "sidebar" &&
          grid?.getAttribute("data-meet-view-presenting") === "true" &&
          grid?.getAttribute("data-meet-view-stage-main-kind") === "presentation" &&
          railCount >= 1 &&
          railCapacity >= railCount &&
          railRemoteCapacity >= 1 &&
          railRemoteCapacity <= railCapacity &&
          railCount === railFixedCount + railRemoteCapacity + (railOverflow ? 1 : 0) &&
          Boolean(stageMain) &&
          Boolean(presentationVideo) &&
          presentationVideo.readyState >= 2;
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_presentation_sidebar");

    await clickButton(cdp, "Spotlight");
    await waitFor(
      cdp,
      "presentation spotlight layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const stageMain = document.querySelector("[data-meet-stage-main='__presentation__']");
        const presentationVideo = stageMain?.querySelector("video[data-meet-presentation-video='true']");
        return grid?.getAttribute("data-meet-view-requested") === "spotlight" &&
          grid?.getAttribute("data-meet-view-layout") === "spotlight" &&
          grid?.getAttribute("data-meet-view-presenting") === "true" &&
          grid?.getAttribute("data-meet-view-stage-main-kind") === "presentation" &&
          grid?.getAttribute("data-meet-view-stage-rail-count") === "0" &&
          grid?.getAttribute("data-meet-view-overflow-tile") === "false" &&
          Boolean(stageMain) &&
          Boolean(presentationVideo) &&
          presentationVideo.readyState >= 2;
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_presentation_spotlight");

    await clickTestId(cdp, "presentation-diagnostic-toggle");
    await waitFor(
      cdp,
      "presentation fixture stopped",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const diagnostic = document.querySelector("[data-testid='presentation-diagnostic']");
        return diagnostic?.getAttribute("data-presentation-diagnostic-enabled") === "false" &&
          grid?.getAttribute("data-meet-view-presenting") === "false";
      })()`,
      10000,
    );

    await clickButton(cdp, "Tiled");
    await waitFor(
      cdp,
      "tiled legacy contained tile videos",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const videos = Array.from(document.querySelectorAll(".acm-video-tile video[data-meet-tile-video='true']"))
          .filter((video) => {
            const rect = video.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8 && getComputedStyle(video).display !== "none";
          });
        return grid?.getAttribute("data-meet-view-requested") === "tiled" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-dynamic-crop") === "false" &&
          grid?.getAttribute("data-meet-view-grid-video-fit") === "contain" &&
          videos.length >= 1 &&
          videos.every((video) => video.getAttribute("data-video-object-fit") === "contain");
      })()`,
      10000,
    );
    await setRangeValue(cdp, "#meet-max-tiles", 2);
    await waitFor(
      cdp,
      "tiled overflow layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        let roomTilingScores = [];
        try {
          roomTilingScores = JSON.parse(grid?.getAttribute("data-meet-room-tiling-scores") || "[]");
        } catch {}
        let warmReasons = {};
        try {
          warmReasons = JSON.parse(grid?.getAttribute("data-meet-room-tiling-warm-reasons") || "{}");
        } catch {}
        const hiddenIds = (grid?.getAttribute("data-meet-room-tiling-hidden-ids") || "")
          .split(",")
          .filter(Boolean);
        const warmIds = (grid?.getAttribute("data-meet-room-tiling-warm-ids") || "")
          .split(",")
          .filter(Boolean);
        const warmHold = Number(grid?.getAttribute("data-meet-room-tiling-warm-hold") || 0);
        const warmReasonLists = Object.values(warmReasons).filter(Array.isArray);
        const hasBoundaryWarmReason = warmReasonLists.some((reasons) => reasons.includes("boundary"));
        const hasRecentlyVisibleWarmReason = warmReasonLists.some((reasons) => reasons.includes("recently-visible"));
        const roomTilingDebug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
          ? window.__conclaveGetMeetRoomTilingDebug()
          : null;
        const currentTiling = roomTilingDebug?.current;
        return grid?.getAttribute("data-meet-view-requested") === "tiled" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled" &&
          grid?.getAttribute("data-meet-view-overflow-tile") === "true" &&
          warmHold === 3500 &&
          Number(grid?.getAttribute("data-meet-view-hidden-count") || 0) >= 1 &&
          hiddenIds.length >= 1 &&
          warmIds.length >= 1 &&
          warmIds.every((id) => hiddenIds.includes(id)) &&
          hasBoundaryWarmReason &&
          hasRecentlyVisibleWarmReason &&
          currentTiling?.requestedMode === "tiled" &&
          currentTiling?.renderedMode === "tiled" &&
          Number(currentTiling?.counts?.recentlyVisibleWarm || 0) >= 1 &&
          roomTilingScores.some((item) =>
            hiddenIds.includes(item.id) &&
            item.hidden === true &&
            item.warm === true &&
            Array.isArray(item.warmReasons) &&
            item.warmReasons.includes("recently-visible")
          );
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_tiled_overflow");

    const devRaiseHandResult = await evalValue(
      cdp,
      `window.__conclaveSetDevHeadlessBotHandRaised?.(-1, true) ?? { success: false, error: "dev helper missing" }`,
    );
    emit("dev_headless_raise_hand_result", devRaiseHandResult);
    if (!devRaiseHandResult?.success) {
      throw new Error(
        `Failed to raise dev bot hand: ${JSON.stringify(devRaiseHandResult)}`,
      );
    }

    const raisedHandWarmProbe = await waitFor(
      cdp,
      "hidden hand-raised participant warmed",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const bots = typeof window.__conclaveGetDevHeadlessBots === "function"
          ? window.__conclaveGetDevHeadlessBots()
          : [];
        const raisedBot = bots.find((bot) => bot.raised === true);
        const raisedParticipantId = raisedBot?.participantId || raisedBot?.id || "";
        if (!grid || !raisedBot || !raisedParticipantId) return false;
        let warmReasons = {};
        let scores = [];
        try {
          warmReasons = JSON.parse(grid.getAttribute("data-meet-room-tiling-warm-reasons") || "{}");
          scores = JSON.parse(grid.getAttribute("data-meet-room-tiling-scores") || "[]");
        } catch {}
        const hiddenIds = (grid.getAttribute("data-meet-room-tiling-hidden-ids") || "")
          .split(",")
          .filter(Boolean);
        const warmIds = (grid.getAttribute("data-meet-room-tiling-warm-ids") || "")
          .split(",")
          .filter(Boolean);
        const roomTilingDebug = typeof window.__conclaveGetMeetRoomTilingDebug === "function"
          ? window.__conclaveGetMeetRoomTilingDebug()
          : null;
        const currentTiling = roomTilingDebug?.current;
        const attrReasons = Array.isArray(warmReasons[raisedParticipantId])
          ? warmReasons[raisedParticipantId]
          : [];
        const metadataReasons = Array.isArray(
          currentTiling?.warmReasons?.[raisedParticipantId],
        )
          ? currentTiling.warmReasons[raisedParticipantId]
          : [];
        const attrScore = scores.find((item) => item.id === raisedParticipantId);
        const metadataScore = currentTiling?.scores?.find?.(
          (item) => item.id === raisedParticipantId,
        );
        const orderedIndex = currentTiling?.orderedRemoteIds?.indexOf?.(
          raisedParticipantId,
        );
        const ok = hiddenIds.includes(raisedParticipantId) &&
          warmIds.includes(raisedParticipantId) &&
          attrReasons.includes("hand-raised") &&
          metadataReasons.includes("hand-raised") &&
          attrScore?.raised === true &&
          attrScore?.hidden === true &&
          attrScore?.warm === true &&
          attrScore?.warmReasons?.includes("hand-raised") &&
          metadataScore?.raised === true &&
          metadataScore?.hidden === true &&
          metadataScore?.warm === true &&
          metadataScore?.warmReasons?.includes("hand-raised") &&
          Number(currentTiling?.counts?.priorityWarm || 0) >= 1 &&
          Number(currentTiling?.counts?.handRaisedWarm || 0) >= 1 &&
          orderedIndex === 0;
        return ok ? {
          ok,
          raisedBot,
          raisedParticipantId,
          hiddenIds,
          warmIds,
          attrReasons,
          metadataReasons,
          attrScore,
          metadataScore,
          orderedIndex,
          counts: currentTiling?.counts ?? null,
        } : false;
      })()`,
      10000,
    );
    emit("room_tiling_hidden_hand_raised_warm_probe", raisedHandWarmProbe);

    await clickButton(cdp, "Sidebar");
    await waitFor(
      cdp,
      "sidebar layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const railCount = Number(grid?.getAttribute("data-meet-view-stage-rail-count") || 0);
        const railCapacity = Number(grid?.getAttribute("data-meet-view-stage-rail-capacity") || 0);
        const railRemoteCapacity = Number(grid?.getAttribute("data-meet-view-stage-rail-remote-capacity") || 0);
        const railFixedCount = Number(grid?.getAttribute("data-meet-view-stage-rail-fixed-count") || 0);
        const railOverflow = grid?.getAttribute("data-meet-view-stage-rail-overflow") === "true";
        return grid?.getAttribute("data-meet-view-requested") === "sidebar" &&
          grid?.getAttribute("data-meet-view-layout") === "sidebar" &&
          grid?.getAttribute("data-meet-view-stage-main-kind") !== "none" &&
          railCount >= 1 &&
          railCapacity >= railCount &&
          railRemoteCapacity >= 0 &&
          railRemoteCapacity <= railCapacity &&
          railCount === railFixedCount + railRemoteCapacity + (railOverflow ? 1 : 0);
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_sidebar");

    await clickButton(cdp, "Spotlight");
    await waitFor(
      cdp,
      "spotlight layout",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        const stageMain = document.querySelector("[data-meet-stage-main]");
        const floatingSelfView = document.querySelector("[data-meet-floating-self-view]");
        return grid?.getAttribute("data-meet-view-requested") === "spotlight" &&
          grid?.getAttribute("data-meet-view-layout") === "spotlight" &&
          grid?.getAttribute("data-meet-view-effective") === "spotlight" &&
          grid?.getAttribute("data-meet-view-stage-main-kind") !== "none" &&
          grid?.getAttribute("data-meet-view-stage-rail-count") === "0" &&
          grid?.getAttribute("data-meet-view-overflow-tile") === "false" &&
          Boolean(stageMain) &&
          Boolean(floatingSelfView);
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_spotlight");

    await clickButton(cdp, "Tiled");
    await waitFor(
      cdp,
      "tiled layout restored before pin",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        return grid?.getAttribute("data-meet-view-requested") === "tiled" &&
          grid?.getAttribute("data-meet-view-layout") === "tiled";
      })()`,
      10000,
    );
    await clickButton(cdp, "Pin to spotlight");
    await waitFor(
      cdp,
      "pin overrides tiled layout to spotlight",
      `(() => {
        const grid = document.querySelector("[data-meet-view-layout]");
        return grid?.getAttribute("data-meet-view-requested") === "tiled" &&
          grid?.getAttribute("data-meet-view-layout") === "spotlight" &&
          grid?.getAttribute("data-meet-view-effective") === "spotlight" &&
          grid?.getAttribute("data-meet-view-base-effective") === "tiled" &&
          grid?.getAttribute("data-meet-view-pinned-spotlight") === "true" &&
          grid?.getAttribute("data-meet-view-stage-rail-count") === "0" &&
          grid?.getAttribute("data-meet-view-overflow-tile") === "false" &&
          Boolean(document.querySelector("[data-meet-stage-main]"));
      })()`,
      10000,
    );
    await collectLayoutState(cdp, "layout_after_pin_spotlight_override");

    const badLogs = cdp.logs.filter((log) =>
      badLogPatterns.some((pattern) => pattern.test(log.text)),
    );
    emit("browser_logs", {
      count: cdp.logs.length,
      badLogs,
      recent: cdp.logs.slice(-40),
    });
    const prewarmDoneKinds = new Set(
      cdp.logs
        .filter((log) => /processor_worker_prewarm_done/.test(log.text))
        .map((log) => {
          const match = log.text.match(/"kind":"([^"]+)"/);
          return match?.[1] ?? null;
        })
        .filter(Boolean),
    );
    const prewarmSuppressedKinds = new Set(
      cdp.logs
        .filter((log) =>
          /processor_worker_prewarm_(?:suppressed|cancelled)_busy/.test(
            log.text,
          ),
        )
        .map((log) => {
          const match = log.text.match(/"kind":"([^"]+)"/);
          return match?.[1] ?? null;
        })
        .filter(Boolean),
    );
    const prewarmFailureLogs = cdp.logs.filter((log) =>
      /processor_worker_prewarm_failed|output_writer_worker_prewarm_failed/.test(
        log.text,
      ),
    );
    const outputWriterPrewarmDone = cdp.logs.some((log) =>
      /output_writer_worker_prewarm_done/.test(log.text),
    );
    const outputWriterPrewarmSuppressed = cdp.logs.some((log) =>
      /output_writer_worker_prewarm_suppressed_busy/.test(log.text),
    );
    const cameraLivePrewarmRequested = cdp.logs.some(
      (log) =>
        /prewarm_requested/.test(log.text) &&
        /"reason":"camera-live"/.test(log.text),
    );
    const cameraLivePrewarmDone = cdp.logs.some(
      (log) =>
        /prewarm_done/.test(log.text) &&
        /"reason":"camera-live"/.test(log.text),
    );
    const shellRuntimePrewarmRequested = cdp.logs.some(
      (log) =>
        /runtime_prewarm_requested/.test(log.text) &&
        /"reason":"meet-shell-runtime"/.test(log.text),
    );
    const shellRuntimePrewarmDone = cdp.logs.some(
      (log) =>
        /runtime_prewarm_done/.test(log.text) &&
        /"reason":"meet-shell-runtime"/.test(log.text),
    );
    const missingPrewarmKinds = ["segmentation", "face"].filter(
      (kind) =>
        !prewarmDoneKinds.has(kind) && !prewarmSuppressedKinds.has(kind),
    );
    const processorPrewarmFailed =
      missingPrewarmKinds.length > 0 ||
      (!outputWriterPrewarmDone && !outputWriterPrewarmSuppressed) ||
      prewarmFailureLogs.length > 0;
    emit("processor_worker_prewarm_probe", {
      ok: !processorPrewarmFailed,
      doneKinds: Array.from(prewarmDoneKinds),
      suppressedKinds: Array.from(prewarmSuppressedKinds),
      missingKinds: missingPrewarmKinds,
      outputWriterDone: outputWriterPrewarmDone,
      outputWriterSuppressed: outputWriterPrewarmSuppressed,
      failures: prewarmFailureLogs,
    });
    emit("camera_live_prewarm_probe", {
      ok: cameraLivePrewarmRequested && cameraLivePrewarmDone,
      requested: cameraLivePrewarmRequested,
      done: cameraLivePrewarmDone,
    });
    emit("meet_shell_runtime_prewarm_probe", {
      label: "final",
      ok: shellRuntimePrewarmRequested && shellRuntimePrewarmDone,
      requested: shellRuntimePrewarmRequested,
      done: shellRuntimePrewarmDone,
    });

    const blackOutputCount = Number(
      state.panelAttrs?.["data-video-effects-black-output-count"] ?? 1,
    );
    const faceProbeFailures = expectFaceLandmarks
      ? faceProbes.filter(
          (probe) =>
            probe.faceLandmarkCount <= 0 ||
            Number(probe.alignment?.filterLandmarkSmoothing?.alpha ?? 0) <
              0.7 ||
            Number(probe.alignment?.filterLandmarkSmoothing?.alpha ?? 0) <
              Number(probe.alignment?.landmarkSmoothing?.alpha ?? 0) ||
            Number(probe.alignment?.faceIntervalMs ?? 999) > 70 ||
            probe.previewMatchesOutput !== true ||
            probe.render?.filter !== probe.expectedFilterId ||
            probe.render?.drawn !== true ||
            Number(probe.render?.changedPixels || 0) <= 0,
        )
      : [];
    const backgroundProbeFailures = backgroundProbes.filter(
      (probe) =>
        probe.previewMatchesOutput !== true ||
        probe.render?.background !== probe.expectedBackgroundId ||
        probe.render?.active !== true ||
        Number(probe.render?.changedPixels || 0) <= 0 ||
        (probe.requiresBackgroundImage &&
          probe.render?.hasBackgroundImage !== true),
    );
    const sourceFrame = state.panelStats?.framePipeline?.sourceFrame ?? null;
    const darkVideoProbeFallbackFailed =
      forceDarkVideoProbe &&
      !(
        ["track-processor", "image-capture"].includes(sourceFrame?.selection) &&
        sourceFrame?.fallbackReason === "dark-video" &&
        Number(sourceFrame?.blackSourceVideoFrameCount || 0) > 0 &&
        Number(sourceFrame?.fallbackCount || 0) > 0
      );
    const effectSwitchLatencyQuality = getEffectSwitchLatencyQuality(
      cdp.logs,
      state,
      "final",
      { fromIndex: rapidEffectSwitchLogIndex },
    );
    emit("effect_switch_latency_quality_probe", effectSwitchLatencyQuality);
    if (
      state.panelAttrs?.["data-video-effects-output-published"] !== "true" ||
      state.panelAttrs?.["data-video-effects-status"] !== "running" ||
      blackOutputCount !== 0 ||
      faceProbeFailures.length > 0 ||
      backgroundProbeFailures.length > 0 ||
      darkVideoProbeFallbackFailed ||
      processorPrewarmFailed ||
      !cameraToggleLivePrewarmRequested ||
      !cameraToggleLivePrewarmDone ||
      !cameraLivePrewarmRequested ||
      !cameraLivePrewarmDone ||
      !shellRuntimePrewarmRequested ||
      !shellRuntimePrewarmDone ||
      !effectSwitchLatencyQuality.ok ||
      badLogs.length > 0
    ) {
      throw new Error(
        `Video effects headless regression failed: ${JSON.stringify({
          faceProbeFailures,
          backgroundProbeFailures,
          darkVideoProbeFallbackFailed,
          processorPrewarmFailed,
          missingPrewarmKinds,
          prewarmFailureLogs,
          cameraToggleLivePrewarmRequested,
          cameraToggleLivePrewarmDone,
          cameraLivePrewarmRequested,
          cameraLivePrewarmDone,
          shellRuntimePrewarmRequested,
          shellRuntimePrewarmDone,
          effectSwitchLatencyQuality,
          sourceFrame,
          badLogs,
          blackOutputCount,
        })}`,
      );
    }

    emit("result", { ok: true });
  } catch (error) {
    if (cdp) {
      const badLogs = cdp.logs.filter((log) =>
        badLogPatterns.some((pattern) => pattern.test(log.text)),
      );
      emit("browser_logs_on_error", {
        count: cdp.logs.length,
        badLogs,
        recent: cdp.logs.slice(-80),
      });
    }
    throw error;
  } finally {
    cdp?.close();
    chrome.kill("SIGTERM");
    setTimeout(() => {
      if (!chrome.killed) chrome.kill("SIGKILL");
    }, 2000).unref();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
};

run().catch((error) => {
  emit("result", {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exitCode = 1;
});
