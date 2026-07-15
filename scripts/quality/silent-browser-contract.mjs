import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const SILENT_BROWSER_CONTRACT_VERSION = 1;
export const SILENT_BROWSER_FINGERPRINT =
  "conclave-silent-browser-v1-headless-new-zero-audio";
export const SILENT_BROWSER_PERMISSION_OVERRIDES = Object.freeze([
  Object.freeze({ name: "microphone", setting: "denied" }),
  Object.freeze({ name: "camera", setting: "granted" }),
  Object.freeze({ name: "display-capture", setting: "denied" }),
  Object.freeze({ name: "notifications", setting: "denied" }),
]);

const activeSessions = new Set();
const sessionInternals = new WeakMap();
const approvedPreSafetyBootstraps = new WeakSet();
const MAX_RETAINED_CDP_LOGS = 50_000;
let signalGuardsInstalled = false;
let signalCleanupPromise = null;
let fatalCleanupPromise = null;
let cleanupAuthorityHold = null;

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const finitePositiveInteger = (value, fallback, name) => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return resolved;
};

const normalizeWindowSize = (value) => {
  const candidate = String(value ?? "1440,900").trim();
  if (!/^\d{2,5},\d{2,5}$/.test(candidate)) {
    throw new TypeError("windowSize must be WIDTH,HEIGHT");
  }
  return candidate;
};

const normalizeSyntheticVideoPath = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError("syntheticVideoFilePath must be an absolute path");
  }
  const path = resolve(value);
  if (!existsSync(path)) {
    throw new Error(`Synthetic video fixture does not exist: ${path}`);
  }
  return path;
};

const SILENT_AUDIO_FILE_NAME = "conclave-zero-audio.wav";
const SILENT_AUDIO_SAMPLE_RATE = 48_000;
const SILENT_AUDIO_DURATION_MS = 1_000;
const SILENT_AUDIO_DATA_BYTES =
  (SILENT_AUDIO_SAMPLE_RATE * SILENT_AUDIO_DURATION_MS * 2) / 1_000;

export function buildOwnedSilentAudioWav() {
  const bytes = Buffer.alloc(44 + SILENT_AUDIO_DATA_BYTES);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SILENT_AUDIO_SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SILENT_AUDIO_SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(SILENT_AUDIO_DATA_BYTES, 40);
  return bytes;
}

export function validateOwnedSilentAudioFixture(path, userDataDir) {
  if (
    typeof userDataDir !== "string" ||
    !isAbsolute(userDataDir) ||
    !userDataDir.includes("conclave-silent-browser-")
  ) {
    throw new TypeError("Silent audio fixture requires an owned browser profile");
  }
  const expectedPath = join(resolve(userDataDir), SILENT_AUDIO_FILE_NAME);
  const resolvedPath = resolve(path);
  if (resolvedPath !== expectedPath) {
    throw new Error("Silent audio fixture must live inside the owned profile");
  }
  const stat = lstatSync(resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Silent audio fixture must be an owned regular file");
  }
  const bytes = readFileSync(resolvedPath);
  const validHeader =
    bytes.length === 44 + SILENT_AUDIO_DATA_BYTES &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WAVE" &&
    bytes.toString("ascii", 12, 16) === "fmt " &&
    bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === SILENT_AUDIO_SAMPLE_RATE &&
    bytes.readUInt32LE(28) === SILENT_AUDIO_SAMPLE_RATE * 2 &&
    bytes.readUInt16LE(32) === 2 &&
    bytes.readUInt16LE(34) === 16 &&
    bytes.toString("ascii", 36, 40) === "data" &&
    bytes.readUInt32LE(40) === SILENT_AUDIO_DATA_BYTES;
  if (!validHeader) {
    throw new Error("Silent audio fixture WAV header is invalid");
  }
  if (bytes.subarray(44).some((byte) => byte !== 0)) {
    throw new Error("Silent audio fixture contains non-zero PCM samples");
  }
  return Object.freeze({
    path: resolvedPath,
    sampleRate: SILENT_AUDIO_SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    dataBytes: SILENT_AUDIO_DATA_BYTES,
    zeroPcm: true,
  });
}

export function createOwnedSilentAudioFixture(userDataDir) {
  if (
    typeof userDataDir !== "string" ||
    !isAbsolute(userDataDir) ||
    !userDataDir.includes("conclave-silent-browser-")
  ) {
    throw new TypeError("Silent audio fixture requires an owned browser profile");
  }
  const path = join(resolve(userDataDir), SILENT_AUDIO_FILE_NAME);
  writeFileSync(path, buildOwnedSilentAudioWav(), {
    flag: "wx",
    mode: 0o600,
  });
  return validateOwnedSilentAudioFixture(path, userDataDir);
}

const approveGeneratedQualityFixtureBootstrap = (source, expectedPolicy) => {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    !source.includes("__conclaveQualityHarness")
  ) {
    throw new TypeError(
      "The quality browser fixture bootstrap must contain its harness identity",
    );
  }
  const descriptor = Object.freeze({
    name: "quality-browser-fixture",
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
    expectedPolicy: Object.freeze({ ...expectedPolicy }),
  });
  approvedPreSafetyBootstraps.add(descriptor);
  return descriptor;
};

export async function createTrustedQualityFixtureBootstrap(options = {}) {
  if (options?.enableSyntheticAudio === false) {
    throw new Error(
      "Approved quality fixtures must enable synthetic zero audio",
    );
  }
  const { buildFixtureInjectionScript } = await import("./browser-fixture.mjs");
  return approveGeneratedQualityFixtureBootstrap(
    buildFixtureInjectionScript(options),
    {
      enableSyntheticCamera: options?.enableSyntheticCamera === true,
      enableSyntheticAudio: true,
    },
  );
}

const normalizeTrustedPreSafetyBootstraps = (values) => {
  const bootstraps = Array.from(values ?? []);
  if (bootstraps.length > 1) {
    throw new Error("Only one approved pre-safety bootstrap may be installed");
  }
  for (const bootstrap of bootstraps) {
    if (!approvedPreSafetyBootstraps.has(bootstrap)) {
      throw new Error(
        "Pre-safety bootstrap descriptors must come from createTrustedQualityFixtureBootstrap",
      );
    }
    const actualSha256 = createHash("sha256")
      .update(bootstrap.source)
      .digest("hex");
    if (actualSha256 !== bootstrap.sha256) {
      throw new Error("Approved pre-safety bootstrap source changed after approval");
    }
    if (
      typeof bootstrap.expectedPolicy?.enableSyntheticCamera !== "boolean" ||
      bootstrap.expectedPolicy?.enableSyntheticAudio !== true
    ) {
      throw new Error("Approved quality fixture policy is invalid");
    }
  }
  return Object.freeze(bootstraps);
};

export function buildSilentBrowserLaunchPlan({
  userDataDir,
  windowSize = "1440,900",
  silentAudioFilePath,
  syntheticVideoFilePath = null,
} = {}) {
  if (
    typeof userDataDir !== "string" ||
    !isAbsolute(userDataDir) ||
    !userDataDir.includes("conclave-silent-browser-")
  ) {
    throw new TypeError(
      "userDataDir must be an owned conclave-silent-browser temporary directory",
    );
  }
  const silentAudioFixture = validateOwnedSilentAudioFixture(
    silentAudioFilePath,
    userDataDir,
  );
  const fakeVideoPath = normalizeSyntheticVideoPath(syntheticVideoFilePath);
  const args = [
    "--headless=new",
    "--mute-audio",
    "--disable-notifications",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--enable-automation",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-extensions",
    "--disable-sync",
    "--disable-features=MediaRouter",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${silentAudioFixture.path}`,
    `--window-size=${normalizeWindowSize(windowSize)}`,
    ...(fakeVideoPath
      ? [`--use-file-for-fake-video-capture=${fakeVideoPath}`]
      : []),
    "about:blank",
  ];
  const stdio = Object.freeze(["ignore", "ignore", "ignore"]);
  const plan = {
    args: Object.freeze(args),
    stdio,
    initialUrl: "about:blank",
    userDataDir,
    silentAudioFilePath: silentAudioFixture.path,
    syntheticVideoFilePath: fakeVideoPath,
  };
  assertSilentBrowserLaunchPlan(plan);
  return Object.freeze(plan);
}

export function assertSilentBrowserLaunchPlan(plan) {
  const args = Array.from(plan?.args ?? []);
  if (
    typeof plan?.userDataDir !== "string" ||
    !isAbsolute(plan.userDataDir) ||
    !plan.userDataDir.includes("conclave-silent-browser-")
  ) {
    throw new Error("Silent browser profile is not centrally owned");
  }
  const headlessArguments = args.filter((argument) =>
    String(argument).startsWith("--headless"),
  );
  if (
    headlessArguments.length !== 1 ||
    headlessArguments[0] !== "--headless=new"
  ) {
    throw new Error("Silent browser requires exactly --headless=new");
  }
  if (args.filter((argument) => argument === "--mute-audio").length !== 1) {
    throw new Error("Silent browser requires exactly one --mute-audio");
  }
  if (plan?.initialUrl !== "about:blank" || args.at(-1) !== "about:blank") {
    throw new Error("Silent browser must launch about:blank before navigation");
  }
  if (
    args.filter((argument) =>
      String(argument).startsWith("--user-data-dir="),
    ).length !== 1 ||
    !args.includes(`--user-data-dir=${plan.userDataDir}`)
  ) {
    throw new Error("Silent browser requires exactly one owned temporary profile");
  }
  const debuggingPorts = args.filter((argument) =>
    String(argument).startsWith("--remote-debugging-port="),
  );
  if (debuggingPorts.length !== 1 || debuggingPorts[0] !== "--remote-debugging-port=0") {
    throw new Error("Silent browser requires exactly one OS-selected DevTools port");
  }
  const debuggingAddresses = args.filter((argument) =>
    String(argument).startsWith("--remote-debugging-address="),
  );
  if (
    debuggingAddresses.length !== 1 ||
    debuggingAddresses[0] !== "--remote-debugging-address=127.0.0.1"
  ) {
    throw new Error("Silent browser DevTools must bind only to loopback");
  }
  if (
    args.filter((argument) => argument === "--disable-notifications").length !== 1
  ) {
    throw new Error("Silent browser must disable browser notifications");
  }
  if (
    args.filter(
      (argument) => argument === "--use-fake-device-for-media-stream",
    ).length !== 1 ||
    args.filter((argument) => argument === "--use-fake-ui-for-media-stream")
      .length !== 1
  ) {
    throw new Error("Silent browser must make hardware media devices unreachable");
  }
  const silentAudioFixture = validateOwnedSilentAudioFixture(
    plan?.silentAudioFilePath,
    plan.userDataDir,
  );
  const fakeAudioArguments = args.filter((argument) =>
    String(argument).startsWith("--use-file-for-fake-audio-capture="),
  );
  if (
    fakeAudioArguments.length !== 1 ||
    fakeAudioArguments[0] !==
      `--use-file-for-fake-audio-capture=${silentAudioFixture.path}`
  ) {
    throw new Error(
      "Silent browser requires exactly one centrally validated zero-audio WAV",
    );
  }
  if (args.slice(0, -1).some((argument) => !String(argument).startsWith("--"))) {
    throw new Error("Silent browser may expose only its initial about:blank target");
  }
  const forbidden = [
    "--headless=old",
    "--headless=false",
    "--auto-select-desktop-capture-source",
    "--enable-usermedia-screen-capturing",
    "--allow-http-screen-capture",
  ];
  for (const argument of args) {
    if (
      forbidden.some(
        (entry) => argument === entry || argument.startsWith(`${entry}=`),
      )
    ) {
      throw new Error(`Unsafe Chrome argument is forbidden: ${argument}`);
    }
  }
  if (
    !Array.isArray(plan?.stdio) ||
    plan.stdio.length !== 3 ||
    plan.stdio.some((entry) => entry !== "ignore")
  ) {
    throw new Error("Chrome stdin, stdout, and stderr must all be ignored");
  }
  return true;
}

class BoundedLogStore {
  #droppedEntries;
  #entries;
  #maxEntries;
  #totalEntries;

  constructor(maxEntries = MAX_RETAINED_CDP_LOGS) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
    this.#entries = [];
    this.#totalEntries = 0;
    this.#droppedEntries = 0;
    Object.freeze(this);
  }

  get length() {
    return this.#totalEntries;
  }

  get maxEntries() {
    return this.#maxEntries;
  }

  get retainedLength() {
    return this.#entries.length;
  }

  get droppedEntries() {
    return this.#droppedEntries;
  }

  get truncated() {
    return this.#droppedEntries > 0;
  }

  assertComplete(operation) {
    if (this.truncated) {
      throw new Error(
        `Silent CDP logs are incomplete for ${operation}: ${this.#droppedEntries} entries were dropped`,
      );
    }
  }

  push(entry) {
    const storedEntry = Object.freeze({ ...(entry ?? {}) });
    this.#entries.push(storedEntry);
    this.#totalEntries += 1;
    if (this.#entries.length > this.#maxEntries) {
      const dropCount = this.#entries.length - this.#maxEntries;
      this.#entries.splice(0, dropCount);
      this.#droppedEntries += dropCount;
    }
    return this.#totalEntries;
  }

  slice(start = 0, end = this.#totalEntries) {
    const normalizeIndex = (value, fallback) => {
      if (value === undefined) return fallback;
      const number = Number(value);
      if (Number.isNaN(number)) return 0;
      const integer = Number.isFinite(number)
          ? Math.trunc(number)
          : number > 0
          ? this.#totalEntries
          : 0;
      return integer < 0
        ? Math.max(this.#totalEntries + integer, 0)
        : Math.min(integer, this.#totalEntries);
    };
    const from = normalizeIndex(start, 0);
    const to = Math.max(from, normalizeIndex(end, this.#totalEntries));
    if (from < this.#droppedEntries) {
      throw new Error(
        `Silent CDP log slice starts before retained history: ${this.#droppedEntries} entries were dropped`,
      );
    }
    return this.#entries.slice(
      Math.max(0, from - this.#droppedEntries),
      Math.max(0, to - this.#droppedEntries),
    );
  }

  filter(predicate, thisArg) {
    this.assertComplete("filter");
    return this.#entries.filter(predicate, thisArg);
  }

  some(predicate, thisArg) {
    this.assertComplete("some");
    return this.#entries.some(predicate, thisArg);
  }

  [Symbol.iterator]() {
    this.assertComplete("iteration");
    return this.#entries[Symbol.iterator]();
  }

  toJSON() {
    return {
      droppedEntries: this.#droppedEntries,
      entries: this.#entries.slice(),
      retainedLength: this.retainedLength,
      totalEntries: this.#totalEntries,
      truncated: this.truncated,
    };
  }
}

export const createBoundedSilentCdpLogStore = (maxEntries) =>
  new BoundedLogStore(maxEntries);

const createReadOnlyLogView = (logs) =>
  Object.freeze({
    get length() {
      return logs.length;
    },
    get retainedLength() {
      return logs.retainedLength;
    },
    get droppedEntries() {
      return logs.droppedEntries;
    },
    get truncated() {
      return logs.truncated;
    },
    slice(start, end) {
      return logs.slice(start, end);
    },
    filter(predicate, thisArg) {
      return logs.filter(predicate, thisArg);
    },
    some(predicate, thisArg) {
      return logs.some(predicate, thisArg);
    },
    [Symbol.iterator]() {
      return logs[Symbol.iterator]();
    },
    toJSON() {
      return logs.toJSON();
    },
  });

const appendCdpLog = (logs, message) => {
  if (message.method === "Runtime.consoleAPICalled") {
    logs.push({
      source: "console",
      level: message.params?.type,
      text: (message.params?.args ?? [])
        .map((argument) =>
          "value" in argument
            ? String(argument.value)
            : (argument.description ?? argument.type),
        )
        .join(" "),
    });
  } else if (message.method === "Log.entryAdded") {
    logs.push({
      source: message.params?.entry?.source,
      level: message.params?.entry?.level,
      text: message.params?.entry?.text ?? "",
      url: message.params?.entry?.url,
    });
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params?.exceptionDetails;
    logs.push({
      source: "exception",
      level: "error",
      text:
        details?.exception?.description ??
        details?.text ??
        "Runtime exception",
      url: details?.url,
      lineNumber: details?.lineNumber,
      columnNumber: details?.columnNumber,
    });
  }
};

export const dispatchSilentCdpListeners = (
  listeners,
  params,
  message,
  recordFailure,
) => {
  const record = (error) => {
    try {
      recordFailure(error);
    } catch {}
  };
  for (const listener of listeners ?? []) {
    try {
      const result = listener(params, message);
      if (result && typeof result.then === "function") {
        void result.then(undefined, record);
      }
    } catch (error) {
      record(error);
    }
  }
};

class SilentCdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.logs = new BoundedLogStore();
    this.listenerError = null;
  }

  async open(timeoutMs = 10_000) {
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error("Timed out opening silent-browser CDP"));
      }, timeoutMs);
      const finish = (callback) => (event) => {
        clearTimeout(timer);
        callback(event);
      };
      socket.addEventListener("open", finish(resolvePromise), { once: true });
      socket.addEventListener(
        "error",
        finish(() => rejectPromise(new Error("Silent-browser CDP failed to open"))),
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      appendCdpLog(this.logs, message);
      if (!this.listenerError) {
        dispatchSilentCdpListeners(
          this.listeners.get(message.method),
          message.params ?? {},
          message,
          (error) => {
            if (this.listenerError) return;
            this.listenerError =
              error instanceof Error ? error : new Error(String(error));
            this.logs.push({
              source: "harness-listener",
              level: "error",
              text: this.listenerError.message,
            });
          },
        );
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Silent-browser CDP closed"));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("CDP event listener must be a function");
    }
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, timeoutMs = 10_000, sessionId = null) {
    if (
      this.listenerError &&
      !["Browser.close", "Target.detachFromTarget"].includes(method)
    ) {
      return Promise.reject(
        new Error(
          `Silent-browser CDP listener failed earlier: ${this.listenerError.message}`,
          { cause: this.listenerError },
        ),
      );
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Silent-browser CDP is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {}
  }
}

export class ExactTargetCdpChannel {
  #browserCdp;
  #closed;
  #logStore;
  #logs;
  #sessionId;
  #targetId;

  constructor(browserCdp, { targetId, sessionId }) {
    if (typeof targetId !== "string" || typeof sessionId !== "string") {
      throw new TypeError("Exact target channel identity is required");
    }
    this.#browserCdp = browserCdp;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
    this.#logStore = new BoundedLogStore();
    this.#logs = createReadOnlyLogView(this.#logStore);
    this.#closed = false;
    Object.freeze(this);
    for (const method of [
      "Runtime.consoleAPICalled",
      "Log.entryAdded",
      "Runtime.exceptionThrown",
    ]) {
      browserCdp.on(method, (_params, message) => {
        if (!this.#closed && message.sessionId === this.#sessionId) {
          appendCdpLog(this.#logStore, message);
        }
      });
    }
  }

  get targetId() {
    return this.#targetId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get logs() {
    return this.#logs;
  }

  send(method, params = {}, timeoutMs) {
    if (this.#closed) {
      return Promise.reject(new Error("Silent target CDP channel is closed"));
    }
    return this.#browserCdp.send(method, params, timeoutMs, this.#sessionId);
  }

  on(method, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("CDP event listener must be a function");
    }
    this.#browserCdp.on(method, (params, message) => {
      if (!this.#closed && message.sessionId === this.#sessionId) {
        return listener(params, message);
      }
      return undefined;
    });
  }

  close() {
    this.#closed = true;
  }
}

const allowedCallerCdpMethods = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmitTouchEventsForMouse",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
  "Log.enable",
  "Network.emulateNetworkConditions",
  "Network.emulateNetworkConditionsByRule",
  "Network.enable",
  "Network.overrideNetworkState",
  "Network.setUserAgentOverride",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Runtime.enable",
  "Runtime.evaluate",
]);

const callerCdpParamKeys = new Map([
  [
    "Emulation.setDeviceMetricsOverride",
    new Set([
      "width",
      "height",
      "deviceScaleFactor",
      "mobile",
      "scale",
      "screenWidth",
      "screenHeight",
      "positionX",
      "positionY",
      "dontSetVisibleSize",
      "screenOrientation",
      "viewport",
      "displayFeature",
      "devicePosture",
    ]),
  ],
  ["Emulation.setEmitTouchEventsForMouse", new Set(["enabled", "configuration"])],
  ["Emulation.setTouchEmulationEnabled", new Set(["enabled", "maxTouchPoints"])],
  [
    "Emulation.setUserAgentOverride",
    new Set(["userAgent", "acceptLanguage", "platform", "userAgentMetadata"]),
  ],
  ["Log.enable", new Set()],
  [
    "Network.emulateNetworkConditions",
    new Set([
      "offline",
      "latency",
      "downloadThroughput",
      "uploadThroughput",
      "connectionType",
      "packetLoss",
      "packetQueueLength",
      "packetReordering",
    ]),
  ],
  [
    "Network.emulateNetworkConditionsByRule",
    new Set(["offline", "matchedNetworkConditions"]),
  ],
  [
    "Network.enable",
    new Set([
      "maxTotalBufferSize",
      "maxResourceBufferSize",
      "maxPostDataSize",
      "reportDirectSocketTraffic",
      "enableDurableMessages",
    ]),
  ],
  [
    "Network.overrideNetworkState",
    new Set([
      "offline",
      "latency",
      "downloadThroughput",
      "uploadThroughput",
      "connectionType",
    ]),
  ],
  [
    "Network.setUserAgentOverride",
    new Set(["userAgent", "acceptLanguage", "platform", "userAgentMetadata"]),
  ],
  ["Page.addScriptToEvaluateOnNewDocument", new Set(["source"])],
  ["Page.enable", new Set()],
  ["Page.setLifecycleEventsEnabled", new Set(["enabled"])],
  ["Runtime.enable", new Set()],
  [
    "Runtime.evaluate",
    new Set(["expression", "awaitPromise", "returnByValue", "timeout"]),
  ],
]);

const allowedCallerCdpEvents = new Set([
  "Log.entryAdded",
  "Network.loadingFailed",
  "Network.loadingFinished",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Page.lifecycleEvent",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
]);

const sanitizeCdpValue = (value, seen = new WeakSet(), depth = 0) => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || depth >= 20) {
    throw new TypeError("CDP parameters must contain finite JSON data only");
  }
  if (seen.has(value)) {
    throw new TypeError("CDP parameters cannot contain cycles");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new RangeError("CDP parameter arrays are too large");
    }
    const result = value.map((entry) =>
      sanitizeCdpValue(entry, seen, depth + 1),
    );
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("CDP parameters must use plain objects");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key === "toJSON")) {
    throw new TypeError("CDP parameters cannot customize serialization");
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("CDP parameters cannot use accessors or hidden data");
    }
    result[key] = sanitizeCdpValue(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
};

const normalizeCdpParams = (method, params, allowedKeys) => {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${method} contains parameters outside the silent contract`);
  }
  const normalized = sanitizeCdpValue(params);
  if (
    Reflect.ownKeys(normalized).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new Error(`${method} contains parameters outside the silent contract`);
  }
  if (
    ["Runtime.evaluate", "Page.addScriptToEvaluateOnNewDocument"].includes(
      method,
    ) &&
    typeof (method === "Runtime.evaluate"
      ? normalized.expression
      : normalized.source) !== "string"
  ) {
    throw new TypeError(`${method} requires a string source expression`);
  }
  return normalized;
};

export const createSilentPageFacade = (pageCdp) => {
  const logs = createReadOnlyLogView(pageCdp.logs);
  return Object.freeze({
    send(method, params = {}, timeoutMs) {
      if (!allowedCallerCdpMethods.has(method)) {
        return Promise.reject(
          new Error(
            `${method} is reserved for the central silent-browser authority`,
          ),
        );
      }
      let normalizedParams;
      try {
        normalizedParams = normalizeCdpParams(
          method,
          params,
          callerCdpParamKeys.get(method),
        );
      } catch (error) {
        return Promise.reject(error);
      }
      return pageCdp.send(method, normalizedParams, timeoutMs);
    },
    on(method, listener) {
      if (!allowedCallerCdpEvents.has(method)) {
        throw new Error(`${method} events are outside the silent contract`);
      }
      return pageCdp.on(method, listener);
    },
    get logs() {
      return logs;
    },
  });
};

const allowedSystemCdpMethods = new Set([
  "Browser.getVersion",
  "SystemInfo.getInfo",
  "SystemInfo.getProcessInfo",
]);

export const createReadOnlySystemFacade = (browserCdp) =>
  Object.freeze({
    send(method, params = {}, timeoutMs) {
      if (!allowedSystemCdpMethods.has(method)) {
        return Promise.reject(
          new Error(`${method} is not available on the read-only system facade`),
        );
      }
      try {
        const normalizedParams = normalizeCdpParams(method, params, new Set());
        return browserCdp.send(method, normalizedParams, timeoutMs);
      } catch (error) {
        return Promise.reject(
          new Error(
            `${method} does not accept parameters on the system facade: ${error.message}`,
          ),
        );
      }
    },
  });

const allowedNetworkCdpMethods = new Set([
  "Network.enable",
  "Network.emulateNetworkConditionsByRule",
  "Network.overrideNetworkState",
]);

export const createExactTargetNetworkFacade = (
  browserCdp,
  { targetId, sessionId },
) => {
  if (typeof targetId !== "string" || typeof sessionId !== "string") {
    throw new TypeError("Exact target network identity is required");
  }
  return Object.freeze({
    targetId,
    sessionId,
    send(method, params = {}, timeoutMs) {
      if (!allowedNetworkCdpMethods.has(method)) {
        return Promise.reject(
          new Error(`${method} is not available on the network facade`),
        );
      }
      let normalizedParams;
      try {
        normalizedParams = normalizeCdpParams(
          method,
          params,
          callerCdpParamKeys.get(method),
        );
      } catch (error) {
        return Promise.reject(error);
      }
      return browserCdp.send(method, normalizedParams, timeoutMs, sessionId);
    },
    on(method, listener) {
      if (!String(method).startsWith("Network.")) {
        throw new Error(`${method} is not available on the network facade`);
      }
      browserCdp.on(method, (params, message) => {
        if (message.sessionId === sessionId) return listener(params);
        return undefined;
      });
    },
  });
};

export const createSilentBrowserSessionFacade = (
  resources,
  { label, trustedBootstrapAttestations },
) =>
  Object.freeze({
    label,
    trustedBootstrapAttestations,
    get authority() {
      return resources.authority;
    },
    get bootstrap() {
      return resources.bootstrap;
    },
    get pageCdp() {
      return resources.pageFacade;
    },
    get systemCdp() {
      return resources.systemFacade;
    },
    get networkCdp() {
      return resources.networkFacade;
    },
    get networkIdentity() {
      return resources.networkIdentity;
    },
    get finalAttestation() {
      return resources.finalAttestation;
    },
  });

const fetchJson = async (url, label, timeoutMs) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${lastError?.message ?? "unavailable"}`,
  );
};

const readDevToolsActivePort = async (
  userDataDir,
  { timeoutMs, childState },
) => {
  const path = join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (childState.spawnError) throw childState.spawnError;
    if (childState.exited) {
      throw new Error(
        `Chrome exited before publishing DevToolsActivePort (${childState.exitCode ?? childState.signal ?? "unknown"})`,
      );
    }
    if (existsSync(path)) {
      const [portLine, browserPath] = readFileSync(path, "utf8").trim().split(/\r?\n/);
      const port = Number(portLine);
      if (
        Number.isInteger(port) &&
        port > 0 &&
        port < 65_536 &&
        browserPath?.startsWith("/devtools/browser/")
      ) {
        return { port, browserPath };
      }
    }
    await sleep(25);
  }
  throw new Error("Timed out waiting for the owned Chrome DevTools endpoint");
};

const countExact = (values, expected) =>
  values.filter((value) => value === expected).length;

export async function verifySilentBrowserAuthority({
  browserCdp,
  childPid,
  plan,
}) {
  assertSilentBrowserLaunchPlan(plan);
  const silentAudioFixture = validateOwnedSilentAudioFixture(
    plan.silentAudioFilePath,
    plan.userDataDir,
  );
  if (!Number.isInteger(childPid) || childPid <= 0) {
    throw new Error("Spawned Chrome PID is unavailable");
  }
  const [processInfo, commandLine] = await Promise.all([
    browserCdp.send("SystemInfo.getProcessInfo"),
    browserCdp.send("Browser.getBrowserCommandLine"),
  ]);
  const exactBrowserProcesses = (processInfo?.processInfo ?? []).filter(
    (process) =>
      Number(process?.id) === childPid &&
      String(process?.type ?? "").toLowerCase() === "browser",
  );
  if (exactBrowserProcesses.length !== 1) {
    throw new Error(
      `CDP endpoint is not owned by spawned Chrome PID ${childPid}`,
    );
  }

  const runningArguments = Array.from(commandLine?.arguments ?? [], String);
  if (
    countExact(runningArguments, "--headless=new") !== 1 ||
    runningArguments.filter((argument) => argument.startsWith("--headless"))
      .length !== 1
  ) {
    throw new Error("Running Chrome did not prove exact --headless=new");
  }
  if (
    countExact(runningArguments, "--mute-audio") !== 1 ||
    runningArguments.filter((argument) => argument.startsWith("--mute-audio"))
      .length !== 1
  ) {
    throw new Error("Running Chrome did not prove exact --mute-audio");
  }
  if (countExact(runningArguments, `--user-data-dir=${plan.userDataDir}`) !== 1) {
    throw new Error("Running Chrome did not prove the owned temporary profile");
  }
  if (
    runningArguments.filter((argument) =>
      argument.startsWith("--user-data-dir="),
    ).length !== 1 ||
    countExact(runningArguments, "--remote-debugging-port=0") !== 1 ||
    runningArguments.filter((argument) =>
      argument.startsWith("--remote-debugging-port="),
    ).length !== 1 ||
    countExact(runningArguments, "--remote-debugging-address=127.0.0.1") !== 1 ||
    runningArguments.filter((argument) =>
      argument.startsWith("--remote-debugging-address="),
    ).length !== 1 ||
    countExact(runningArguments, "--use-fake-device-for-media-stream") !== 1 ||
    countExact(runningArguments, "--use-fake-ui-for-media-stream") !== 1 ||
    countExact(
      runningArguments,
      `--use-file-for-fake-audio-capture=${plan.silentAudioFilePath}`,
    ) !== 1 ||
    runningArguments.filter((argument) =>
      argument.startsWith("--use-file-for-fake-audio-capture="),
    ).length !== 1 ||
    countExact(runningArguments, "--disable-notifications") !== 1
  ) {
    throw new Error("Running Chrome did not prove its isolated silent authority");
  }
  const forbidden = runningArguments.filter(
    (argument) =>
      argument === "--enable-usermedia-screen-capturing" ||
      argument === "--allow-http-screen-capture" ||
      argument.startsWith("--auto-select-desktop-capture-source"),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Running Chrome contains forbidden capture arguments: ${forbidden.join(", ")}`,
    );
  }
  return {
    childPid,
    runningArguments,
    exactHeadless: true,
    muted: true,
    zeroAudioInput: true,
    silentAudioFixture,
    isolatedProfile: true,
  };
}

export function buildSilentPageBootstrap({
  syntheticDisplay = false,
  denySyntheticVideoWhenUrlIncludes = null,
  trustedBootstrapAttestations = [],
} = {}) {
  if (typeof syntheticDisplay !== "boolean") {
    throw new TypeError("syntheticDisplay must be a boolean");
  }
  if (
    denySyntheticVideoWhenUrlIncludes !== null &&
    (typeof denySyntheticVideoWhenUrlIncludes !== "string" ||
      denySyntheticVideoWhenUrlIncludes.length === 0 ||
      denySyntheticVideoWhenUrlIncludes.length > 256)
  ) {
    throw new TypeError(
      "denySyntheticVideoWhenUrlIncludes must be null or a short non-empty string",
    );
  }
  if (
    !Array.isArray(trustedBootstrapAttestations) ||
    trustedBootstrapAttestations.length > 1 ||
    trustedBootstrapAttestations.some(
      (attestation) =>
        attestation?.name !== "quality-browser-fixture" ||
        !/^[a-f0-9]{64}$/.test(attestation?.sha256 ?? "") ||
        typeof attestation?.expectedPolicy?.enableSyntheticCamera !==
          "boolean" ||
        attestation?.expectedPolicy?.enableSyntheticAudio !== true,
    )
  ) {
    throw new TypeError("Trusted bootstrap attestations are invalid");
  }
  const config = {
    version: SILENT_BROWSER_CONTRACT_VERSION,
    fingerprint: SILENT_BROWSER_FINGERPRINT,
    syntheticDisplay,
    denySyntheticVideoWhenUrlIncludes,
    trustedBootstrapAttestations: trustedBootstrapAttestations.map(
      ({ name, sha256, expectedPolicy }) => ({
        name,
        sha256,
        expectedPolicy: { ...expectedPolicy },
      }),
    ),
  };
  return `;(${installSilentPageContract.toString()})(${JSON.stringify(config)});`;
}

function installSilentPageContract(config) {
  "use strict";
  const GLOBAL = "__conclaveSilentBrowserSafety";
  if (globalThis[GLOBAL]?.fingerprint === config.fingerprint) return;

  const audit = {
    installedAt: Date.now(),
    htmlMediaPlayAttempts: 0,
    webAudioDestinationAttempts: 0,
    speechAttempts: 0,
    notificationAttempts: 0,
    blockedAudioCaptureAttempts: 0,
    blockedAudioOutputSelectionAttempts: 0,
    blockedVideoCaptureAttempts: 0,
    blockedDisplayCaptureAttempts: 0,
    syntheticAudioTrackCount: 0,
    syntheticVideoCaptureCalls: 0,
    syntheticDisplayCaptureCalls: 0,
    installationErrors: [],
  };
  const guards = {};
  const recordError = (label, error) => {
    audit.installationErrors.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  const defineImmutable = (target, key, value) => {
    Object.defineProperty(target, key, {
      configurable: false,
      enumerable: false,
      writable: false,
      value,
    });
  };
  const patchMethod = (target, key, value, label) => {
    if (!target || typeof target[key] !== "function") return false;
    try {
      Object.defineProperty(target, key, {
        configurable: false,
        enumerable: false,
        writable: false,
        value,
      });
      guards[label] = { target, key, value };
      return true;
    } catch (error) {
      recordError(label, error);
      return false;
    }
  };

  const patchSilentMediaAccessor = (target, key, silentValue, label) => {
    const descriptor = Object.getOwnPropertyDescriptor(target ?? {}, key);
    if (!descriptor?.get && !descriptor?.set) return false;
    const get = () => silentValue;
    const set = function () {
      descriptor.set?.call(this, silentValue);
    };
    try {
      Object.defineProperty(target, key, {
        configurable: false,
        enumerable: descriptor.enumerable ?? true,
        get,
        set,
      });
      guards[label] = {
        isIntact: () => {
          const current = Object.getOwnPropertyDescriptor(target, key);
          return current?.get === get && current?.set === set;
        },
      };
      return true;
    } catch (error) {
      recordError(label, error);
      return false;
    }
  };

  const mediaPrototype = globalThis.HTMLMediaElement?.prototype;
  if (mediaPrototype?.play) {
    const nativePlay = mediaPrototype.play;
    const silentPlay = function (...args) {
      audit.htmlMediaPlayAttempts += 1;
      try {
        this.muted = true;
        this.volume = 0;
      } catch {}
      return nativePlay.apply(this, args);
    };
    patchMethod(mediaPrototype, "play", silentPlay, "media-play");
  }
  patchSilentMediaAccessor(mediaPrototype, "muted", true, "media-muted");
  patchSilentMediaAccessor(mediaPrototype, "volume", 0, "media-volume");
  if (mediaPrototype?.setSinkId) {
    patchMethod(
      mediaPrototype,
      "setSinkId",
      async () => {
        audit.blockedAudioOutputSelectionAttempts += 1;
        throw new DOMException(
          "Audio output selection is disabled in silent probes",
          "NotAllowedError",
        );
      },
      "media-set-sink-id",
    );
  }
  const muteMedia = () => {
    for (const media of document.querySelectorAll("audio,video")) {
      try {
        if (media.muted !== true) media.muted = true;
        if (media.volume !== 0) media.volume = 0;
        if (!media.hasAttribute("muted")) media.setAttribute("muted", "");
      } catch {}
    }
  };
  const beginMediaObservation = () => {
    muteMedia();
    if (!document.documentElement || !globalThis.MutationObserver) return;
    const observer = new MutationObserver(muteMedia);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["autoplay", "muted", "src", "srcObject", "volume"],
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", beginMediaObservation, {
      once: true,
    });
  } else {
    beginMediaObservation();
  }

  const audioNodePrototype = globalThis.AudioNode?.prototype;
  const audioDestinationConstructor = globalThis.AudioDestinationNode;
  if (audioNodePrototype?.connect && audioDestinationConstructor) {
    const nativeConnect = audioNodePrototype.connect;
    const silentConnect = function (destination, ...args) {
      if (destination instanceof audioDestinationConstructor) {
        audit.webAudioDestinationAttempts += 1;
        return destination;
      }
      return nativeConnect.call(this, destination, ...args);
    };
    patchMethod(audioNodePrototype, "connect", silentConnect, "audio-connect");
  }
  for (const constructor of new Set([
    globalThis.AudioContext,
    globalThis.webkitAudioContext,
  ])) {
    if (constructor?.prototype?.setSinkId) {
      patchMethod(
        constructor.prototype,
        "setSinkId",
        async () => {
          audit.blockedAudioOutputSelectionAttempts += 1;
          throw new DOMException(
            "Web Audio output selection is disabled in silent probes",
            "NotAllowedError",
          );
        },
        "audio-context-set-sink-id",
      );
    }
  }

  try {
    globalThis.speechSynthesis?.cancel();
  } catch {}
  const speechPrototype = globalThis.SpeechSynthesis?.prototype;
  const silentSpeak = () => {
    audit.speechAttempts += 1;
  };
  if (speechPrototype?.speak) {
    patchMethod(speechPrototype, "speak", silentSpeak, "speech-speak");
  }
  if (globalThis.speechSynthesis?.speak) {
    try {
      defineImmutable(globalThis.speechSynthesis, "speak", silentSpeak);
    } catch (error) {
      recordError("speech-object-speak", error);
    }
  }

  const NativeNotification = globalThis.Notification;
  if (typeof NativeNotification === "function") {
    const SilentNotification = function () {
      audit.notificationAttempts += 1;
      throw new DOMException(
        "Notifications are disabled in silent browser probes",
        "NotAllowedError",
      );
    };
    Object.defineProperties(SilentNotification, {
      permission: { configurable: false, get: () => "denied" },
      requestPermission: {
        configurable: false,
        value: async () => {
          audit.notificationAttempts += 1;
          return "denied";
        },
      },
    });
    try {
      defineImmutable(globalThis, "Notification", SilentNotification);
      guards.notification = {
        target: globalThis,
        key: "Notification",
        value: SilentNotification,
      };
    } catch (error) {
      recordError("notification", error);
    }
  }
  const serviceWorkerPrototype = globalThis.ServiceWorkerRegistration?.prototype;
  if (serviceWorkerPrototype?.showNotification) {
    patchMethod(
      serviceWorkerPrototype,
      "showNotification",
      async () => {
        audit.notificationAttempts += 1;
        throw new DOMException(
          "Notifications are disabled in silent browser probes",
          "NotAllowedError",
        );
      },
      "service-worker-notification",
    );
  }

  let silentAudio = null;
  const markZeroAudioTrack = (track) => {
    try {
      defineImmutable(track, "__conclaveSyntheticZeroAudio", true);
    } catch {}
    return track;
  };
  const createZeroAudioTrack = () => {
    if (silentAudio?.track?.readyState === "live") {
      audit.syntheticAudioTrackCount += 1;
      return markZeroAudioTrack(silentAudio.track.clone());
    }
    const AudioContextConstructor =
      globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new DOMException("Zero audio fixture is unavailable", "NotFoundError");
    }
    const context = new AudioContextConstructor({ sampleRate: 48_000 });
    const source = context.createConstantSource();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    source.offset.value = 0;
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(destination);
    source.start();
    void context.resume().catch(() => {});
    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      try {
        source.stop();
      } catch {}
      void context.close().catch(() => {});
      throw new DOMException("Zero audio fixture is unavailable", "NotFoundError");
    }
    markZeroAudioTrack(track);
    silentAudio = { context, source, gain, destination, track };
    audit.syntheticAudioTrackCount += 1;
    return markZeroAudioTrack(track.clone());
  };

  const createSyntheticDisplayStream = (options = {}) => {
    audit.syntheticDisplayCaptureCalls += 1;
    const canvas = document.createElement("canvas");
    canvas.width = 1920;
    canvas.height = 1080;
    const context = canvas.getContext("2d", { alpha: false });
    const requested = options?.video?.frameRate;
    const requestedFrameRate = Math.max(
      1,
      Math.min(
        30,
        Number(
          typeof requested === "number"
            ? requested
            : requested?.max ?? requested?.ideal ?? 15,
        ) || 15,
      ),
    );
    let frame = 0;
    const paint = () => {
      if (!context) return;
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
      context.fillText(
        "Small text should remain readable at low bandwidth.",
        80,
        235,
      );
      context.font = "500 32px ui-monospace, monospace";
      context.fillText(`Frame ${String(frame).padStart(5, "0")}`, 80, 320);
      context.fillStyle = "#2563eb";
      context.fillRect(80 + ((frame * 18) % 1200), 390, 260, 140);
      context.fillStyle = "#16a34a";
      context.fillRect(80, 610, 360, 180);
      context.fillStyle = "#dc2626";
      context.fillRect(520, 610, 360, 180);
      context.fillStyle = "#ca8a04";
      context.fillRect(960, 610, 360, 180);
      frame += 1;
    };
    paint();
    const timer = setInterval(
      paint,
      Math.max(16, Math.round(1000 / requestedFrameRate)),
    );
    const stream = canvas.captureStream(requestedFrameRate);
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      clearInterval(timer);
      throw new DOMException("Synthetic display is unavailable", "NotFoundError");
    }
    try {
      videoTrack.contentHint = "detail";
      defineImmutable(videoTrack, "__conclaveSyntheticDisplay", true);
    } catch {}
    if (options?.audio) stream.addTrack(createZeroAudioTrack());
    const nativeStop = videoTrack.stop.bind(videoTrack);
    let stopped = false;
    videoTrack.stop = () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        for (const track of stream.getAudioTracks()) track.stop();
      }
      nativeStop();
    };
    return stream;
  };

  const mediaDevicesPrototype = globalThis.MediaDevices?.prototype;
  const originalGetUserMedia = mediaDevicesPrototype?.getUserMedia;
  const hasTrustedQualityFixture = config.trustedBootstrapAttestations.some(
    ({ name }) => name === "quality-browser-fixture",
  );
  const trustedQualityFixtureApi = hasTrustedQualityFixture
    ? globalThis.__conclaveQualityHarness
    : null;
  const trustedQualityFixtureGetConfig =
    trustedQualityFixtureApi?.getConfig;
  const trustedQualityFixtureGetMediaCaptureAudit =
    trustedQualityFixtureApi?.getMediaCaptureAudit;
  if (hasTrustedQualityFixture) {
    if (
      !trustedQualityFixtureApi ||
      !Object.isFrozen(trustedQualityFixtureApi) ||
      typeof trustedQualityFixtureGetConfig !== "function" ||
      typeof trustedQualityFixtureGetMediaCaptureAudit !== "function"
    ) {
      recordError(
        "quality-fixture-api",
        new Error("Trusted quality fixture API is missing or mutable"),
      );
    } else {
      guards["quality-fixture-api"] = {
        isIntact: () =>
          globalThis.__conclaveQualityHarness === trustedQualityFixtureApi &&
          Object.isFrozen(trustedQualityFixtureApi) &&
          trustedQualityFixtureApi.getConfig ===
            trustedQualityFixtureGetConfig &&
          trustedQualityFixtureApi.getMediaCaptureAudit ===
            trustedQualityFixtureGetMediaCaptureAudit,
      };
    }
  }
  if (typeof originalGetUserMedia === "function") {
    const syntheticGetUserMedia = async function (constraints = {}) {
      const wantsAudio = Boolean(constraints?.audio);
      const wantsVideo = Boolean(constraints?.video);
      if (!wantsAudio && !wantsVideo) {
        throw new DOMException("Media constraints are empty", "TypeError");
      }
      if (
        wantsVideo &&
        config.denySyntheticVideoWhenUrlIncludes &&
        globalThis.location?.href?.includes(
          config.denySyntheticVideoWhenUrlIncludes,
        )
      ) {
        audit.blockedVideoCaptureAttempts += 1;
        throw new DOMException(
          "Synthetic camera denied by probe configuration",
          "NotAllowedError",
        );
      }
      const trustedFixtureConfig = hasTrustedQualityFixture
        ? trustedQualityFixtureGetConfig?.call(trustedQualityFixtureApi)
        : null;
      if (
        wantsVideo &&
        hasTrustedQualityFixture &&
        trustedFixtureConfig?.enableSyntheticCamera !== true
      ) {
        audit.blockedVideoCaptureAttempts += 1;
        throw new DOMException(
          "The approved fixture did not enable its synthetic camera",
          "NotAllowedError",
        );
      }
      if (
        wantsAudio &&
        hasTrustedQualityFixture &&
        trustedFixtureConfig?.enableSyntheticAudio !== true
      ) {
        audit.blockedAudioCaptureAttempts += 1;
        throw new DOMException(
          "The approved fixture did not enable zero audio",
          "NotAllowedError",
        );
      }
      const stream =
        hasTrustedQualityFixture && (wantsVideo || wantsAudio)
          ? await originalGetUserMedia.call(this, constraints)
          : wantsVideo
            ? await originalGetUserMedia.call(this, {
                ...constraints,
                audio: false,
              })
            : new MediaStream();
      if (
        hasTrustedQualityFixture &&
        (wantsVideo || wantsAudio) &&
        stream.__conclaveQualitySynthetic !== true
      ) {
        for (const track of stream.getTracks()) track.stop();
        throw new DOMException(
          "Approved synthetic fixture attestation failed",
          "SecurityError",
        );
      }
      if (wantsVideo) {
        audit.syntheticVideoCaptureCalls += 1;
        if (stream.getVideoTracks().length === 0) {
          throw new DOMException(
            "Synthetic video did not return a track",
            "SecurityError",
          );
        }
      }
      const returnedAudioTracks = stream.getAudioTracks();
      if (!wantsAudio && returnedAudioTracks.length > 0) {
        for (const track of returnedAudioTracks) track.stop();
        throw new DOMException(
          "Synthetic video unexpectedly returned audio",
          "SecurityError",
        );
      }
      if (wantsAudio && hasTrustedQualityFixture) {
        if (
          stream.__conclaveQualitySynthetic !== true ||
          returnedAudioTracks.length !== 1
        ) {
          throw new DOMException(
            "Approved zero-audio fixture attestation failed",
            "SecurityError",
          );
        }
        for (const track of returnedAudioTracks) {
          markZeroAudioTrack(track);
        }
        audit.syntheticAudioTrackCount += returnedAudioTracks.length;
      } else if (wantsAudio) {
        stream.addTrack(createZeroAudioTrack());
      }
      try {
        defineImmutable(stream, "__conclaveSyntheticMedia", true);
      } catch {}
      return stream;
    };
    patchMethod(
      mediaDevicesPrototype,
      "getUserMedia",
      syntheticGetUserMedia,
      "get-user-media",
    );
  }

  const sanitizeDisplayDebugValue = (value, seen = new WeakSet(), depth = 0) => {
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "bigint") return String(value);
    if (typeof value !== "object") return undefined;
    if (seen.has(value)) return "[circular]";
    if (depth >= 6) return "[max-depth]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 50)
        .map((entry) => sanitizeDisplayDebugValue(entry, seen, depth + 1));
    }
    const sanitized = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      if (key.toLowerCase().includes("controller")) continue;
      try {
        const entry = sanitizeDisplayDebugValue(value[key], seen, depth + 1);
        if (entry !== undefined) sanitized[key] = entry;
      } catch {
        sanitized[key] = "[unavailable]";
      }
    }
    return sanitized;
  };
  const displayCalls = [];
  const syntheticOrDeniedDisplay = async (options = {}) => {
    displayCalls.push(sanitizeDisplayDebugValue(options));
    if (!config.syntheticDisplay) {
      audit.blockedDisplayCaptureAttempts += 1;
      throw new DOMException(
        "Display capture is disabled in this silent probe",
        "NotAllowedError",
      );
    }
    return createSyntheticDisplayStream(options);
  };
  for (const [key, label] of [
    ["getDisplayMedia", "get-display-media"],
    ["getViewportMedia", "get-viewport-media"],
    ["getAllScreensMedia", "get-all-screens-media"],
  ]) {
    if (typeof mediaDevicesPrototype?.[key] === "function") {
      patchMethod(mediaDevicesPrototype, key, syntheticOrDeniedDisplay, label);
    }
  }
  if (typeof mediaDevicesPrototype?.selectAudioOutput === "function") {
    patchMethod(
      mediaDevicesPrototype,
      "selectAudioOutput",
      async () => {
        audit.blockedAudioCaptureAttempts += 1;
        throw new DOMException(
          "Audio output selection is disabled in silent probes",
          "NotAllowedError",
        );
      },
      "select-audio-output",
    );
  }

  const captureGuardsIntact = () => {
    if (!mediaDevicesPrototype) return true;
    if (
      typeof originalGetUserMedia === "function" &&
      guards["get-user-media"]?.target?.getUserMedia !==
        guards["get-user-media"]?.value
    ) {
      return false;
    }
    for (const [key, label] of [
      ["getDisplayMedia", "get-display-media"],
      ["getViewportMedia", "get-viewport-media"],
      ["getAllScreensMedia", "get-all-screens-media"],
      ["selectAudioOutput", "select-audio-output"],
    ]) {
      if (
        typeof mediaDevicesPrototype[key] === "function" &&
        guards[label]?.target?.[key] !== guards[label]?.value
      ) {
        return false;
      }
    }
    return true;
  };

  const legacyGetUserMedia = (constraints, success, failure) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      failure?.(new DOMException("Media devices unavailable", "NotFoundError"));
      return;
    }
    navigator.mediaDevices.getUserMedia(constraints).then(success, failure);
  };
  for (const key of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    if (key in navigator || key === "getUserMedia") {
      try {
        Object.defineProperty(navigator, key, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: legacyGetUserMedia,
        });
      } catch (error) {
        recordError(`legacy-${key}`, error);
      }
    }
  }

  try {
    defineImmutable(navigator.mediaDevices ?? {}, "__conclaveFakeDisplayMediaInstalled", true);
  } catch {}
  try {
    defineImmutable(globalThis, "__conclaveInstallFakeDisplayMedia", () => true);
    defineImmutable(globalThis, "__conclaveGetDisplayMediaDebug", () => ({
      callCount: displayCalls.length,
      calls: displayCalls.slice(-5),
      synthetic: config.syntheticDisplay,
    }));
  } catch (error) {
    recordError("display-debug-api", error);
  }

  const guardsIntact = () =>
    Object.values(guards).every(
      ({ target, key, value, isIntact }) =>
        isIntact ? isIntact() : target?.[key] === value,
    );
  const readTrustedQualityFixtureConfiguration = () => {
    if (!hasTrustedQualityFixture) return null;
    try {
      const fixtureConfig = trustedQualityFixtureGetConfig?.call(
        trustedQualityFixtureApi,
      );
      if (!fixtureConfig) return null;
      return {
        enableSyntheticCamera: fixtureConfig.enableSyntheticCamera === true,
        enableSyntheticAudio: fixtureConfig.enableSyntheticAudio === true,
        width: Number(fixtureConfig.width) || null,
        height: Number(fixtureConfig.height) || null,
        targetFps: Number(fixtureConfig.targetFps) || null,
      };
    } catch {
      return null;
    }
  };
  const readTrustedQualityFixtureCaptureAudit = () => {
    if (!hasTrustedQualityFixture) return null;
    try {
      const fixtureAudit = trustedQualityFixtureGetMediaCaptureAudit?.call(
        trustedQualityFixtureApi,
      );
      if (!fixtureAudit) return null;
      return {
        safe: fixtureAudit.safe === true,
        nativeAudioCallCount:
          Number(fixtureAudit.nativeAudioCallCount) || 0,
        nativeVideoCallCount:
          Number(fixtureAudit.nativeVideoCallCount) || 0,
      };
    } catch {
      return null;
    }
  };
  const trustedQualityFixtureAttestation =
    config.trustedBootstrapAttestations.find(
      ({ name }) => name === "quality-browser-fixture",
    ) ?? null;
  const trustedBootstrapsIntact = (fixtureConfig) =>
    !hasTrustedQualityFixture ||
    (Boolean(globalThis.__conclaveQualityHarness) &&
      fixtureConfig?.enableSyntheticCamera ===
        trustedQualityFixtureAttestation?.expectedPolicy
          ?.enableSyntheticCamera &&
      fixtureConfig?.enableSyntheticAudio ===
        trustedQualityFixtureAttestation?.expectedPolicy
          ?.enableSyntheticAudio);
  const snapshot = () => {
    const trustedQualityFixtureConfig =
      readTrustedQualityFixtureConfiguration();
    const trustedQualityFixtureCaptureAudit =
      readTrustedQualityFixtureCaptureAudit();
    const trustedSyntheticVideoConfigured =
      !hasTrustedQualityFixture ||
      trustedQualityFixtureConfig?.enableSyntheticCamera ===
        trustedQualityFixtureAttestation?.expectedPolicy
          ?.enableSyntheticCamera;
    const trustedSyntheticZeroAudioConfigured =
      !hasTrustedQualityFixture ||
      trustedQualityFixtureConfig?.enableSyntheticAudio === true;
    const trustedSyntheticVideoPolicy = !hasTrustedQualityFixture
      ? "browser-fake-device"
      : trustedQualityFixtureConfig?.enableSyntheticCamera === true
        ? "synthetic"
        : "disabled";
    const trustedBootstrapStateIntact = trustedBootstrapsIntact(
      trustedQualityFixtureConfig,
    );
    const trustedCaptureAuditIntact =
      !hasTrustedQualityFixture ||
      (trustedQualityFixtureCaptureAudit?.safe === true &&
        trustedQualityFixtureCaptureAudit.nativeAudioCallCount === 0);
    const mediaDevicesAvailable = Boolean(mediaDevicesPrototype);
    const nativeGetUserMediaAvailable =
      typeof originalGetUserMedia === "function";
    const getUserMediaGuardInstalled =
      nativeGetUserMediaAvailable &&
      guards["get-user-media"]?.target?.getUserMedia ===
        guards["get-user-media"]?.value;
    const nativeCaptureSurfaceState =
      mediaDevicesAvailable &&
      nativeGetUserMediaAvailable &&
      getUserMediaGuardInstalled
        ? "guarded"
        : !mediaDevicesAvailable &&
            !nativeGetUserMediaAvailable &&
            !getUserMediaGuardInstalled
          ? "absent"
          : "unsafe";
    return {
      version: config.version,
      fingerprint: config.fingerprint,
      installed: audit.installationErrors.length === 0,
      immutableGuardsIntact: guardsIntact(),
      captureGuardsIntact: captureGuardsIntact(),
      mediaDevicesAvailable,
      nativeGetUserMediaAvailable,
      getUserMediaGuardInstalled,
      nativeCaptureSurfaceState,
      trustedBootstrapAttestations: config.trustedBootstrapAttestations,
      trustedBootstrapsIntact: trustedBootstrapStateIntact,
      trustedQualityFixtureConfig,
      trustedQualityFixtureCaptureAudit,
      trustedCaptureAuditIntact,
      trustedSyntheticVideoConfigured,
      trustedSyntheticZeroAudioConfigured,
      trustedSyntheticVideoPolicy,
      audioCapturePolicy: "synthetic-zero-only",
      videoCapturePolicy: hasTrustedQualityFixture
        ? trustedSyntheticVideoPolicy
        : "browser-fake-device-only",
      displayCapturePolicy: config.syntheticDisplay
        ? "synthetic-canvas-only"
        : "denied",
      syntheticDisplayEnabled: config.syntheticDisplay,
      zeroAudioOnly: true,
      hardwareCaptureAllowed: false,
      ...audit,
      safe:
        audit.installationErrors.length === 0 &&
        guardsIntact() &&
        captureGuardsIntact() &&
        trustedBootstrapStateIntact &&
        trustedCaptureAuditIntact,
    };
  };
  const api = Object.freeze({
    version: config.version,
    fingerprint: config.fingerprint,
    snapshot,
  });
  defineImmutable(globalThis, GLOBAL, api);
}

const evaluateByValue = async (cdp, expression) => {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response?.exceptionDetails) {
    throw new Error(
      `Silent bootstrap evaluation failed: ${response.exceptionDetails.text ?? "unknown"}`,
    );
  }
  return response?.result?.value;
};

const assertBootstrapSnapshot = (
  snapshot,
  label,
  { allowAbsentNativeCaptureSurface = false } = {},
) => {
  const nativeCaptureSurfaceGuarded =
    snapshot?.mediaDevicesAvailable === true &&
    snapshot?.nativeGetUserMediaAvailable === true &&
    snapshot?.getUserMediaGuardInstalled === true &&
    snapshot?.nativeCaptureSurfaceState === "guarded";
  const nativeCaptureSurfaceAbsent =
    allowAbsentNativeCaptureSurface === true &&
    snapshot?.mediaDevicesAvailable === false &&
    snapshot?.nativeGetUserMediaAvailable === false &&
    snapshot?.getUserMediaGuardInstalled === false &&
    snapshot?.nativeCaptureSurfaceState === "absent";
  if (
    snapshot?.version !== SILENT_BROWSER_CONTRACT_VERSION ||
    snapshot?.fingerprint !== SILENT_BROWSER_FINGERPRINT ||
    snapshot?.installed !== true ||
    snapshot?.immutableGuardsIntact !== true ||
    snapshot?.captureGuardsIntact !== true ||
    (!nativeCaptureSurfaceGuarded && !nativeCaptureSurfaceAbsent) ||
    snapshot?.trustedBootstrapsIntact !== true ||
    snapshot?.trustedCaptureAuditIntact !== true ||
    snapshot?.trustedSyntheticVideoConfigured !== true ||
    snapshot?.trustedSyntheticZeroAudioConfigured !== true ||
    snapshot?.zeroAudioOnly !== true ||
    snapshot?.hardwareCaptureAllowed !== false ||
    snapshot?.safe !== true
  ) {
    throw new Error(
      `${label} silent bootstrap is missing or unsafe: ${JSON.stringify(snapshot)}`,
    );
  }
  return snapshot;
};

export async function verifySilentBrowserPage(
  cdp,
  label = "page",
  options = {},
) {
  const snapshot = await evaluateByValue(
    cdp,
    `globalThis.__conclaveSilentBrowserSafety?.snapshot?.() ?? null`,
  );
  return assertBootstrapSnapshot(snapshot, label, options);
}

export async function navigateSilentBrowserPage(
  session,
  { url, label = session?.label ?? "page", timeoutMs = 30_000 } = {},
) {
  const resources = sessionInternals.get(session);
  if (!resources?.pageCdp || !activeSessions.has(session)) {
    throw new Error("Navigation requires an active centrally owned browser page");
  }
  const parsedUrl = new URL(String(url));
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`Silent browser navigation forbids ${parsedUrl.protocol} URLs`);
  }
  const resolvedTimeoutMs = finitePositiveInteger(
    timeoutMs,
    30_000,
    "navigation timeoutMs",
  );
  const targetInfo = await resources.browserCdp.send("Target.getTargetInfo", {
    targetId: resources.pageTargetId,
  });
  if (
    targetInfo?.targetInfo?.targetId !== resources.pageTargetId ||
    targetInfo?.targetInfo?.type !== "page"
  ) {
    throw new Error(`${label} is not the centrally owned page target`);
  }
  const navigation = await resources.pageCdp.send("Page.navigate", {
    url: String(parsedUrl),
  });
  if (navigation?.errorText) {
    throw new Error(`${label} navigation failed: ${navigation.errorText}`);
  }
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < resolvedTimeoutMs) {
    try {
      const frameTree = await resources.pageCdp.send("Page.getFrameTree");
      const mainFrame = frameTree?.frameTree?.frame;
      if (
        !mainFrame ||
        mainFrame.url === "about:blank" ||
        (navigation?.loaderId && mainFrame.loaderId !== navigation.loaderId)
      ) {
        await sleep(25);
        continue;
      }
      return await verifySilentBrowserPage(resources.pageCdp, label);
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }
  throw new Error(
    `${label} did not re-establish the silent bootstrap after navigation: ${lastError?.message ?? "unknown"}`,
  );
}

export async function reloadSilentBrowserPage(
  session,
  {
    label = session?.label ?? "page reload",
    timeoutMs = 30_000,
    ignoreCache = true,
  } = {},
) {
  const resources = sessionInternals.get(session);
  if (!resources?.pageCdp || !activeSessions.has(session)) {
    throw new Error("Reload requires an active centrally owned browser page");
  }
  const resolvedTimeoutMs = finitePositiveInteger(
    timeoutMs,
    30_000,
    "reload timeoutMs",
  );
  const before = await resources.pageCdp.send("Page.getFrameTree");
  const previousLoaderId = before?.frameTree?.frame?.loaderId ?? null;
  await resources.pageCdp.send("Page.reload", { ignoreCache: Boolean(ignoreCache) });
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < resolvedTimeoutMs) {
    try {
      const frameTree = await resources.pageCdp.send("Page.getFrameTree");
      const mainFrame = frameTree?.frameTree?.frame;
      if (
        !mainFrame ||
        mainFrame.url === "about:blank" ||
        (previousLoaderId && mainFrame.loaderId === previousLoaderId)
      ) {
        await sleep(25);
        continue;
      }
      return await verifySilentBrowserPage(resources.pageCdp, label);
    } catch (error) {
      lastError = error;
      await sleep(25);
    }
  }
  throw new Error(
    `${label} did not re-establish the silent bootstrap after reload: ${lastError?.message ?? "unknown"}`,
  );
}

const isProcessTargetAlive = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
};

const processTargetFor = (child) =>
  process.platform === "win32" ? child.pid : -child.pid;

const waitForProcessDeath = async (
  target,
  timeoutMs,
  {
    isAliveImpl = isProcessTargetAlive,
    sleepImpl = sleep,
    nowImpl = Date.now,
  } = {},
) => {
  const startedAt = nowImpl();
  while (nowImpl() - startedAt < timeoutMs) {
    if (!isAliveImpl(target)) return true;
    await sleepImpl(25);
  }
  return !isAliveImpl(target);
};

const signalProcessTarget = (child, signal) => {
  const target = processTargetFor(child);
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};

export async function terminateSilentBrowserProcess(
  child,
  {
    gracefulTimeoutMs = 1_500,
    killTimeoutMs = 1_000,
    isAliveImpl = isProcessTargetAlive,
    signalImpl = signalProcessTarget,
    sleepImpl = sleep,
    nowImpl = Date.now,
  } = {},
) {
  if (!child?.pid) return { terminated: true, alreadyGone: true };
  const target = processTargetFor(child);
  if (!isAliveImpl(target)) {
    return { terminated: true, alreadyGone: true };
  }
  signalImpl(child, "SIGTERM");
  if (
    await waitForProcessDeath(target, gracefulTimeoutMs, {
      isAliveImpl,
      sleepImpl,
      nowImpl,
    })
  ) {
    return { terminated: true, signal: "SIGTERM" };
  }
  signalImpl(child, "SIGKILL");
  if (
    await waitForProcessDeath(target, killTimeoutMs, {
      isAliveImpl,
      sleepImpl,
      nowImpl,
    })
  ) {
    return { terminated: true, signal: "SIGKILL" };
  }
  throw new Error(`Chrome process group ${target} survived SIGKILL`);
}

const removeSilentBrowserProfile = (userDataDir) => {
  rmSync(userDataDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
};

export async function cleanupSilentBrowserProcessAndProfile({
  child,
  userDataDir,
  terminateImpl = terminateSilentBrowserProcess,
  removeProfileImpl = removeSilentBrowserProfile,
} = {}) {
  const failures = [];
  let processTerminated = false;
  let profileRemoved = !userDataDir;
  try {
    const termination = await terminateImpl(child);
    processTerminated = termination?.terminated === true;
    if (!processTerminated) {
      failures.push(new Error("Chrome process death was not proven"));
    }
  } catch (error) {
    failures.push(error);
  }
  if (userDataDir && processTerminated) {
    try {
      removeProfileImpl(userDataDir);
      profileRemoved = true;
    } catch (error) {
      failures.push(error);
    }
  } else if (userDataDir) {
    failures.push(
      new Error(
        `Retained Chrome profile because process death was not proven: ${userDataDir}`,
      ),
    );
  }
  const result = { processTerminated, profileRemoved };
  if (failures.length > 0) {
    const error = new AggregateError(
      failures,
      "Failed to prove silent-browser process and profile cleanup",
    );
    error.result = result;
    throw error;
  }
  return result;
}

const cleanupSessionResources = async (session) => {
  const resources = sessionInternals.get(session);
  if (!resources) {
    throw new Error("Cannot close a browser outside the central silent authority");
  }
  if (!activeSessions.has(session)) {
    if (resources.cleanupResult) return resources.cleanupResult;
    throw new Error("Silent browser ownership is inactive and unproven");
  }
  const label = resources.label ?? "silent browser";
  const failures = [];
  let finalAttestation = resources.finalAttestation ?? null;
  if (!finalAttestation && resources.pageCdp && resources.bootstrap) {
    try {
      const snapshot = await verifySilentBrowserPage(
        resources.pageCdp,
        `${label} final`,
      );
      finalAttestation = { ok: true, snapshot };
    } catch (error) {
      finalAttestation = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(error);
    }
    resources.finalAttestation = finalAttestation;
  }
  try {
    if (resources.networkSessionId) {
      await resources.browserCdp?.send(
        "Target.detachFromTarget",
        { sessionId: resources.networkSessionId },
        1_000,
      );
    }
  } catch {}
  try {
    await resources.browserCdp?.send("Browser.close", {}, 1_000);
  } catch {}
  try {
    resources.pageCdp?.close();
  } catch {}
  try {
    resources.browserCdp?.close();
  } catch {}
  let processTerminated = resources.processTerminated === true;
  let profileRemoved =
    resources.profileRemoved === true || !resources.userDataDir;
  try {
    const processCleanup = await cleanupSilentBrowserProcessAndProfile({
      child: resources.chrome,
      userDataDir: profileRemoved ? null : resources.userDataDir,
      terminateImpl: processTerminated
        ? async () => ({ terminated: true, alreadyGone: true })
        : terminateSilentBrowserProcess,
    });
    processTerminated =
      processTerminated || processCleanup.processTerminated;
    profileRemoved = profileRemoved || processCleanup.profileRemoved;
  } catch (error) {
    processTerminated =
      processTerminated || error?.result?.processTerminated === true;
    profileRemoved = profileRemoved || error?.result?.profileRemoved === true;
    failures.push(...(error instanceof AggregateError ? error.errors : [error]));
  }
  resources.processTerminated = processTerminated;
  resources.profileRemoved = profileRemoved;
  const cleanupAuthorityRetained = !(processTerminated && profileRemoved);
  if (!cleanupAuthorityRetained) {
    activeSessions.delete(session);
  }
  const result = {
    label,
    finalAttestation,
    processTerminated,
    profileRemoved,
    cleanupAuthorityRetained,
  };
  if (!cleanupAuthorityRetained) resources.cleanupResult = result;
  if (failures.length > 0) {
    const error = new AggregateError(failures, `Failed to close ${label}`);
    error.result = result;
    throw error;
  }
  return result;
};

export async function closeSilentBrowser(session) {
  if (!session) return;
  const resources = sessionInternals.get(session);
  if (!resources) {
    throw new Error("Cannot close a browser outside the central silent authority");
  }
  if (resources.cleanupResult) return resources.cleanupResult;
  if (!resources.closePromise) {
    resources.closePromise = cleanupSessionResources(session).catch((error) => {
      if (error?.result?.cleanupAuthorityRetained === true) {
        resources.closePromise = null;
      }
      throw error;
    });
  }
  return resources.closePromise;
}

export async function closeSilentBrowsers(sessions) {
  const unique = Array.from(new Set((sessions ?? []).filter(Boolean)));
  const results = await Promise.allSettled(unique.map(closeSilentBrowser));
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more silent browsers failed cleanup");
  }
  return results.map((result) => result.value);
}

export async function attemptEmergencySilentBrowserCleanup({
  attempts = 3,
  getSessionsImpl = () => Array.from(activeSessions),
  closeImpl = closeSilentBrowsers,
  terminationProvenImpl = (sessions) =>
    sessions.every((session) => {
      if (!activeSessions.has(session)) return true;
      return sessionInternals.get(session)?.processTerminated === true;
    }),
} = {}) {
  const resolvedAttempts = finitePositiveInteger(
    attempts,
    3,
    "cleanup attempts",
  );
  let lastError = null;
  for (let attempt = 1; attempt <= resolvedAttempts; attempt += 1) {
    const sessions = Array.from(getSessionsImpl()).filter(Boolean);
    if (sessions.length === 0) {
      return { safeToExit: true, attempts: attempt - 1, lastError };
    }
    try {
      await closeImpl(sessions);
    } catch (error) {
      lastError = error;
    }
    if (terminationProvenImpl(sessions)) {
      return { safeToExit: true, attempts: attempt, lastError };
    }
  }
  return {
    safeToExit: false,
    attempts: resolvedAttempts,
    lastError,
  };
}

const signalExitCode = (signal) =>
  signal === "SIGINT"
    ? 130
    : signal === "SIGHUP"
      ? 129
      : signal === "SIGQUIT"
        ? 131
        : 143;

const retainCleanupAuthority = () => {
  if (cleanupAuthorityHold) return;
  cleanupAuthorityHold = setInterval(() => {}, 60_000);
};

const releaseCleanupAuthority = () => {
  if (!cleanupAuthorityHold) return;
  clearInterval(cleanupAuthorityHold);
  cleanupAuthorityHold = null;
};

const cleanupForSignal = async (signal) => {
  if (signalCleanupPromise) return signalCleanupPromise;
  signalCleanupPromise = (async () => {
    const outcome = await attemptEmergencySilentBrowserCleanup();
    const exitCode = signalExitCode(signal);
    if (outcome.lastError) {
      process.stderr.write(
        `[silent-browser] cleanup warning after ${outcome.attempts} attempt(s): ${outcome.lastError.message}\n`,
      );
    }
    if (outcome.safeToExit) {
      releaseCleanupAuthority();
      process.exit(exitCode);
    }
    process.exitCode = exitCode;
    retainCleanupAuthority();
    process.stderr.write(
      "[silent-browser] refusing to exit: Chrome process death is unproven; cleanup authority is retained. Send the signal again to retry.\n",
    );
  })().finally(() => {
    signalCleanupPromise = null;
  });
  return signalCleanupPromise;
};

const cleanupForFatalError = async (kind, reason) => {
  if (fatalCleanupPromise) return fatalCleanupPromise;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  fatalCleanupPromise = (async () => {
    process.stderr.write(
      `[silent-browser] ${kind}: ${error.stack ?? error.message}\n`,
    );
    const outcome = await attemptEmergencySilentBrowserCleanup();
    if (outcome.safeToExit) {
      releaseCleanupAuthority();
      process.exit(1);
    }
    process.exitCode = 1;
    retainCleanupAuthority();
    process.stderr.write(
      "[silent-browser] refusing fatal exit: Chrome process death is unproven; cleanup authority is retained. Send SIGTERM again to retry.\n",
    );
  })().finally(() => {
    fatalCleanupPromise = null;
  });
  return fatalCleanupPromise;
};

const killUnprovenChromeOnProcessExit = () => {
  for (const session of activeSessions) {
    const resources = sessionInternals.get(session);
    if (resources?.processTerminated === true || !resources?.chrome?.pid) {
      continue;
    }
    try {
      const target = processTargetFor(resources.chrome);
      if (isProcessTargetAlive(target)) {
        signalProcessTarget(resources.chrome, "SIGKILL");
      }
    } catch {}
  }
};

const installSignalGuards = () => {
  if (signalGuardsInstalled) return;
  signalGuardsInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.on(signal, () => {
      void cleanupForSignal(signal).catch((error) => {
        process.exitCode = signalExitCode(signal);
        retainCleanupAuthority();
        process.stderr.write(
          `[silent-browser] signal cleanup failed without a process-death proof: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    });
  }
  process.on("uncaughtException", (error, origin) => {
    void cleanupForFatalError(`uncaught exception (${origin})`, error);
  });
  process.on("unhandledRejection", (reason) => {
    void cleanupForFatalError("unhandled rejection", reason);
  });
  process.on("exit", killUnprovenChromeOnProcessExit);
};

export async function launchSilentBrowser({
  chromePath,
  label = "browser",
  windowSize = "1440,900",
  syntheticVideoFilePath = null,
  syntheticDisplay = false,
  denySyntheticVideoWhenUrlIncludes = null,
  trustedPreSafetyBootstraps = [],
  timeoutMs = 30_000,
  spawnImpl = spawn,
} = {}) {
  if (typeof chromePath !== "string" || !chromePath) {
    throw new TypeError("chromePath is required");
  }
  if (!existsSync(chromePath)) {
    throw new Error(`Chrome does not exist at ${chromePath}`);
  }
  const resolvedTimeoutMs = finitePositiveInteger(
    timeoutMs,
    30_000,
    "timeoutMs",
  );
  const approvedBootstraps = normalizeTrustedPreSafetyBootstraps(
    trustedPreSafetyBootstraps,
  );
  const trustedBootstrapAttestations = Object.freeze(
    approvedBootstraps.map(({ name, sha256, expectedPolicy }) =>
      Object.freeze({
        name,
        sha256,
        expectedPolicy,
      }),
    ),
  );
  const bootstrapSource = buildSilentPageBootstrap({
    syntheticDisplay,
    denySyntheticVideoWhenUrlIncludes,
    trustedBootstrapAttestations,
  });
  const normalizedWindowSize = normalizeWindowSize(windowSize);
  const normalizedSyntheticVideoPath = normalizeSyntheticVideoPath(
    syntheticVideoFilePath,
  );
  const userDataDir = mkdtempSync(
    join(tmpdir(), "conclave-silent-browser-"),
  );
  const childState = {
    exited: false,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  const resources = {
    label,
    chrome: null,
    port: null,
    userDataDir,
    plan: null,
    silentAudioFixture: null,
    bootstrapSource,
    browserCdp: null,
    pageCdp: null,
    pageTargetId: null,
    networkSessionId: null,
    authority: null,
    bootstrap: null,
    pageFacade: null,
    systemFacade: null,
    networkFacade: null,
    networkIdentity: null,
    finalAttestation: null,
    closePromise: null,
    cleanupResult: null,
    processTerminated: false,
    profileRemoved: false,
  };
  const session = createSilentBrowserSessionFacade(resources, {
    label,
    trustedBootstrapAttestations,
  });
  sessionInternals.set(session, resources);
  activeSessions.add(session);
  installSignalGuards();
  let chrome = null;
  let plan = null;
  let browserCdp = null;
  let pageCdp = null;
  try {
    resources.silentAudioFixture = createOwnedSilentAudioFixture(userDataDir);
    plan = buildSilentBrowserLaunchPlan({
      userDataDir,
      windowSize: normalizedWindowSize,
      silentAudioFilePath: resources.silentAudioFixture.path,
      syntheticVideoFilePath: normalizedSyntheticVideoPath,
    });
    resources.plan = plan;
    chrome = spawnImpl(chromePath, plan.args, {
      detached: process.platform !== "win32",
      stdio: plan.stdio,
    });
    resources.chrome = chrome;
    chrome.once("error", (error) => {
      childState.spawnError = error;
    });
    chrome.once("exit", (code, signal) => {
      childState.exited = true;
      childState.exitCode = code;
      childState.signal = signal;
    });

    const { port, browserPath } = await readDevToolsActivePort(userDataDir, {
      timeoutMs: resolvedTimeoutMs,
      childState,
    });
    resources.port = port;
    const browserWebSocketUrl = `ws://127.0.0.1:${port}${browserPath}`;
    browserCdp = new SilentCdpClient(browserWebSocketUrl);
    resources.browserCdp = browserCdp;
    await browserCdp.open();
    const authority = await verifySilentBrowserAuthority({
      browserCdp,
      childPid: chrome.pid,
      plan,
    });
    resources.authority = Object.freeze({
      ...authority,
      runningArguments: Object.freeze([...authority.runningArguments]),
    });
    for (const { name, setting } of SILENT_BROWSER_PERMISSION_OVERRIDES) {
      await browserCdp.send("Browser.setPermission", {
        permission: { name },
        setting,
      });
    }
    const targets = await fetchJson(
      `http://127.0.0.1:${port}/json/list`,
      `${label} owned page target`,
      resolvedTimeoutMs,
    );
    const pages = targets.filter((target) => target.type === "page");
    if (pages.length !== 1 || pages[0]?.url !== "about:blank") {
      throw new Error(
        `${label} did not expose exactly one owned about:blank page`,
      );
    }
    const pageTarget = pages[0];
    resources.pageTargetId = pageTarget.id;
    const networkAttachment = await browserCdp.send("Target.attachToTarget", {
      targetId: pageTarget.id,
      flatten: true,
    });
    if (typeof networkAttachment?.sessionId !== "string") {
      throw new Error(`${label} did not establish an exact page network session`);
    }
    resources.networkSessionId = networkAttachment.sessionId;
    pageCdp = new ExactTargetCdpChannel(browserCdp, {
      targetId: pageTarget.id,
      sessionId: networkAttachment.sessionId,
    });
    resources.pageCdp = pageCdp;
    await pageCdp.send("Runtime.enable");
    await pageCdp.send("Page.enable");
    for (const trustedBootstrap of approvedBootstraps) {
      await pageCdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: trustedBootstrap.source,
      });
      await evaluateByValue(pageCdp, trustedBootstrap.source);
    }
    await pageCdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: bootstrapSource,
    });
    await evaluateByValue(pageCdp, bootstrapSource);
    const bootstrap = await verifySilentBrowserPage(
      pageCdp,
      `${label} about:blank`,
      { allowAbsentNativeCaptureSurface: true },
    );

    resources.bootstrap = Object.freeze({ ...bootstrap });
    resources.pageFacade = createSilentPageFacade(pageCdp);
    resources.systemFacade = createReadOnlySystemFacade(browserCdp);
    resources.networkIdentity = Object.freeze({
      targetId: pageTarget.id,
      sessionId: networkAttachment.sessionId,
    });
    resources.networkFacade = createExactTargetNetworkFacade(
      browserCdp,
      resources.networkIdentity,
    );
    return session;
  } catch (error) {
    try {
      await closeSilentBrowser(session);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to launch and clean up ${label}`,
      );
    }
    throw error;
  }
}
