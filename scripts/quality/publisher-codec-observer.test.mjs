import assert from "node:assert/strict";
import test from "node:test";
import { assessPublisherCodecPerformance } from "./codec-performance.mjs";
import { startEpochAlignedObserver } from "./epoch-aligned-observer.mjs";
import { startPublisherCodecObserver } from "./publisher-codec-observer.mjs";

const measurementWindow = Object.freeze({
  version: 1,
  id: "publisher-window",
  startedAtEpochMs: 10_000,
  endedAtEpochMs: 20_000,
  durationMs: 10_000,
});

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

  clearTimer = (id) => {
    this.timers.delete(id);
  };

  elapse(milliseconds) {
    this.value += milliseconds;
  }

  async flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

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
    await this.flush();
    return true;
  }

  async runAll(latenessByTarget = new Map()) {
    while (this.timers.size > 0) {
      const nextTimer = Array.from(this.timers.values()).sort(
        (left, right) => left.at - right.at,
      )[0];
      await this.runNext({
        lateByMs: latenessByTarget.get(nextTimer.at) ?? 0,
      });
    }
  }
}

const parameters = {
  encodings: [
    {
      active: true,
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scalabilityMode: "L2T1",
    },
  ],
};

const binding = {
  connectionId: "pc-1",
  senderId: "sender-1",
  trackId: "track-1",
  parameters,
};

const encodeLimits = {
  maximumMeanMsPerFrame: 20,
  maximumP95MsPerFrame: 35,
  maximumMsPerFrame: 75,
  maximumCpuQualityLimitationRatio: 0.05,
};

const createPayloadCollector = (
  clock,
  {
    captureDurationMs = 20,
    failAtIndex = null,
    replaceTrackAtIndex = null,
  } = {},
) => {
  let index = 0;
  return async () => {
    const currentIndex = index;
    index += 1;
    if (currentIndex === failAtIndex) throw new Error("stats capture failed");
    clock.elapse(captureDurationMs);
    const trackReplaced =
      Number.isInteger(replaceTrackAtIndex) &&
      currentIndex >= replaceTrackAtIndex;
    const currentTrackId = trackReplaced ? "track-2" : "track-1";
    const currentParameters = trackReplaced
      ? {
          encodings: [
            {
              active: true,
              maxBitrate: 180_000,
              maxFramerate: 12,
              scalabilityMode: "L2T1",
            },
          ],
        }
      : parameters;
    return {
      producerId: "producer-1",
      currentTrackId,
      snapshot: {
        capturedAt: clock.now(),
        peerConnections: [
          {
            id: "pc-1",
            connectionState: "connected",
            iceConnectionState: "connected",
            signalingState: "stable",
            senders: [
              {
                id: "sender-1",
                track: {
                  id: currentTrackId,
                  kind: "video",
                  readyState: "live",
                },
                parameters: currentParameters,
                stats: [
                  {
                    id: "out-1",
                    type: "outbound-rtp",
                    kind: "video",
                    ssrc: 111,
                    active: true,
                    codecId: "codec-1",
                    framesEncoded: 1_000 + currentIndex * 15,
                    keyFramesEncoded: 10 + currentIndex,
                    totalEncodeTime: 4 + currentIndex * 0.06,
                    qpSum: 30_000 + currentIndex * 450,
                    bytesSent: 100_000 + currentIndex * 100_000,
                    encoderImplementation: "libvpx",
                    powerEfficientEncoder: false,
                    qualityLimitationReason: "none",
                    qualityLimitationDurations: {
                      none: 10 + currentIndex * 0.5,
                      cpu: 0,
                      bandwidth: 0,
                      other: 0,
                    },
                    scalabilityMode: "L2T1",
                  },
                  {
                    id: "codec-1",
                    type: "codec",
                    mimeType: "video/VP9",
                    payloadType: 98,
                    sdpFmtpLine: "profile-id=0",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  };
};

const armPublisherObserver = (clock, options = {}) =>
  startPublisherCodecObserver({
    collectPayload: createPayloadCollector(clock, options),
    binding,
    producerId: "producer-1",
    codecMimeType: "video/VP9",
    expectedEncodingCount: 1,
    measurementWindow,
    schedulerOptions: {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  });

const assessObservedPublisher = (observed) =>
  assessPublisherCodecPerformance({
    observations: observed.observations,
    measurementWindow,
    observerMetadata: {
      measurementWindowId: observed.measurementWindowId,
      armedAtEpochMs: observed.armedAtEpochMs,
      observerStartedAtEpochMs: observed.observerStartedAtEpochMs,
      observerStoppedAtEpochMs: observed.observerStoppedAtEpochMs,
      observationIntervalMs: observed.observationIntervalMs,
      skippedTickCount: observed.skippedTickCount,
    },
    durationMs: measurementWindow.durationMs,
    limits: encodeLimits,
  });

test("publisher observer arms three seconds early but records only in-window evidence", async () => {
  const clock = new FakeClock(measurementWindow.startedAtEpochMs - 3_000);
  let captureCalls = 0;
  const collectPayload = createPayloadCollector(clock);
  const observer = startPublisherCodecObserver({
    collectPayload: async (...args) => {
      captureCalls += 1;
      return collectPayload(...args);
    },
    binding,
    producerId: "producer-1",
    codecMimeType: "video/VP9",
    expectedEncodingCount: 1,
    measurementWindow,
    schedulerOptions: {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    },
  });

  assert.equal(observer.armedAtEpochMs, 7_000);
  assert.equal(captureCalls, 0);
  await clock.runAll();
  const first = await observer.stop();
  const observationTimes = first.observations.map(
    (observation) => observation.capturedAtEpochMs,
  );

  assert.equal(first.observerStartedAtEpochMs, 10_000);
  assert.equal(first.observerStoppedAtEpochMs, 20_000);
  assert.equal(first.observations.length, 21);
  assert.equal(first.observations.every((entry) => entry.matched), true);
  assert.equal(first.observations[0].measurementWindowId, measurementWindow.id);
  assert.equal(observationTimes[0], 10_020);
  assert.equal(observationTimes.at(-1), 19_970);
  assert.equal(
    observationTimes.every(
      (at) =>
        at >= measurementWindow.startedAtEpochMs &&
        at <= measurementWindow.endedAtEpochMs,
    ),
    true,
  );
  assert.equal(first.skippedTickCount, 0);
  assert.equal(first.maximumConcurrentSamples, 1);
  assert.equal(assessObservedPublisher(first).valid, true);
  assert.equal(Object.isFrozen(first.observations[0]), true);
  assert.equal(Object.isFrozen(first.observations[0].encodings), true);
  assert.equal(Object.isFrozen(first.tickRecords[0]), true);
  assert.throws(() => {
    first.observations[0].matched = false;
  }, TypeError);

  clock.elapse(5_000);
  const afterDrain = await observer.stop();
  assert.equal(afterDrain, first);
  assert.equal(afterDrain.observerStoppedAtEpochMs, 20_000);
  assert.deepEqual(
    afterDrain.observations.map((entry) => entry.capturedAtEpochMs),
    observationTimes,
  );
});

test("publisher observer rejects 625ms configuration and late boundary ticks", async () => {
  const configurationClock = new FakeClock(7_000);
  assert.throws(
    () =>
      startPublisherCodecObserver({
        collectPayload: createPayloadCollector(configurationClock),
        binding,
        producerId: "producer-1",
        codecMimeType: "video/VP9",
        expectedEncodingCount: 1,
        measurementWindow,
        schedulerOptions: {
          observationIntervalMs: 625,
          now: configurationClock.now,
          setTimer: configurationClock.setTimer,
          clearTimer: configurationClock.clearTimer,
        },
      }),
    /exactly 500ms/,
  );
  assert.throws(
    () =>
      startPublisherCodecObserver({
        collectPayload: createPayloadCollector(configurationClock),
        binding,
        producerId: "producer-1",
        codecMimeType: "video/VP9",
        expectedEncodingCount: 1,
        measurementWindow: {
          version: 1,
          id: "misaligned-window",
          startedAtEpochMs: 10_000,
          endedAtEpochMs: 20_600,
          durationMs: 10_600,
        },
        schedulerOptions: {
          now: configurationClock.now,
          setTimer: configurationClock.setTimer,
          clearTimer: configurationClock.clearTimer,
        },
      }),
    /valid version 1 measurement window|divisible/,
  );

  const firstClock = new FakeClock(7_000);
  const lateFirst = armPublisherObserver(firstClock);
  await firstClock.runAll(new Map([[10_000, 251]]));
  const lateFirstResult = await lateFirst.stop();
  assert.ok(lateFirstResult.skippedTickCount > 0);
  assert.equal(assessObservedPublisher(lateFirstResult).valid, false);

  const terminalClock = new FakeClock(7_000);
  const lateTerminal = armPublisherObserver(terminalClock);
  await terminalClock.runAll(new Map([[19_950, 60]]));
  const lateTerminalResult = await lateTerminal.stop();
  assert.ok(lateTerminalResult.skippedTickCount > 0);
  assert.ok(
    lateTerminalResult.observations.at(-1).capturedAtEpochMs >
      measurementWindow.endedAtEpochMs,
  );
  assert.equal(assessObservedPublisher(lateTerminalResult).valid, false);
});

test("publisher observer fails closed on capture errors", async () => {
  const clock = new FakeClock(7_000);
  const observer = armPublisherObserver(clock, { failAtIndex: 5 });
  await clock.runAll();
  const observed = await observer.stop();

  assert.equal(observed.captureErrorCount, 1);
  assert.ok(observed.skippedTickCount > 0);
  assert.match(observed.schedulerErrors.join("\n"), /stats capture failed/);
  assert.equal(assessObservedPublisher(observed).valid, false);
});

test("dynamic observer accepts source-track replacement only on the fixed sender and RTP path", async () => {
  const strictClock = new FakeClock(7_000);
  const strictObserver = startPublisherCodecObserver({
    collectPayload: createPayloadCollector(strictClock, {
      replaceTrackAtIndex: 5,
    }),
    binding,
    producerId: "producer-1",
    codecMimeType: "video/VP9",
    expectedEncodingCount: 1,
    measurementWindow,
    schedulerOptions: {
      now: strictClock.now,
      setTimer: strictClock.setTimer,
      clearTimer: strictClock.clearTimer,
    },
  });
  await strictClock.runAll();
  const strictObserved = await strictObserver.stop();
  assert.equal(strictObserved.observations.some((entry) => !entry.matched), true);
  assert.equal(assessObservedPublisher(strictObserved).valid, false);

  const dynamicClock = new FakeClock(7_000);
  const dynamicObserver = startPublisherCodecObserver({
    collectPayload: createPayloadCollector(dynamicClock, {
      replaceTrackAtIndex: 5,
    }),
    binding,
    producerId: "producer-1",
    codecMimeType: "video/VP9",
    expectedEncodingCount: 1,
    measurementWindow,
    allowTrackReplacement: true,
    allowEncodingParameterChanges: true,
    schedulerOptions: {
      now: dynamicClock.now,
      setTimer: dynamicClock.setTimer,
      clearTimer: dynamicClock.clearTimer,
    },
  });
  await dynamicClock.runAll();
  const dynamicObserved = await dynamicObserver.stop();

  assert.equal(dynamicObserved.observations.every((entry) => entry.matched), true);
  assert.deepEqual(
    new Set(dynamicObserved.observations.map((entry) => entry.trackId)),
    new Set(["track-1", "track-2"]),
  );
  assert.equal(
    new Set(
      dynamicObserved.observations.map(
        (entry) => entry.senderEncodingSignature,
      ),
    ).size,
    2,
  );
  assert.equal(assessObservedPublisher(dynamicObserved).valid, true);
});

test("aligned scheduler never overlaps sample promises", async () => {
  const clock = new FakeClock(7_000);
  const shortWindow = {
    version: 1,
    id: "short-window",
    startedAtEpochMs: 10_000,
    endedAtEpochMs: 11_000,
    durationMs: 1_000,
  };
  let resolveFirst;
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const observer = startEpochAlignedObserver({
    measurementWindow: shortWindow,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    observe: async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) {
        await new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      active -= 1;
      return { capturedAtEpochMs: clock.now() };
    },
  });

  await clock.runNext();
  await clock.runNext();
  assert.equal(calls, 1);
  resolveFirst();
  await clock.flush();
  await clock.runAll();
  const observed = await observer.stop();

  assert.equal(maximumActive, 1);
  assert.equal(observed.maximumConcurrentSamples, 1);
  assert.equal(observed.overlapTickCount, 1);
  assert.ok(observed.skippedTickCount > 0);
});
