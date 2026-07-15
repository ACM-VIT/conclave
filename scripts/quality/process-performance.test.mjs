import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import {
  assessBrowserProcessPerformance,
  buildHardwareIdentity,
  captureBrowserProcessSnapshot,
  PROCESS_PERFORMANCE_VERSION,
  startBrowserProcessObserver,
} from "./process-performance.mjs";

const measurementWindow = Object.freeze({
  version: 1,
  id: "window-1",
  startedAtEpochMs: 1_000,
  endedAtEpochMs: 11_000,
  durationMs: 10_000,
});

const identityInput = {
  browserVersion: {
    product: "Chrome/140.0.1.2",
    protocolVersion: "1.3",
    jsVersion: "14.0",
  },
  systemInfo: {
    gpu: {
      devices: [
        {
          vendorId: 123,
          deviceId: 456,
          vendorString: "Example GPU Vendor",
          deviceString: "Example Integrated GPU",
          driverVendor: "Example",
          driverVersion: "1.2.3",
        },
      ],
    },
    modelName: "must-not-be-persisted",
    commandLine: "must-not-be-persisted",
  },
  platform: "darwin",
  architecture: "arm64",
  osRelease: "25.5.0",
  logicalCpuCount: 10,
  totalMemoryBytes: 18 * 1024 ** 3,
};

const hardwareIdentity = buildHardwareIdentity(identityInput);

const processSnapshot = ({
  at,
  processes,
  targetIndex = 0,
  scheduledAtEpochMs = measurementWindow.startedAtEpochMs,
  phase = "interval",
  expectedBrowserPid = 100,
  windowId = measurementWindow.id,
  label = "publisher",
  identityId = hardwareIdentity.hardwareIdentityId,
} = {}) => ({
  version: PROCESS_PERFORMANCE_VERSION,
  label,
  phase,
  measurementWindowId: windowId,
  expectedBrowserPid,
  hardwareIdentityId: identityId,
  targetIndex,
  scheduledAtEpochMs,
  invokedAtEpochMs: at,
  tickLatenessMs: Math.max(0, at - scheduledAtEpochMs),
  requestedAtEpochMs: at,
  completedAtEpochMs: at + 2,
  requestDurationMs: 2,
  processes,
});

const continuousObservations = ({
  times = Array.from({ length: 21 }, (_, index) => 1_000 + index * 500),
  mutate = null,
} = {}) =>
  times.map((at, index) => {
    const processes = [
      { id: 100, type: "browser", cpuTimeSeconds: 10 + index * 0.05 },
      { id: 101, type: "renderer", cpuTimeSeconds: 20 + index * 0.1 },
      { id: 102, type: "gpu", cpuTimeSeconds: 5 + index * 0.025 },
    ];
    return processSnapshot({
      at,
      targetIndex: index,
      scheduledAtEpochMs:
        measurementWindow.startedAtEpochMs + index * 500,
      phase:
        index === 0
          ? "boundary-start"
          : index === times.length - 1
            ? "boundary-end"
            : "interval",
      processes: mutate ? mutate({ at, index, processes }) : processes,
    });
  });

const assess = (overrides = {}) => {
  const observations = overrides.observations ?? continuousObservations();
  return assessBrowserProcessPerformance({
    label: "publisher",
    role: "publisher",
    observations,
    measurementWindow,
    observationIntervalMs: 500,
    scheduledObservationCount: 21,
    completedObservationCount: observations.length,
    skippedTickCount: 0,
    lateTickCount: 0,
    overlapTickCount: 0,
    slowCaptureCount: 0,
    captureErrorCount: 0,
    maximumConcurrentCaptures: 1,
    maximumCoreEquivalents: 1,
    ...overrides,
  });
};

class FakeClock {
  constructor(now = 0) {
    this.value = now;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.value;

  setTimer = (callback, delayMs) => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, {
      at: this.value + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  clearTimer = (id) => this.timers.delete(id);

  async runNext({ lateByMs = 0 } = {}) {
    const next = Array.from(this.timers.entries()).sort(
      ([leftId, left], [rightId, right]) =>
        left.at - right.at || leftId - rightId,
    )[0];
    if (!next) return false;
    const [id, timer] = next;
    this.timers.delete(id);
    this.value = Math.max(this.value, timer.at) + lateByMs;
    timer.callback();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    return true;
  }

  async runAll() {
    while (this.timers.size > 0) {
      await this.runNext();
    }
  }
}

test("hardware identity is complete, deterministic, bucketed, and non-sensitive", () => {
  const repeated = buildHardwareIdentity({
    ...identityInput,
    systemInfo: {
      ...identityInput.systemInfo,
      modelName: "different private model value",
      commandLine: "different private command line",
    },
  });

  assert.equal(hardwareIdentity.complete, true);
  assert.equal(hardwareIdentity.memoryBucketGiB, 32);
  assert.equal(hardwareIdentity.osRelease, "25.5.0");
  assert.equal(hardwareIdentity.hardwareIdentityId, repeated.hardwareIdentityId);
  assert.equal(Object.hasOwn(hardwareIdentity, "modelName"), false);
  assert.equal(JSON.stringify(hardwareIdentity).includes("command line"), false);
  assert.match(hardwareIdentity.hardwareIdentityId, /^[a-f0-9]{64}$/);
});

test("hardware identity changes when the OS release changes", () => {
  const changed = buildHardwareIdentity({
    ...identityInput,
    osRelease: "26.0.0",
  });
  assert.equal(changed.complete, true);
  assert.notEqual(changed.hardwareIdentityId, hardwareIdentity.hardwareIdentityId);
});

test("hardware identity rejects nonempty GPU lists with no meaningful device identity", () => {
  const incomplete = buildHardwareIdentity({
    ...identityInput,
    systemInfo: { gpu: { devices: [{ driverVersion: "1.2.3" }] } },
  });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingFields, ["gpu.devices[0].identity"]);

  const zeroIds = buildHardwareIdentity({
    ...identityInput,
    systemInfo: { gpu: { devices: [{ vendorId: 0, deviceId: 0 }] } },
  });
  assert.equal(zeroIds.complete, false);
  assert.deepEqual(zeroIds.missingFields, ["gpu.devices[0].identity"]);

  const stringsWithZeroIds = buildHardwareIdentity({
    ...identityInput,
    systemInfo: {
      gpu: {
        devices: [
          {
            vendorId: 0,
            deviceId: 0,
            vendorString: "Software renderer",
            deviceString: "SwiftShader",
          },
        ],
      },
    },
  });
  assert.equal(stringsWithZeroIds.complete, true);
});

test("browser-level snapshots call SystemInfo.getProcessInfo exactly", async () => {
  const calls = [];
  const cdp = {
    async send(method) {
      calls.push(method);
      return {
        processInfo: [
          { id: 100, type: "Browser", cpuTime: 4.5 },
          { id: 101, type: "Renderer", cpuTime: 2 },
        ],
      };
    },
  };
  let nowValue = 5_000;
  const snapshot = await captureBrowserProcessSnapshot(cdp, {
    label: "publisher",
    measurementWindowId: measurementWindow.id,
    expectedBrowserPid: 100,
    hardwareIdentityId: hardwareIdentity.hardwareIdentityId,
    now: () => (nowValue += 3),
  });

  assert.deepEqual(calls, ["SystemInfo.getProcessInfo"]);
  assert.equal(snapshot.version, PROCESS_PERFORMANCE_VERSION);
  assert.equal(snapshot.processes[0].type, "browser");
  assert.equal(snapshot.processes[0].cpuTimeSeconds, 4.5);
  assert.equal(snapshot.requestDurationMs, 3);
});

test("process observer uses one immutable absolute-boundary schedule", async () => {
  const clock = new FakeClock(0);
  const shortWindow = {
    version: 1,
    id: "absolute-process-window",
    startedAtEpochMs: 1_000,
    endedAtEpochMs: 2_000,
    durationMs: 1_000,
  };
  let callCount = 0;
  const observer = startBrowserProcessObserver(
    {
      async send() {
        callCount += 1;
        clock.value += 2;
        return {
          processInfo: [
            {
              id: 100,
              type: "Browser",
              cpuTime: 10 + callCount * 0.05,
            },
          ],
        };
      },
    },
    {
      label: "publisher",
      measurementWindow: shortWindow,
      expectedBrowserPid: 100,
      hardwareIdentityId: hardwareIdentity.hardwareIdentityId,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );
  const stopPromise = observer.stop();
  assert.equal(observer.stop(), stopPromise);
  await clock.runAll();
  const observed = await stopPromise;
  const result = assessBrowserProcessPerformance({
    label: "publisher",
    role: "publisher",
    ...observed,
    maximumCoreEquivalents: 1,
  });

  assert.deepEqual(
    observed.observations.map((entry) => entry.scheduledAtEpochMs),
    [1_000, 1_500, 2_000],
  );
  assert.deepEqual(
    observed.observations.map((entry) => entry.requestedAtEpochMs),
    [1_000, 1_500, 2_000],
  );
  assert.equal(observed.maximumConcurrentCaptures, 1);
  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
  assert.equal(result.coreEquivalents, 0.1);
});

test("process observer skips rather than overlaps an unresolved capture", async () => {
  const clock = new FakeClock(0);
  const shortWindow = {
    version: 1,
    id: "overlap-process-window",
    startedAtEpochMs: 1_000,
    endedAtEpochMs: 2_000,
    durationMs: 1_000,
  };
  let resolveCapture;
  const observer = startBrowserProcessObserver(
    {
      send() {
        return new Promise((resolve) => {
          resolveCapture = () =>
            resolve({
              processInfo: [
                { id: 100, type: "Browser", cpuTime: 10.05 },
              ],
            });
        });
      },
    },
    {
      label: "publisher",
      measurementWindow: shortWindow,
      expectedBrowserPid: 100,
      hardwareIdentityId: hardwareIdentity.hardwareIdentityId,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );
  const stopPromise = observer.stop();
  await clock.runAll();
  resolveCapture();
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  const observed = await stopPromise;
  const result = assessBrowserProcessPerformance({
    label: "publisher",
    role: "publisher",
    ...observed,
    maximumCoreEquivalents: 1,
  });

  assert.equal(observed.maximumConcurrentCaptures, 1);
  assert.equal(observed.overlapTickCount, 2);
  assert.equal(observed.completedObservationCount, 1);
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /cadence authority|miscounted/);
});

test("continuous observer records CDP failures instead of leaking a rejected timer", async () => {
  const clock = new FakeClock(0);
  const shortWindow = {
    version: 1,
    id: "process-window",
    startedAtEpochMs: 1_000,
    endedAtEpochMs: 2_000,
    durationMs: 1_000,
  };
  const observer = startBrowserProcessObserver(
    {
      async send() {
        throw new Error("CDP unavailable");
      },
    },
    {
      label: "publisher",
      measurementWindow: shortWindow,
      expectedBrowserPid: 100,
      hardwareIdentityId: hardwareIdentity.hardwareIdentityId,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  );
  const firstStop = observer.stop();
  const concurrentStop = observer.stop();
  assert.equal(concurrentStop, firstStop);
  await clock.runAll();
  const observed = await firstStop;
  const result = assessBrowserProcessPerformance({
    label: "publisher",
    role: "publisher",
    ...observed,
    maximumCoreEquivalents: 1,
  });

  assert.equal(observed.observations.length, 3);
  assert.equal(observed.observations[0].captureError, "CDP unavailable");
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /capture failed/);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.observations), true);
  assert.equal(Object.isFrozen(observed.observations[0]), true);
});

test("continuous process analyzer reports full, p95, maximum, and per-type CPU", () => {
  const result = assess();

  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.coverageRatio, 1);
  assert.equal(result.intervals.length, 20);
  assert.equal(result.coreEquivalents, 0.35);
  assert.equal(result.p95CoreEquivalents, 0.35);
  assert.equal(result.maximumObservedCoreEquivalents, 0.35);
  assert.deepEqual(result.cpuSecondsByType, {
    browser: 1,
    renderer: 2,
    gpu: 0.5,
  });
});

test("boundary capture latency is measured as a full interval, never clipped into a CPU spike", () => {
  const observations = continuousObservations();
  observations[0] = {
    ...observations[0],
    completedAtEpochMs: 1_100,
    requestDurationMs: 100,
  };
  const result = assess({ observations });

  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
  assert.equal(result.intervals[0].coveredDurationMs, 402);
  assert.ok(result.maximumObservedCoreEquivalents < 0.5);
  assert.ok(result.coreEquivalents > 0.35);
  assert.ok(result.coreEquivalents < 0.36);
});

test("continuous process analyzer rejects shifted epochs without a start bracket", () => {
  const observations = continuousObservations({
    times: Array.from({ length: 21 }, (_, index) => 1_500 + index * 500),
  });
  const result = assess({ observations });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /exact absolute target/);
});

test("continuous process analyzer excludes and records a transient PID", () => {
  const observations = continuousObservations({
    mutate: ({ index, processes }) =>
      index === 5
        ? [
            ...processes,
            { id: 999, type: "utility", cpuTimeSeconds: 0.4 },
          ]
        : processes,
  });
  const result = assess({ observations });
  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
  assert.equal(result.processScope, "persistent-full-window");
  assert.equal(result.excludedTransientProcessCount, 1);
  assert.deepEqual(
    result.lifecycleEvents.map((event) => event.type),
    ["appeared", "disappeared"],
  );
  assert.equal(result.lifecycleEvents[0].includedInCpuAuthority, false);
  assert.equal(result.lifecycleEvents[0].observedCumulativeCpuSeconds, 0.4);
  assert.equal(result.coreEquivalents, 0.35);
});

test("continuous process analyzer tolerates one millisecond wall-clock rounding", () => {
  const observations = continuousObservations();
  observations[11] = {
    ...observations[11],
    invokedAtEpochMs: observations[11].scheduledAtEpochMs - 1,
    requestedAtEpochMs: observations[11].scheduledAtEpochMs - 1,
    completedAtEpochMs: observations[11].scheduledAtEpochMs,
    tickLatenessMs: 0,
  };
  const result = assess({ observations });

  assert.equal(result.valid, true, result.harnessFailures.join("\n"));
});

test("continuous process analyzer rejects a renderer generation with no full-window authority", () => {
  const observations = continuousObservations({
    mutate: ({ index, processes }) =>
      processes.map((process) =>
        process.type === "renderer"
          ? {
              ...process,
              id: index < 10 ? 101 : 201,
            }
          : process,
      ),
  });
  const result = assess({ observations });

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /no renderer process persisted/);
});

test("continuous process analyzer rejects a counter reset", () => {
  const observations = continuousObservations({
    mutate: ({ index, processes }) =>
      processes.map((process) =>
        index === 10 && process.id === 101
          ? { ...process, cpuTimeSeconds: 1 }
          : process,
      ),
  });
  const result = assess({ observations });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /CPU counter reset/);
});

test("continuous process analyzer rejects 625ms cadence", () => {
  const observations = continuousObservations({
    times: Array.from({ length: 17 }, (_, index) => 1_000 + index * 625),
  });
  const result = assess({ observations });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /625ms.*outside/);
});

test("continuous process analyzer rejects a missed interval gap", () => {
  const times = Array.from({ length: 21 }, (_, index) => 1_000 + index * 500);
  times.splice(8, 1);
  const result = assess({ observations: continuousObservations({ times }) });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /1000ms.*outside/);
});

test("continuous process analyzer rejects skipped polling ticks", () => {
  const result = assess({ skippedTickCount: 1 });
  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /cadence authority/);
});

test("runner owns separate browser CDP and continuous process observers", () => {
  const source = readFileSync(
    resolve("scripts/quality/run-headless-video-quality.mjs"),
    "utf8",
  );
  assert.match(source, /launchSilentBrowser/);
  assert.match(source, /const browserCdp = session\.systemCdp/);
  assert.match(source, /const dynamicNetworkCdp = session\.networkCdp/);
  assert.doesNotMatch(source, /new CdpClient/);
  assert.doesNotMatch(source, /spawn\s*\(\s*chromePath/);
  assert.doesNotMatch(source, /\/json\/version/);
  assert.match(source, /SystemInfo\.getInfo/);
  assert.match(source, /startBrowserProcessObserver/);
  assert.doesNotMatch(source, /processStartSnapshots|processEndSnapshots/);
  assert.match(source, /closeSilentBrowser\(browser\.session\)/);
});

test("runner arms every sampler before one future shared barrier", () => {
  const source = readFileSync(
    resolve("scripts/quality/run-headless-video-quality.mjs"),
    "utf8",
  );
  const armedAt = source.indexOf("const samplerArmResults = await Promise.all");
  const dynamicPlanAt = source.indexOf(
    "const dynamicNetworkPlan = dynamicNetworkTransitionEnabled",
  );
  const steadyWindowAt = source.indexOf(
    "const steadyMeasurementWindowStartedAtEpochMs = Date.now() + 3_000",
  );
  const resolvedWindowAt = source.indexOf("const measurementWindow =");
  const observersAt = source.indexOf(
    "const [processObservers, publisherCodecObserver] = await Promise.all",
  );
  const beginAt = source.indexOf(
    "buildBeginSamplerExpression(measurementWindow)",
  );

  assert.ok(armedAt >= 0);
  assert.ok(dynamicPlanAt > armedAt);
  assert.ok(steadyWindowAt > dynamicPlanAt);
  assert.ok(resolvedWindowAt > steadyWindowAt);
  assert.ok(observersAt > resolvedWindowAt);
  assert.ok(beginAt > observersAt);
  assert.match(
    source,
    /dynamicNetworkPlan\?\.measurementWindow \?\?[\s\S]*startedAtEpochMs: steadyMeasurementWindowStartedAtEpochMs/,
  );
  assert.match(source, /Date\.now\(\) > measurementWindow\.startedAtEpochMs - 250/);
  assert.match(
    source,
    /resolveSamplerBeginEvaluationTimeoutMs\(measurementWindow\)/,
  );
  assert.match(
    source,
    /buildBeginSamplerExpression\(measurementWindow\),\s*samplerBeginEvaluationTimeoutMs/,
  );
  assert.match(source, /invalidWindowReceiverIndex/);
  assert.match(source, /measurementWindowAuthority\?\.valid !== true/);
  assert.match(
    source,
    /collectPublisherCodecPayload\(publisher, measurementWindow\.id\)/,
  );
  assert.match(source, /let publisherWindowStartPayloadPromise = null/);
  assert.match(source, /let publisherWindowEndPayloadPromise = null/);
  assert.match(
    source,
    /tick\.phase === "start"[\s\S]*collectPublisherWindowStartPayload\(\)/,
  );
  assert.match(
    source,
    /return \(await collectPublisherWindowStartPayload\(\)\)\.snapshot/,
  );
  assert.match(
    source,
    /tick\.phase === "terminal"[\s\S]*collectPublisherWindowEndPayload\(\)/,
  );
  assert.match(
    source,
    /\(await collectPublisherWindowEndPayload\(\)\)\.snapshot/,
  );
  assert.match(source, /durationMs % 500 !== 0/);
  assert.match(source, /armedAtEpochMs: publisherCodecObservationWindow\.armedAtEpochMs/);
  assert.doesNotMatch(source, /const startPublisherCodecObserver = async/);
  assert.doesNotMatch(source, /buildStartSamplerExpression/);
});

test("runner teardown preserves exact-window evidence ordering", () => {
  const source = readFileSync(
    resolve("scripts/quality/run-headless-video-quality.mjs"),
    "utf8",
  );
  const publisherEndAt = source.indexOf(
    "const publisherStatsEnd =",
  );
  const receiversAt = source.indexOf(
    "const receiverSamplerMeasurements = await Promise.all",
  );
  const codecAt = source.indexOf("await publisherCodecObserver.stop()");
  const processesAt = source.indexOf(
    "const processObservationWindows = await Promise.all",
  );

  assert.ok(publisherEndAt >= 0);
  assert.ok(receiversAt > publisherEndAt);
  assert.ok(codecAt > receiversAt);
  assert.ok(processesAt > codecAt);
  assert.match(source, /publisherStatsStart\.measurementWindowId = measurementWindow\.id/);
  assert.match(source, /publisherStatsEnd\.measurementWindowId = measurementWindow\.id/);
});
