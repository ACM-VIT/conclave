import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS,
  VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS,
  VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS,
  applyVideoReceiverJitterBufferTarget,
  getAdaptiveVideoJitterBufferTargetMs,
  reconcileVideoReceiverJitterBufferTarget,
  releaseVideoReceiverJitterBufferTargetState,
  type AdaptiveVideoJitterBufferPolicyOptions,
  type VideoJitterBufferNetworkQuality,
  type VideoJitterBufferTargetState,
} from "../src/app/lib/adaptive-video-jitter-buffer";

const policy = (
  overrides: Partial<AdaptiveVideoJitterBufferPolicyOptions> = {},
) =>
  getAdaptiveVideoJitterBufferTargetMs({
    enabled: true,
    mediaKind: "video",
    sourceType: "webcam",
    quality: "good",
    emergencyMode: false,
    dataSaverMode: false,
    isDocumentVisible: true,
    ...overrides,
  });

describe("getAdaptiveVideoJitterBufferTargetMs", () => {
  it.each([
    ["unknown", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.good],
    ["good", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.good],
    ["fair", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair],
    ["poor", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.poor],
  ] satisfies [VideoJitterBufferNetworkQuality, number][]) (
    "uses the %s receive profile for a webcam",
    (quality, expectedTargetMs) => {
      expect(policy({ quality })).toBe(expectedTargetMs);
    },
  );

  it.each([
    ["unknown", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair],
    ["good", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair],
    ["fair", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair],
    ["poor", ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.poor],
  ] satisfies [VideoJitterBufferNetworkQuality, number][]) (
    "keeps a %s-link screen share at least at the fair profile",
    (quality, expectedTargetMs) => {
      expect(policy({ sourceType: "screen", quality })).toBe(
        expectedTargetMs,
      );
    },
  );

  it("uses the bounded emergency target for webcam and screen video", () => {
    expect(policy({ emergencyMode: true })).toBe(
      ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.emergency,
    );
    expect(policy({ sourceType: "screen", emergencyMode: true })).toBe(
      ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.emergency,
    );
  });

  it("returns no target while the policy is disabled", () => {
    expect(policy({ enabled: false })).toBeNull();
    expect(policy({ enabled: false, sourceType: "screen" })).toBeNull();
  });

  it("never directly targets audio", () => {
    expect(policy({ mediaKind: "audio" })).toBeNull();
    expect(
      policy({ mediaKind: "audio", emergencyMode: true, quality: "poor" }),
    ).toBeNull();
  });

  it("clears parked webcam targets without weakening live screen continuity", () => {
    expect(policy({ dataSaverMode: true })).toBeNull();
    expect(policy({ isDocumentVisible: false })).toBeNull();
    expect(policy({ sourceType: "screen", dataSaverMode: true })).toBe(
      ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair,
    );
    expect(
      policy({ sourceType: "screen", isDocumentVisible: false }),
    ).toBe(ADAPTIVE_VIDEO_JITTER_BUFFER_TARGET_MS.fair);
  });
});

describe("applyVideoReceiverJitterBufferTarget", () => {
  it("applies a supported target and is idempotent", () => {
    let currentTarget: number | null = null;
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        currentTarget = value;
      },
    });

    expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
      status: "applied",
      observedTargetMs: 40,
    });
    expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
      status: "unchanged",
      observedTargetMs: 40,
    });
    expect(currentTarget).toBe(40);
    expect(assignmentCount).toBe(1);
  });

  it("updates quality changes and clears the preference with null", () => {
    const receiver = { jitterBufferTarget: 40 as number | null };

    expect(applyVideoReceiverJitterBufferTarget(receiver, 120)).toEqual({
      status: "applied",
      observedTargetMs: 120,
    });
    expect(receiver.jitterBufferTarget).toBe(120);
    expect(applyVideoReceiverJitterBufferTarget(receiver, null)).toEqual({
      status: "reset",
      observedTargetMs: null,
    });
    expect(receiver.jitterBufferTarget).toBeNull();
    expect(applyVideoReceiverJitterBufferTarget(receiver, null)).toEqual({
      status: "unchanged",
      observedTargetMs: null,
    });
  });

  it.each([undefined, null, {}, 1, "receiver"]) (
    "falls back without throwing when the receiver is unsupported (%p)",
    (receiver) => {
      expect(() =>
        applyVideoReceiverJitterBufferTarget(receiver, 40),
      ).not.toThrow();
      expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
        status: "unsupported",
        observedTargetMs: null,
      });
    },
  );

  it("catches assignment failures without disrupting the call", () => {
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => null,
      set: () => {
        throw new Error("not implemented");
      },
    });

    expect(() =>
      applyVideoReceiverJitterBufferTarget(receiver, 40),
    ).not.toThrow();
    expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
      status: "error",
      observedTargetMs: null,
    });
  });

  it("reports an error and the observed value when setter readback mismatches", () => {
    let currentTarget: number | null = 12;
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: () => {
        assignmentCount += 1;
        // Simulate a partial implementation silently ignoring the request.
      },
    });

    expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
      status: "error",
      observedTargetMs: 12,
    });
    expect(assignmentCount).toBe(1);
    expect(currentTarget).toBe(12);
  });

  it("catches broken feature probes without disrupting the call", () => {
    const receiver = new Proxy(
      {},
      {
        has: () => {
          throw new Error("blocked");
        },
      },
    );

    expect(() =>
      applyVideoReceiverJitterBufferTarget(receiver, 40),
    ).not.toThrow();
    expect(applyVideoReceiverJitterBufferTarget(receiver, 40)).toEqual({
      status: "error",
      observedTargetMs: null,
    });
  });
});

describe("reconcileVideoReceiverJitterBufferTarget", () => {
  it("reads back a cached request and repairs same-target receiver drift", () => {
    let currentTarget: number | null = null;
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        currentTarget = value;
      },
    });

    const initial = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: null,
      nowMs: 0,
    });
    expect(initial.status).toBe("applied");
    expect(initial.observedTargetMs).toBe(40);
    expect(assignmentCount).toBe(1);

    currentTarget = 8;
    const repaired = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: initial.nextState,
      nowMs: 2_500,
    });
    expect(repaired.status).toBe("applied");
    expect(repaired.observedTargetMs).toBe(40);
    expect(currentTarget).toBe(40);
    expect(assignmentCount).toBe(2);

    const stable = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: repaired.nextState,
      nowMs: 5_000,
    });
    expect(stable.status).toBe("unchanged");
    expect(stable.observedTargetMs).toBe(40);
    expect(assignmentCount).toBe(2);
  });

  it("retries transient errors after backoff instead of caching forever", () => {
    let currentTarget: number | null = null;
    let assignmentCount = 0;
    let throwOnAssignment = true;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        if (throwOnAssignment) throw new Error("temporarily unavailable");
        currentTarget = value;
      },
    });

    const failed = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: null,
      nowMs: 100,
    });
    expect(failed.status).toBe("error");
    expect(failed.nextState?.errorAttempt).toBe(1);
    expect(failed.nextState?.retryAtMs).toBe(
      100 + VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS,
    );
    expect(assignmentCount).toBe(1);

    throwOnAssignment = false;
    const deferred = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: failed.nextState,
      nowMs: 100 + VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS - 1,
    });
    expect(deferred.status).toBe("error");
    expect(deferred.nextState).toBe(failed.nextState);
    expect(assignmentCount).toBe(1);

    const retried = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: deferred.nextState,
      nowMs: 100 + VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS,
    });
    expect(retried.status).toBe("applied");
    expect(retried.observedTargetMs).toBe(40);
    expect(retried.nextState?.errorAttempt).toBe(0);
    expect(retried.nextState?.retryAtMs).toBeNull();
    expect(assignmentCount).toBe(2);
  });

  it("caps repeated error backoff while continuing to retry", () => {
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => null,
      set: () => {
        assignmentCount += 1;
        throw new Error("still unavailable");
      },
    });
    let previousState: VideoJitterBufferTargetState | null = null;
    let nowMs = 0;
    let lastDelayMs = 0;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const result = reconcileVideoReceiverJitterBufferTarget({
        consumerId: "consumer-1",
        receiver,
        requestedTargetMs: 40,
        previousState,
        nowMs,
      });
      expect(result.status).toBe("error");
      expect(result.nextState?.errorAttempt).toBe(attempt);
      lastDelayMs = (result.nextState?.retryAtMs ?? nowMs) - nowMs;
      expect(lastDelayMs).toBeLessThanOrEqual(
        VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS,
      );
      previousState = result.nextState;
      nowMs = result.nextState?.retryAtMs ?? nowMs;
    }

    expect(lastDelayMs).toBe(VIDEO_JITTER_BUFFER_RETRY_MAX_DELAY_MS);
    expect(assignmentCount).toBe(8);
  });

  it("clears unsupported tracking on disable so re-enable probes again", () => {
    const receiver = {} as { jitterBufferTarget?: number | null };
    const unsupported = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: null,
      nowMs: 0,
    });
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.nextState?.status).toBe("unsupported");

    const disabled = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: null,
      previousState: unsupported.nextState,
      nowMs: 1,
    });
    expect(disabled.status).toBe("unsupported");
    expect(disabled.nextState).toBeNull();

    receiver.jitterBufferTarget = null;
    const reenabled = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: disabled.nextState,
      nowMs: 2,
    });
    expect(reenabled.status).toBe("applied");
    expect(reenabled.observedTargetMs).toBe(40);
  });

  it("clears error backoff on disable so re-enable retries immediately", () => {
    let currentTarget: number | null = null;
    let assignmentCount = 0;
    let throwOnAssignment = true;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        if (throwOnAssignment) throw new Error("temporarily unavailable");
        currentTarget = value;
      },
    });
    const failed = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: null,
      nowMs: 0,
    });
    expect(failed.status).toBe("error");
    expect(failed.nextState?.retryAtMs).toBe(
      VIDEO_JITTER_BUFFER_RETRY_BASE_DELAY_MS,
    );

    throwOnAssignment = false;
    const disabled = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: null,
      previousState: failed.nextState,
      nowMs: 100,
    });
    expect(disabled.status).toBe("unchanged");
    expect(disabled.nextState).toBeNull();

    const reenabled = reconcileVideoReceiverJitterBufferTarget({
      consumerId: "consumer-1",
      receiver,
      requestedTargetMs: 40,
      previousState: disabled.nextState,
      nowMs: 101,
    });
    expect(reenabled.status).toBe("applied");
    expect(reenabled.observedTargetMs).toBe(40);
    expect(assignmentCount).toBe(2);
  });
});

describe("releaseVideoReceiverJitterBufferTargetState", () => {
  const trackedState = (
    consumerId: string,
    receiver: unknown,
  ): VideoJitterBufferTargetState => ({
    consumerId,
    receiver,
    requestedTargetMs: 40,
    status: "applied",
    observedTargetMs: 40,
    errorAttempt: 0,
    retryAtMs: null,
  });

  it("does not reset or delete a replacement for a stale old-consumer removal", () => {
    let currentTarget: number | null = 40;
    let assignmentCount = 0;
    const replacementReceiver = Object.defineProperty(
      {},
      "jitterBufferTarget",
      {
        configurable: true,
        get: () => currentTarget,
        set: (value: number | null) => {
          assignmentCount += 1;
          currentTarget = value;
        },
      },
    );
    const replacementState = trackedState(
      "replacement-consumer",
      replacementReceiver,
    );

    const nextState = releaseVideoReceiverJitterBufferTargetState({
      removingConsumerId: "old-consumer",
      receiverClosed: false,
      currentState: replacementState,
    });

    expect(nextState).toBe(replacementState);
    expect(currentTarget).toBe(40);
    expect(assignmentCount).toBe(0);
  });

  it("resets a matching live receiver before clearing its bookkeeping", () => {
    let currentTarget: number | null = 40;
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        currentTarget = value;
      },
    });

    const nextState = releaseVideoReceiverJitterBufferTargetState({
      removingConsumerId: "consumer-1",
      receiverClosed: false,
      currentState: trackedState("consumer-1", receiver),
    });

    expect(nextState).toBeNull();
    expect(currentTarget).toBeNull();
    expect(assignmentCount).toBe(1);
  });

  it("only clears bookkeeping for a matching receiver that is already closed", () => {
    let currentTarget: number | null = 40;
    let assignmentCount = 0;
    const receiver = Object.defineProperty({}, "jitterBufferTarget", {
      configurable: true,
      get: () => currentTarget,
      set: (value: number | null) => {
        assignmentCount += 1;
        currentTarget = value;
      },
    });

    const nextState = releaseVideoReceiverJitterBufferTargetState({
      removingConsumerId: "consumer-1",
      receiverClosed: true,
      currentState: trackedState("consumer-1", receiver),
    });

    expect(nextState).toBeNull();
    expect(currentTarget).toBe(40);
    expect(assignmentCount).toBe(0);
  });
});
