import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  assertSilentBrowserLaunchPlan,
  attemptEmergencySilentBrowserCleanup,
  buildSilentBrowserLaunchPlan,
  buildOwnedSilentAudioWav,
  buildSilentPageBootstrap,
  cleanupSilentBrowserProcessAndProfile,
  closeSilentBrowser,
  createBoundedSilentCdpLogStore,
  createExactTargetNetworkFacade,
  createOwnedSilentAudioFixture,
  createReadOnlySystemFacade,
  createSilentBrowserSessionFacade,
  createSilentPageFacade,
  createTrustedQualityFixtureBootstrap,
  dispatchSilentCdpListeners,
  ExactTargetCdpChannel,
  SILENT_BROWSER_PERMISSION_OVERRIDES,
  terminateSilentBrowserProcess,
  validateOwnedSilentAudioFixture,
  verifySilentBrowserAuthority,
  verifySilentBrowserPage,
} from "./silent-browser-contract.mjs";

const ownedProfile = mkdtempSync(
  join(tmpdir(), "conclave-silent-browser-contract-test-"),
);
const silentAudioFixture = createOwnedSilentAudioFixture(ownedProfile);
test.after(() => {
  rmSync(ownedProfile, { recursive: true, force: true });
});
const makePlan = () =>
  buildSilentBrowserLaunchPlan({
    userDataDir: ownedProfile,
    silentAudioFilePath: silentAudioFixture.path,
    windowSize: "1440,900",
  });
const mutatePlan = (plan, mutate) => {
  const copy = {
    ...plan,
    args: [...plan.args],
    stdio: [...plan.stdio],
  };
  mutate(copy);
  return copy;
};

test("owned fake microphone input is a validated all-zero PCM WAV", () => {
  const bytes = buildOwnedSilentAudioWav();
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(24), 48_000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.subarray(44).every((byte) => byte === 0), true);
  assert.deepEqual(validateOwnedSilentAudioFixture(
    silentAudioFixture.path,
    ownedProfile,
  ), {
    path: silentAudioFixture.path,
    sampleRate: 48_000,
    channels: 1,
    bitsPerSample: 16,
    dataBytes: 96_000,
    zeroPcm: true,
  });

  const corruptProfile = mkdtempSync(
    join(tmpdir(), "conclave-silent-browser-corrupt-audio-"),
  );
  try {
    const corruptFixture = createOwnedSilentAudioFixture(corruptProfile);
    const corruptBytes = readFileSync(corruptFixture.path);
    corruptBytes[44] = 1;
    writeFileSync(corruptFixture.path, corruptBytes);
    assert.throws(
      () =>
        validateOwnedSilentAudioFixture(
          corruptFixture.path,
          corruptProfile,
        ),
      /non-zero PCM samples/,
    );
  } finally {
    rmSync(corruptProfile, { recursive: true, force: true });
  }
});

test("launch plan is exact-headless, isolated, synthetic, and fully ignored", () => {
  const plan = makePlan();
  assert.equal(assertSilentBrowserLaunchPlan(plan), true);
  assert.deepEqual(plan.stdio, ["ignore", "ignore", "ignore"]);
  assert.equal(plan.args.at(-1), "about:blank");
  assert.equal(
    plan.args.filter((argument) => argument === "--headless=new").length,
    1,
  );
  assert.equal(
    plan.args.filter((argument) => argument === "--mute-audio").length,
    1,
  );
  assert.equal(
    plan.args.filter((argument) =>
      argument.startsWith("--use-file-for-fake-audio-capture="),
    ).length,
    1,
  );
  assert.equal(
    plan.args.includes(
      `--use-file-for-fake-audio-capture=${silentAudioFixture.path}`,
    ),
    true,
  );
});

test("permission overrides use current Permissions API descriptor names", () => {
  assert.deepEqual(SILENT_BROWSER_PERMISSION_OVERRIDES, [
    { name: "microphone", setting: "denied" },
    { name: "camera", setting: "granted" },
    { name: "display-capture", setting: "denied" },
    { name: "notifications", setting: "denied" },
  ]);
  assert.equal(Object.isFrozen(SILENT_BROWSER_PERMISSION_OVERRIDES), true);
  assert.equal(
    SILENT_BROWSER_PERMISSION_OVERRIDES.every((entry) => Object.isFrozen(entry)),
    true,
  );
});

test("launch plan rejects adversarial visibility, attachment, capture, and stdio changes", () => {
  const plan = makePlan();
  const adversarialPlans = [
    mutatePlan(plan, (value) => {
      value.args[value.args.indexOf("--headless=new")] = "--headless=old";
    }),
    mutatePlan(plan, (value) => {
      value.args.splice(value.args.indexOf("--mute-audio"), 1);
    }),
    mutatePlan(plan, (value) => {
      value.args.splice(-1, 0, "https://example.test/");
    }),
    mutatePlan(plan, (value) => {
      value.args.push("--remote-debugging-port=9222");
    }),
    mutatePlan(plan, (value) => {
      value.args.splice(-1, 0, "--auto-select-desktop-capture-source=Screen 1");
    }),
    mutatePlan(plan, (value) => {
      value.args.splice(-1, 0, "--enable-usermedia-screen-capturing");
    }),
    mutatePlan(plan, (value) => {
      value.args.splice(-1, 0, "--use-file-for-fake-audio-capture=/tmp/tone.wav");
    }),
    mutatePlan(plan, (value) => {
      value.stdio[2] = "pipe";
    }),
    mutatePlan(plan, (value) => {
      value.userDataDir = "/tmp/not-owned";
    }),
  ];
  for (const candidate of adversarialPlans) {
    assert.throws(() => assertSilentBrowserLaunchPlan(candidate));
  }
});

const authorityCdp = ({ plan, pid = 4242, runningArguments = plan.args }) => ({
  async send(method) {
    if (method === "SystemInfo.getProcessInfo") {
      return { processInfo: [{ id: pid, type: "browser" }] };
    }
    if (method === "Browser.getBrowserCommandLine") {
      return { arguments: [...runningArguments] };
    }
    throw new Error(`Unexpected fake CDP method: ${method}`);
  },
});

test("authority proof binds exact spawned PID and running argv", async () => {
  const plan = makePlan();
  const authority = await verifySilentBrowserAuthority({
    browserCdp: authorityCdp({ plan }),
    childPid: 4242,
    plan,
  });
  assert.equal(authority.childPid, 4242);
  assert.equal(authority.exactHeadless, true);
  assert.equal(authority.zeroAudioInput, true);
  assert.equal(authority.silentAudioFixture.zeroPcm, true);

  await assert.rejects(
    verifySilentBrowserAuthority({
      browserCdp: authorityCdp({ plan, pid: 9001 }),
      childPid: 4242,
      plan,
    }),
    /not owned by spawned Chrome PID/,
  );
  await assert.rejects(
    verifySilentBrowserAuthority({
      browserCdp: authorityCdp({
        plan,
        runningArguments: plan.args.filter(
          (argument) => argument !== "--mute-audio",
        ),
      }),
      childPid: 4242,
      plan,
    }),
    /exact --mute-audio/,
  );
  await assert.rejects(
    verifySilentBrowserAuthority({
      browserCdp: authorityCdp({
        plan,
        runningArguments: plan.args.filter(
          (argument) =>
            !argument.startsWith("--use-file-for-fake-audio-capture="),
        ),
      }),
      childPid: 4242,
      plan,
    }),
    /isolated silent authority/,
  );
});

const createFakeCdpBus = () => {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    logs: createBoundedSilentCdpLogStore(100),
    emit(method, params = {}, sessionId = undefined) {
      for (const listener of listeners.get(method) ?? []) {
        listener(params, { method, params, sessionId });
      }
    },
    on(method, listener) {
      const entries = listeners.get(method) ?? [];
      entries.push(listener);
      listeners.set(method, entries);
    },
    async send(method, params = {}, timeoutMs, sessionId) {
      calls.push({ method, params, timeoutMs, sessionId });
      return { ok: true };
    },
  };
};

test("CDP listener exceptions are contained and recorded without skipping peers", async () => {
  const failures = [];
  let peerCalled = false;
  assert.doesNotThrow(() => {
    dispatchSilentCdpListeners(
      [
        () => {
          throw new Error("recorder failed");
        },
        () => {
          peerCalled = true;
        },
      ],
      { value: 1 },
      { method: "Network.loadingFinished" },
      (error) => failures.push(error),
    );
  });
  assert.equal(peerCalled, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /recorder failed/);

  dispatchSilentCdpListeners(
    [async () => {
      throw new Error("async recorder failed");
    }],
    {},
    { method: "Network.loadingFinished" },
    (error) => failures.push(error),
  );
  await Promise.resolve();
  assert.equal(failures.length, 2);
  assert.match(failures[1].message, /async recorder failed/);
});

test("page facade is main-world only and normalizes caller-owned parameters", async () => {
  const rawCdp = createFakeCdpBus();
  const page = createSilentPageFacade(rawCdp);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.logs), true);
  assert.equal("push" in page.logs, false);

  await page.send("Runtime.evaluate", {
    expression: "document.readyState",
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(rawCdp.calls[0].method, "Runtime.evaluate");
  assert.equal(rawCdp.calls[0].params.expression, "document.readyState");
  assert.equal(Object.getPrototypeOf(rawCdp.calls[0].params), null);

  await assert.rejects(page.send("Page.navigate", { url: "https://example.test" }));
  await assert.rejects(
    page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "globalThis.fixture = true",
      worldName: "unprotected-isolated-world",
    }),
    /outside the silent contract/,
  );
  await assert.rejects(
    page.send("Runtime.evaluate", {
      expression: "globalThis",
      contextId: 42,
    }),
    /outside the silent contract/,
  );

  const inheritedSerializer = Object.create({
    toJSON() {
      return { expression: "globalThis", contextId: 42 };
    },
  });
  inheritedSerializer.expression = "1 + 1";
  await assert.rejects(
    page.send("Runtime.evaluate", inheritedSerializer),
    /plain objects/,
  );

  let ownKeysCalls = 0;
  const alternatingKeys = new Proxy(
    { expression: "2 + 2", contextId: 42 },
    {
      ownKeys() {
        ownKeysCalls += 1;
        return ownKeysCalls === 1
          ? ["expression"]
          : ["expression", "contextId"];
      },
    },
  );
  await page.send("Runtime.evaluate", alternatingKeys);
  assert.equal("contextId" in rawCdp.calls.at(-1).params, false);
  assert.throws(
    () => page.on("Runtime.executionContextCreated", () => {}),
    /outside the silent contract/,
  );
});

test("system and exact-target network facades expose only read-only scoped methods", async () => {
  const rawCdp = createFakeCdpBus();
  const system = createReadOnlySystemFacade(rawCdp);
  assert.equal(Object.isFrozen(system), true);
  await system.send("Browser.getVersion");
  await assert.rejects(system.send("Browser.close"), /not available/);
  await assert.rejects(
    system.send("SystemInfo.getInfo", { unexpected: true }),
    /does not accept parameters/,
  );

  const network = createExactTargetNetworkFacade(rawCdp, {
    targetId: "target-1",
    sessionId: "session-1",
  });
  assert.equal(Object.isFrozen(network), true);
  assert.equal(network.targetId, "target-1");
  assert.equal(network.sessionId, "session-1");
  await network.send("Network.overrideNetworkState", {
    offline: false,
    latency: 25,
    downloadThroughput: 50_000,
    uploadThroughput: 25_000,
    connectionType: "cellular3g",
  });
  assert.equal(rawCdp.calls.at(-1).sessionId, "session-1");
  await assert.rejects(
    network.send("Network.emulateNetworkConditions", {}),
    /not available/,
  );
  await assert.rejects(
    network.send("Network.enable", { worldName: "escape" }),
    /outside the silent contract/,
  );

  let eventCount = 0;
  network.on("Network.loadingFinished", () => {
    eventCount += 1;
  });
  rawCdp.emit("Network.loadingFinished", {}, "different-session");
  rawCdp.emit("Network.loadingFinished", {}, "session-1");
  assert.equal(eventCount, 1);
  assert.throws(
    () => network.on("Runtime.executionContextCreated", () => {}),
    /not available/,
  );
});

test("one exact target channel scopes commands, events, and logs to its session", async () => {
  const rawCdp = createFakeCdpBus();
  const channel = new ExactTargetCdpChannel(rawCdp, {
    targetId: "target-1",
    sessionId: "session-1",
  });
  await channel.send("Runtime.enable");
  assert.equal(rawCdp.calls[0].sessionId, "session-1");

  let eventCount = 0;
  channel.on("Network.loadingFinished", () => {
    eventCount += 1;
  });
  rawCdp.emit("Network.loadingFinished", {}, "different-session");
  rawCdp.emit("Network.loadingFinished", {}, "session-1");
  rawCdp.emit(
    "Runtime.consoleAPICalled",
    { type: "log", args: [{ value: "wrong target" }] },
    "different-session",
  );
  rawCdp.emit(
    "Runtime.consoleAPICalled",
    { type: "log", args: [{ value: "owned target" }] },
    "session-1",
  );
  assert.equal(eventCount, 1);
  assert.equal(channel.logs.length, 1);
  assert.equal(channel.logs.slice(-1)[0].text, "owned target");
  channel.close();
  await assert.rejects(channel.send("Runtime.enable"), /closed/);
});

test("bounded CDP logs fail closed when retained history is incomplete", () => {
  const logs = createBoundedSilentCdpLogStore(3);
  assert.equal(Object.isFrozen(logs), true);
  logs.push({ text: "one" });
  logs.push({ text: "two" });
  logs.push({ text: "three" });
  logs.push({ text: "four" });
  assert.equal(logs.length, 4);
  assert.equal(logs.retainedLength, 3);
  assert.equal(logs.droppedEntries, 1);
  assert.equal(logs.truncated, true);
  assert.throws(() => {
    logs.maxEntries = Number.POSITIVE_INFINITY;
  }, TypeError);
  assert.deepEqual(
    logs.slice(-2).map((entry) => entry.text),
    ["three", "four"],
  );
  assert.equal(Object.isFrozen(logs.slice(-1)[0]), true);
  assert.throws(() => {
    logs.slice(-1)[0].text = "rewritten evidence";
  }, TypeError);
  assert.throws(() => logs.slice(0), /starts before retained history/);
  assert.throws(() => logs.filter(() => true), /logs are incomplete/);
  assert.throws(() => logs.some(() => false), /logs are incomplete/);
});

test("session facade is frozen and cannot spoof cleanup state", async () => {
  const cleanupPromise = Promise.resolve("caller must not control this");
  const resources = {
    authority: { exactHeadless: true },
    bootstrap: { safe: true },
    closePromise: cleanupPromise,
  };
  const session = createSilentBrowserSessionFacade(resources, {
    label: "fake owned session facade",
    trustedBootstrapAttestations: Object.freeze([]),
  });
  assert.equal(Object.isFrozen(session), true);
  assert.equal("closePromise" in session, false);
  assert.throws(() => {
    session.closePromise = Promise.resolve();
  }, TypeError);
  assert.throws(() => {
    session.bootstrap = null;
  }, TypeError);
  assert.equal(resources.closePromise, cleanupPromise);
  await assert.rejects(
    closeSilentBrowser({
      chrome: { pid: process.pid },
      userDataDir: "/tmp/conclave-silent-browser-unowned",
    }),
    /outside the central silent authority/,
  );
});

test("page verification fails closed when native media authority is absent", async () => {
  const safeSnapshot = {
    version: 1,
    fingerprint: "conclave-silent-browser-v1-headless-new-zero-audio",
    installed: true,
    immutableGuardsIntact: true,
    captureGuardsIntact: true,
    mediaDevicesAvailable: true,
    nativeGetUserMediaAvailable: true,
    getUserMediaGuardInstalled: true,
    nativeCaptureSurfaceState: "guarded",
    trustedBootstrapsIntact: true,
    trustedCaptureAuditIntact: true,
    trustedSyntheticVideoConfigured: true,
    trustedSyntheticZeroAudioConfigured: true,
    zeroAudioOnly: true,
    hardwareCaptureAllowed: false,
    safe: true,
  };
  const fakePage = (snapshot) => ({
    async send(method) {
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: snapshot } };
    },
  });
  assert.equal(
    await verifySilentBrowserPage(fakePage(safeSnapshot), "fake page"),
    safeSnapshot,
  );
  await assert.rejects(
    verifySilentBrowserPage(
      fakePage({ ...safeSnapshot, nativeGetUserMediaAvailable: false }),
      "missing native GUM",
    ),
    /missing or unsafe/,
  );
  await assert.rejects(
    verifySilentBrowserPage(
      fakePage({ ...safeSnapshot, getUserMediaGuardInstalled: false }),
      "missing immutable GUM guard",
    ),
    /missing or unsafe/,
  );
  const absentAboutBlankSnapshot = {
    ...safeSnapshot,
    mediaDevicesAvailable: false,
    nativeGetUserMediaAvailable: false,
    getUserMediaGuardInstalled: false,
    nativeCaptureSurfaceState: "absent",
  };
  await assert.rejects(
    verifySilentBrowserPage(
      fakePage(absentAboutBlankSnapshot),
      "ordinary page missing native GUM",
    ),
    /missing or unsafe/,
  );
  assert.equal(
    await verifySilentBrowserPage(
      fakePage(absentAboutBlankSnapshot),
      "initial about:blank",
      { allowAbsentNativeCaptureSurface: true },
    ),
    absentAboutBlankSnapshot,
  );
});

test("page bootstrap is immutable, zero-audio, and deny-or-synthetic capture only", () => {
  const source = buildSilentPageBootstrap({ syntheticDisplay: true });
  assert.match(source, /createConstantSource/);
  assert.match(source, /source\.offset\.value = 0/);
  assert.match(source, /gain\.gain\.value = 0/);
  assert.match(source, /AudioDestinationNode/);
  assert.match(source, /getDisplayMedia/);
  assert.match(source, /getViewportMedia/);
  assert.match(source, /getAllScreensMedia/);
  assert.match(source, /selectAudioOutput/);
  assert.match(source, /Notifications are disabled/);
  assert.match(source, /configurable: false/);
  assert.match(source, /nativeGetUserMediaAvailable/);
  assert.doesNotMatch(source, /createOscillator/);
});

test("bootstrap executes against fake browser APIs and returns only zero audio", async () => {
  class FakeTrack {
    constructor(kind) {
      this.kind = kind;
      this.readyState = "live";
    }

    clone() {
      return new FakeTrack(this.kind);
    }

    stop() {
      this.readyState = "ended";
    }
  }

  class FakeMediaStream {
    constructor(tracks = []) {
      this.tracks = [...tracks];
    }

    addTrack(track) {
      this.tracks.push(track);
    }

    getTracks() {
      return [...this.tracks];
    }

    getAudioTracks() {
      return this.tracks.filter((track) => track.kind === "audio");
    }

    getVideoTracks() {
      return this.tracks.filter((track) => track.kind === "video");
    }
  }

  let nativeConnectCount = 0;
  class FakeAudioNode {
    connect(destination) {
      nativeConnectCount += 1;
      return destination;
    }
  }
  class FakeAudioDestinationNode extends FakeAudioNode {}
  class FakeMediaStreamDestinationNode extends FakeAudioNode {
    constructor() {
      super();
      this.stream = new FakeMediaStream([new FakeTrack("audio")]);
    }
  }
  class FakeAudioContext {
    createConstantSource() {
      const node = new FakeAudioNode();
      node.offset = { value: 1 };
      node.start = () => {};
      node.stop = () => {};
      return node;
    }

    createGain() {
      const node = new FakeAudioNode();
      node.gain = { value: 1 };
      return node;
    }

    createMediaStreamDestination() {
      return new FakeMediaStreamDestinationNode();
    }

    resume() {
      return Promise.resolve();
    }

    close() {
      return Promise.resolve();
    }
  }

  const nativeConstraints = [];
  class FakeMediaDevices {
    async getUserMedia(constraints) {
      nativeConstraints.push(constraints);
      return new FakeMediaStream(
        constraints?.video ? [new FakeTrack("video")] : [],
      );
    }

    async getDisplayMedia() {
      throw new Error("native display capture must never run");
    }

    async selectAudioOutput() {
      throw new Error("native audio output selection must never run");
    }
  }
  class FakeMediaElement {
    constructor() {
      this.attributes = new Map();
      this.attributeMutationCount = 0;
    }

    play() {
      return Promise.resolve();
    }

    hasAttribute(name) {
      return this.attributes.has(name);
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
      this.attributeMutationCount += 1;
    }
  }
  class FakeSpeechSynthesis {
    speak() {}
  }
  const mediaElement = new FakeMediaElement();
  let mediaMutationObserverCallback = null;
  class FakeMutationObserver {
    constructor(callback) {
      mediaMutationObserverCallback = callback;
    }

    observe() {}
  }
  const context = {
    AudioContext: FakeAudioContext,
    AudioDestinationNode: FakeAudioDestinationNode,
    AudioNode: FakeAudioNode,
    DOMException,
    HTMLMediaElement: FakeMediaElement,
    MediaDevices: FakeMediaDevices,
    MediaStream: FakeMediaStream,
    MutationObserver: FakeMutationObserver,
    Notification: function Notification() {},
    ServiceWorkerRegistration: class ServiceWorkerRegistration {
      async showNotification() {}
    },
    SpeechSynthesis: FakeSpeechSynthesis,
    clearInterval,
    document: {
      addEventListener() {},
      createElement() {
        throw new Error("display fixture must not be created in deny mode");
      },
      documentElement: {},
      querySelectorAll: () => [mediaElement],
      readyState: "complete",
    },
    location: { href: "https://conclave.test/room" },
    navigator: { mediaDevices: new FakeMediaDevices() },
    setInterval,
    speechSynthesis: new FakeSpeechSynthesis(),
  };
  context.speechSynthesis.cancel = () => {};

  vm.runInNewContext(buildSilentPageBootstrap(), context);
  const snapshot = context.__conclaveSilentBrowserSafety.snapshot();
  assert.equal(snapshot.safe, true);
  assert.equal(snapshot.nativeGetUserMediaAvailable, true);
  assert.equal(snapshot.getUserMediaGuardInstalled, true);
  assert.equal(mediaElement.muted, true);
  assert.equal(mediaElement.volume, 0);
  assert.equal(mediaElement.attributeMutationCount, 1);
  assert.equal(typeof mediaMutationObserverCallback, "function");
  mediaMutationObserverCallback();
  mediaMutationObserverCallback();
  assert.equal(
    mediaElement.attributeMutationCount,
    1,
    "idempotent muting must not create a MutationObserver microtask loop",
  );

  const stream = await context.navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });
  assert.equal(nativeConstraints.length, 1);
  assert.equal(nativeConstraints[0].audio, false);
  assert.equal(nativeConstraints[0].video, true);
  assert.equal(stream.getVideoTracks().length, 1);
  assert.equal(stream.getAudioTracks().length, 1);
  assert.equal(
    stream.getAudioTracks()[0].__conclaveSyntheticZeroAudio,
    true,
  );
  const displayOptions = {
    audio: true,
    controller: { native: true },
    video: { frameRate: { ideal: 15 } },
  };
  displayOptions.self = displayOptions;
  await assert.rejects(
    context.navigator.mediaDevices.getDisplayMedia(displayOptions),
    /disabled in this silent probe/,
  );
  const displayDebug = context.__conclaveGetDisplayMediaDebug();
  assert.equal(displayDebug.callCount, 1);
  assert.equal("controller" in displayDebug.calls[0], false);
  assert.equal(displayDebug.calls[0].self, "[circular]");
  assert.doesNotThrow(() => JSON.stringify(displayDebug));

  const nativeConnectCountBeforeSpeaker = nativeConnectCount;
  const speaker = new context.AudioDestinationNode();
  assert.equal(new context.AudioNode().connect(speaker), speaker);
  assert.equal(nativeConnectCount, nativeConnectCountBeforeSpeaker);
  const descriptor = Object.getOwnPropertyDescriptor(
    context.MediaDevices.prototype,
    "getUserMedia",
  );
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);
});

test("only a fixture generated by the quality builder can precede safety", async () => {
  const descriptor = await createTrustedQualityFixtureBootstrap({
    enableSyntheticCamera: true,
    enableSyntheticAudio: true,
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.expectedPolicy), true);
  assert.equal(descriptor.name, "quality-browser-fixture");
  assert.deepEqual(descriptor.expectedPolicy, {
    enableSyntheticCamera: true,
    enableSyntheticAudio: true,
  });
  assert.match(descriptor.source, /__conclaveQualityHarness/);
  assert.match(descriptor.source, /Object\.freeze\(api\)/);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
  const viewerDescriptor = await createTrustedQualityFixtureBootstrap({
    enableSyntheticCamera: false,
    enableSyntheticAudio: true,
  });
  assert.deepEqual(viewerDescriptor.expectedPolicy, {
    enableSyntheticCamera: false,
    enableSyntheticAudio: true,
  });
  await assert.rejects(
    createTrustedQualityFixtureBootstrap({
      enableSyntheticCamera: "yes",
    }),
    /enableSyntheticCamera must be a boolean/,
  );
  await assert.rejects(
    createTrustedQualityFixtureBootstrap({
      enableSyntheticCamera: false,
      enableSyntheticAudio: false,
    }),
    /must enable synthetic zero audio/,
  );
});

test("trusted quality fixture creation is referenced only by approved harness paths", () => {
  const collectModules = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectModules(path);
      return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
    });
  const callSites = collectModules(resolve("scripts"))
    .filter((path) =>
      readFileSync(path, "utf8").includes(
        "createTrustedQualityFixtureBootstrap",
      ),
    )
    .map((path) => path.slice(resolve(".").length + 1))
    .sort();
  const approvedPaths = new Set([
    "scripts/quality/run-headless-video-quality.mjs",
    "scripts/quality/silent-browser-contract.mjs",
    "scripts/quality/silent-browser-contract.test.mjs",
  ]);
  assert.ok(callSites.length >= 2);
  for (const path of callSites) {
    assert.equal(approvedPaths.has(path), true, `unapproved fixture call site: ${path}`);
  }
});

test("cleanup escalates TERM to KILL and proves the process group is gone", async () => {
  let alive = true;
  let now = 0;
  const signals = [];
  const result = await terminateSilentBrowserProcess(
    { pid: 4242 },
    {
      gracefulTimeoutMs: 50,
      killTimeoutMs: 50,
      isAliveImpl: () => alive,
      signalImpl: (_child, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") alive = false;
      },
      sleepImpl: async (milliseconds) => {
        now += milliseconds;
      },
      nowImpl: () => now,
    },
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(alive, false);
});

test("a SIGKILL survivor retains its profile and reports both failures", async () => {
  let removeCalled = false;
  await assert.rejects(
    cleanupSilentBrowserProcessAndProfile({
      child: { pid: 4242 },
      userDataDir: "/tmp/conclave-silent-browser-survivor",
      terminateImpl: async () => {
        throw new Error("Chrome process group survived SIGKILL");
      },
      removeProfileImpl: () => {
        removeCalled = true;
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /survived SIGKILL/);
      assert.match(error.errors[1].message, /Retained Chrome profile/);
      assert.deepEqual(error.result, {
        processTerminated: false,
        profileRemoved: false,
      });
      return true;
    },
  );
  assert.equal(removeCalled, false);
});

test("signal cleanup retries survivors and refuses an unproven exit", async () => {
  const survivor = {};
  let closeAttempts = 0;
  const outcome = await attemptEmergencySilentBrowserCleanup({
    attempts: 3,
    getSessionsImpl: () => [survivor],
    closeImpl: async () => {
      closeAttempts += 1;
      throw new Error("still alive");
    },
    terminationProvenImpl: () => false,
  });
  assert.equal(closeAttempts, 3);
  assert.equal(outcome.safeToExit, false);
  assert.equal(outcome.attempts, 3);
  assert.match(outcome.lastError.message, /still alive/);
});

test("signal cleanup exits only after a later retry proves termination", async () => {
  const survivor = {};
  let closeAttempts = 0;
  let terminated = false;
  const outcome = await attemptEmergencySilentBrowserCleanup({
    attempts: 3,
    getSessionsImpl: () => [survivor],
    closeImpl: async () => {
      closeAttempts += 1;
      if (closeAttempts === 2) terminated = true;
      throw new Error(closeAttempts === 1 ? "first KILL failed" : "profile retained");
    },
    terminationProvenImpl: () => terminated,
  });
  assert.equal(closeAttempts, 2);
  assert.equal(outcome.safeToExit, true);
  assert.equal(outcome.attempts, 2);
});

test("all browser probe callers cannot spawn, attach, unmute, or navigate around the contract", () => {
  const paths = [
    "scripts/probe-low-bandwidth-meet.mjs",
    "scripts/debug-video-effects-headless.mjs",
    "scripts/observe-meet-effects-headless.mjs",
    "scripts/quality/run-headless-video-quality.mjs",
  ];
  for (const path of paths) {
    const source = readFileSync(resolve(path), "utf8");
    assert.match(source, /launchSilentBrowser/);
    assert.match(source, /navigateSilentBrowserPage/);
    assert.match(source, /closeSilentBrowser/);
    assert.doesNotMatch(source, /spawn\s*\(\s*chromePath/);
    assert.doesNotMatch(source, /new CdpClient/);
    assert.doesNotMatch(source, /pageWebSocketDebuggerUrl/);
    assert.doesNotMatch(source, /browserSession\.port/);
    assert.doesNotMatch(source, /\.send\("Page\.navigate"/);
    assert.doesNotMatch(source, /\.send\("Page\.reload"/);
    assert.doesNotMatch(source, /clickButton\([^\n]+["']Unmute["']/);
    assert.doesNotMatch(source, /--auto-select-desktop-capture-source/);
    assert.doesNotMatch(source, /--enable-usermedia-screen-capturing/);
    assert.doesNotMatch(source, /--allow-http-screen-capture/);
    assert.doesNotMatch(source, /stdio:\s*\[[^\]]*"pipe"/);
  }

  const collectModules = (directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectModules(path);
      return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
    });
  const contractPath = resolve("scripts/quality/silent-browser-contract.mjs");
  for (const path of collectModules(resolve("scripts"))) {
    if (path === contractPath || path.endsWith(".test.mjs")) continue;
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(
      source,
      /spawn(?:Impl)?\s*\(\s*chromePath/,
      `Chrome authority escaped the silent contract in ${path}`,
    );
    if (source.includes("/Applications/Google Chrome.app/")) {
      assert.match(
        source,
        /launchSilentBrowser/,
        `Chrome probe does not delegate launch authority in ${path}`,
      );
    }
  }

  const faceWrapper = readFileSync(
    resolve("scripts/debug-video-effects-face.mjs"),
    "utf8",
  );
  assert.doesNotMatch(faceWrapper, /process\.kill\(process\.pid/);
  assert.match(faceWrapper, /SIGINT/);
  assert.match(faceWrapper, /SIGQUIT/);
  assert.doesNotMatch(faceWrapper, /child\.kill\("SIGKILL"\)/);

  const receiveProbe = readFileSync(
    resolve("scripts/probe-low-bandwidth-meet.mjs"),
    "utf8",
  );
  assert.match(receiveProbe, /const requireAudio = false/);
  assert.match(
    receiveProbe,
    /\? audioEntries\.length >=[\s\S]{0,160}: audioEntries\.length === 0/,
  );
  assert.match(
    receiveProbe,
    /\? usableAudioEntries\.length >=[\s\S]{0,180}: usableAudioEntries\.length === 0/,
  );
  assert.match(
    receiveProbe,
    /if \(requireAudio && audioProfile !== targetAdaptiveProfile\)/,
  );
  assert.match(
    receiveProbe,
    /if \(requireAudio && audioMaxBitrate < 40000\)/,
  );
});

test("cleanup always attests before close, then performs proven process cleanup", () => {
  const source = readFileSync(
    resolve("scripts/quality/silent-browser-contract.mjs"),
    "utf8",
  );
  const finalAttestation = source.indexOf("`${label} final`");
  const browserClose = source.indexOf('send("Browser.close"');
  const processCleanup = source.indexOf(
    "const processCleanup = await cleanupSilentBrowserProcessAndProfile",
  );
  assert.ok(finalAttestation > 0);
  assert.ok(browserClose > finalAttestation);
  assert.ok(processCleanup > browserClose);
  assert.doesNotMatch(
    source,
    /new SilentCdpClient\(pageTarget\.webSocketDebuggerUrl\)/,
  );
  assert.match(source, /new ExactTargetCdpChannel\(browserCdp/);
  assert.doesNotMatch(source, /sessionInternals\.get\(session\) \?\? session/);
  assert.match(source, /process\.on\("uncaughtException"/);
  assert.match(source, /process\.on\("unhandledRejection"/);
  assert.match(source, /process\.on\("exit", killUnprovenChromeOnProcessExit\)/);
  assert.match(source, /"SIGQUIT"/);
});
