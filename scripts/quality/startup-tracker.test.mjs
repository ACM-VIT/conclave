import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  STARTUP_TRACKER_GLOBAL,
  buildReadStartupTrackerExpression,
  buildStartStartupTrackerExpression,
  buildStopStartupTrackerExpression,
} from "./startup-tracker.mjs";

class FakeMediaStream {
  constructor(trackId = "consumer-initial") {
    this.track = { id: trackId, readyState: "live" };
  }

  getVideoTracks() {
    return [this.track];
  }
}

class FakeVideo {
  constructor() {
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.srcObject = new FakeMediaStream();
    this.isConnected = true;
    this.listeners = new Map();
    this.nextFrameCallbackId = 1;
    this.frameCallbacks = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  requestVideoFrameCallback(callback) {
    const callbackId = this.nextFrameCallbackId++;
    this.frameCallbacks.set(callbackId, callback);
    return callbackId;
  }

  cancelVideoFrameCallback(callbackId) {
    this.frameCallbacks.delete(callbackId);
  }

  presentFrame() {
    const callbacks = [...this.frameCallbacks.values()];
    this.frameCallbacks.clear();
    for (const callback of callbacks) callback();
  }
}

const createRuntime = () => {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const clearedTimerIds = [];
  const video = new FakeVideo();
  let adaptiveConsumerId = "consumer-initial";
  let adaptiveProducerId = "producer-initial";
  const window = {
    MediaStream: FakeMediaStream,
    __conclaveGetMeetVideoDebug() {
      return {
        adaptiveConsumers: {
          entries: [
            {
              consumerId: adaptiveConsumerId,
              producerId: adaptiveProducerId,
              kind: "video",
              type: "webcam",
              status: "applied",
              paused: false,
            },
          ],
        },
      };
    },
    setInterval(callback, intervalMs) {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, intervalMs });
      return timerId;
    },
    clearInterval(timerId) {
      clearedTimerIds.push(timerId);
      timers.delete(timerId);
    },
  };
  const context = vm.createContext({
    window,
    document: {
      querySelectorAll(selector) {
        assert.match(selector, /data-meet-video-stream-type/);
        return video.isConnected ? [video] : [];
      },
    },
    performance: { now: () => now },
  });

  return {
    context,
    window,
    video,
    timers,
    clearedTimerIds,
    setNow(value) {
      now = value;
    },
    poll() {
      for (const timer of [...timers.values()]) timer.callback();
    },
    presentFrame(at) {
      now = at;
      video.presentFrame();
    },
    replaceConsumer(consumerId, producerId = adaptiveProducerId) {
      adaptiveConsumerId = consumerId;
      adaptiveProducerId = producerId;
      video.srcObject = new FakeMediaStream(consumerId);
    },
    evaluate(expression) {
      const result = vm.runInContext(expression, context);
      return result && typeof result === "object"
        ? JSON.parse(JSON.stringify(result))
        : result;
    },
  };
};

test("expression builders validate target height and polling cadence", () => {
  assert.throws(
    () => buildStartStartupTrackerExpression({ targetHeight: 0 }),
    /targetHeight/,
  );
  assert.throws(
    () => buildStartStartupTrackerExpression({ pollIntervalMs: 10 }),
    /pollIntervalMs/,
  );
  assert.doesNotThrow(
    () =>
      new Function(
        buildStartStartupTrackerExpression({
          targetHeight: 720,
          pollIntervalMs: 100,
        }),
      ),
  );
});

test("tracker records first decode, resize and polled resolution transitions", () => {
  const runtime = createRuntime();
  const started = runtime.evaluate(
    buildStartStartupTrackerExpression({
      targetHeight: 720,
      pollIntervalMs: 100,
    }),
  );

  assert.equal(started.active, true);
  assert.equal(started.firstDecodeAtNavigationMs, null);
  assert.equal(runtime.timers.size, 1);

  runtime.setNow(1_200);
  runtime.video.videoWidth = 320;
  runtime.video.videoHeight = 180;
  runtime.poll();

  let snapshot = runtime.evaluate(buildReadStartupTrackerExpression());
  assert.equal(snapshot.navigationToFirstDecodeMs, 1_200);
  assert.deepEqual(snapshot.transitions, [
    {
      width: 320,
      height: 180,
      source: "first-decode",
      atNavigationMs: 1_200,
      sinceFirstDecodeMs: 0,
    },
  ]);
  assert.equal(runtime.video.listenerCount("resize"), 1);

  runtime.setNow(1_450);
  runtime.video.videoWidth = 640;
  runtime.video.videoHeight = 360;
  runtime.video.dispatch("resize");

  runtime.setNow(1_800);
  runtime.video.videoWidth = 1280;
  runtime.video.videoHeight = 720;
  runtime.poll();

  snapshot = runtime.evaluate(buildReadStartupTrackerExpression());
  assert.deepEqual(
    snapshot.transitions.map(({ width, height, source }) => ({
      width,
      height,
      source,
    })),
    [
      { width: 320, height: 180, source: "first-decode" },
      { width: 640, height: 360, source: "resize" },
      { width: 1280, height: 720, source: "poll" },
    ],
  );
  assert.equal(snapshot.targetHeightReachedAtNavigationMs, 1_800);
  assert.equal(snapshot.firstDecodeToTargetHeightMs, 600);
});

test("tracker measures the visible frame interruption across a consumer generation", () => {
  const runtime = createRuntime();
  runtime.video.videoWidth = 1280;
  runtime.video.videoHeight = 720;
  runtime.setNow(1_000);
  runtime.evaluate(buildStartStartupTrackerExpression({ targetHeight: 720 }));

  runtime.presentFrame(1_010);
  runtime.presentFrame(1_043);
  runtime.replaceConsumer("consumer-replacement");
  runtime.poll();
  runtime.presentFrame(1_180);
  runtime.presentFrame(1_213);

  const snapshot = runtime.evaluate(buildReadStartupTrackerExpression());
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.frameContinuity, {
    supported: true,
    presentedFrameCount: 4,
    firstPresentedFrameAtNavigationMs: 1_010,
    lastPresentedFrameAtNavigationMs: 1_213,
    longestPresentedFrameGapMs: 137,
    longestGapBeforeFirstConsumerTransitionMs: 137,
    firstDecodeThroughFirstConsumerTransitionMaximumGapMs: 137,
    lastPresentedConsumerId: "consumer-replacement",
    lastPresentedProducerId: "producer-initial",
    consumerGenerationTransitions: [
      {
        fromConsumerId: "consumer-initial",
        toConsumerId: "consumer-replacement",
        fromProducerId: "producer-initial",
        toProducerId: "producer-initial",
        lastFrameAtNavigationMs: 1_043,
        firstFrameAtNavigationMs: 1_180,
        visibleInterruptionMs: 137,
        sinceFirstDecodeMs: 180,
      },
    ],
  });
});

test("tracker binds a visible consumer transition to a producer handoff", () => {
  const runtime = createRuntime();
  runtime.video.videoWidth = 1280;
  runtime.video.videoHeight = 720;
  runtime.setNow(1_000);
  runtime.evaluate(buildStartStartupTrackerExpression({ targetHeight: 720 }));

  runtime.presentFrame(1_010);
  runtime.replaceConsumer("consumer-replacement", "producer-replacement");
  runtime.poll();
  runtime.presentFrame(1_050);

  const transition = runtime.evaluate(buildReadStartupTrackerExpression())
    .frameContinuity.consumerGenerationTransitions[0];
  assert.equal(transition.fromProducerId, "producer-initial");
  assert.equal(transition.toProducerId, "producer-replacement");
});

test("stop is idempotent and cleans the resize listener and polling timer", () => {
  const runtime = createRuntime();
  runtime.video.videoWidth = 1280;
  runtime.video.videoHeight = 720;
  runtime.setNow(500);
  runtime.evaluate(buildStartStartupTrackerExpression({ targetHeight: 720 }));

  assert.equal(runtime.video.listenerCount("resize"), 1);
  assert.equal(runtime.timers.size, 1);

  runtime.setNow(750);
  const stopped = runtime.evaluate(buildStopStartupTrackerExpression());
  assert.equal(stopped.active, false);
  assert.equal(stopped.stopReason, "requested");
  assert.equal(stopped.stoppedAtNavigationMs, 750);
  assert.equal(stopped.navigationToFirstDecodeMs, 500);
  assert.equal(stopped.firstDecodeToTargetHeightMs, 0);
  assert.equal(runtime.video.listenerCount("resize"), 0);
  assert.equal(runtime.timers.size, 0);
  assert.deepEqual(runtime.clearedTimerIds, [1]);

  const stoppedAgain = runtime.evaluate(buildStopStartupTrackerExpression());
  assert.deepEqual(stoppedAgain, stopped);

  runtime.video.videoWidth = 640;
  runtime.video.videoHeight = 360;
  runtime.video.dispatch("resize");
  runtime.poll();
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        runtime.window[STARTUP_TRACKER_GLOBAL].snapshot().transitions,
      ),
    ),
    stopped.transitions,
  );
});

test("starting again stops and replaces the existing tracker without leaking timers", () => {
  const runtime = createRuntime();
  runtime.video.videoWidth = 640;
  runtime.video.videoHeight = 360;
  runtime.evaluate(buildStartStartupTrackerExpression({ targetHeight: 720 }));
  const firstTracker = runtime.window[STARTUP_TRACKER_GLOBAL];

  runtime.setNow(250);
  runtime.evaluate(buildStartStartupTrackerExpression({ targetHeight: 360 }));

  assert.notEqual(runtime.window[STARTUP_TRACKER_GLOBAL], firstTracker);
  assert.equal(firstTracker.snapshot().active, false);
  assert.equal(firstTracker.snapshot().stopReason, "restarted");
  assert.equal(runtime.timers.size, 1);
  assert.deepEqual(runtime.clearedTimerIds, [1]);
  assert.equal(runtime.video.listenerCount("resize"), 1);
});
