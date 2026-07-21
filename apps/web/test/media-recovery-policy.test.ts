import { describe, expect, it } from "vitest";
import {
  advanceScreenShareTrackRefreshAttempts,
  advanceVideoFreezeRecovery,
  getScreenShareStallRecoveryAction,
  shouldReopenCameraAfterConstraintFailure,
  shouldRecreateProducerTransport,
  type VideoFreezeRecoveryState,
} from "../src/app/lib/media-recovery-policy";

const freezeState = (
  overrides: Partial<VideoFreezeRecoveryState> = {},
): VideoFreezeRecoveryState => ({
  frames: 100,
  bytes: 100_000,
  stalls: 0,
  lastKeyFrameRequestAt: 0,
  keyFrameRequestsWithoutProgress: 0,
  ...overrides,
});

const advance = (
  previous: VideoFreezeRecoveryState | null,
  overrides: Partial<{
    frames: number;
    bytes: number;
    now: number;
  }> = {},
) =>
  advanceVideoFreezeRecovery({
    previous,
    frames: overrides.frames ?? 100,
    bytes: overrides.bytes ?? 110_000,
    now: overrides.now ?? 10_000,
    keyFrameRequestCooldownMs: 3_500,
    minimumStallByteDelta: 8_000,
    stallSamplesBeforeKeyFrame: 1,
  });

describe("video freeze recovery", () => {
  it("requests a bounded key frame before escalating", () => {
    const first = advance(freezeState());
    expect(first.action).toBe("request-key-frame");
    expect(first.state.keyFrameRequestsWithoutProgress).toBe(1);

    const second = advance(first.state, {
      bytes: 120_000,
      now: 14_000,
    });
    expect(second.action).toBe("request-key-frame");
    expect(second.state.keyFrameRequestsWithoutProgress).toBe(2);

    const third = advance(second.state, {
      bytes: 130_000,
      now: 18_000,
    });
    expect(third.action).toBe("reconsume");
  });

  it("resets the escalation budget as soon as decoding advances", () => {
    const recovered = advance(
      freezeState({
        keyFrameRequestsWithoutProgress: 2,
        lastKeyFrameRequestAt: 8_000,
      }),
      { frames: 101, bytes: 110_000, now: 10_000 },
    );

    expect(recovered.action).toBe("none");
    expect(recovered.state.keyFrameRequestsWithoutProgress).toBe(0);
    expect(recovered.state.stalls).toBe(0);
  });

  it("does not spend retries on padding or low-rate idle traffic", () => {
    const idle = advance(freezeState(), {
      bytes: 106_000,
      now: 10_000,
    });

    expect(idle.action).toBe("none");
    expect(idle.state.keyFrameRequestsWithoutProgress).toBe(0);
  });

  it("honors the key-frame cooldown between attempts", () => {
    const coolingDown = advance(
      freezeState({
        lastKeyFrameRequestAt: 8_000,
        keyFrameRequestsWithoutProgress: 1,
      }),
      { bytes: 110_000, now: 10_000 },
    );

    expect(coolingDown.action).toBe("none");
    expect(coolingDown.state.keyFrameRequestsWithoutProgress).toBe(1);
  });
});

describe("screen-share sender recovery", () => {
  it("uses bounded in-place refreshes before a full republish", () => {
    expect(getScreenShareStallRecoveryAction(0)).toBe("refresh-track");
    expect(getScreenShareStallRecoveryAction(1)).toBe("refresh-track");
    expect(getScreenShareStallRecoveryAction(2)).toBe("republish");
  });

  it("counts failed and successful refresh attempts until frames advance", () => {
    const afterFirstRefresh = advanceScreenShareTrackRefreshAttempts({
      currentAttempts: 0,
      refreshAttempted: true,
    });
    const afterSecondRefresh = advanceScreenShareTrackRefreshAttempts({
      currentAttempts: afterFirstRefresh,
      refreshAttempted: true,
    });

    expect(afterSecondRefresh).toBe(2);
    expect(
      advanceScreenShareTrackRefreshAttempts({
        currentAttempts: afterSecondRefresh,
        encodedFrameProgress: true,
      }),
    ).toBe(0);
  });
});

describe("pending camera codec transport reset", () => {
  it("keeps a usable shared transport flowing for non-camera publishers", () => {
    expect(
      shouldRecreateProducerTransport({
        hasUsableTransport: true,
        pendingCameraCodecResetEpoch: 7,
        forCameraPublish: false,
      }),
    ).toBe(false);
  });

  it("requires a fresh transport before the next camera publish", () => {
    expect(
      shouldRecreateProducerTransport({
        hasUsableTransport: true,
        pendingCameraCodecResetEpoch: 7,
        forCameraPublish: true,
      }),
    ).toBe(true);
  });

  it("creates a transport for any publisher when none is usable", () => {
    expect(
      shouldRecreateProducerTransport({
        hasUsableTransport: false,
        pendingCameraCodecResetEpoch: 7,
        forCameraPublish: false,
      }),
    ).toBe(true);
  });
});

describe("adaptive camera constraint fallback", () => {
  it("preserves a live high-resolution track during a failed downshift", () => {
    expect(
      shouldReopenCameraAfterConstraintFailure({
        trackReadyState: "live",
        currentSettings: { width: 1280, height: 720, frameRate: 30 },
        targetConstraints: {
          width: { ideal: 426, max: 426 },
          height: { ideal: 240, max: 240 },
          frameRate: { ideal: 12, max: 12 },
        },
      }),
    ).toBe(false);
  });

  it("reopens a dead track or a low capture that cannot upgrade", () => {
    const targetConstraints = {
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    } satisfies MediaTrackConstraints;
    expect(
      shouldReopenCameraAfterConstraintFailure({
        trackReadyState: "live",
        currentSettings: { width: 426, height: 240, frameRate: 12 },
        targetConstraints,
      }),
    ).toBe(true);
    expect(
      shouldReopenCameraAfterConstraintFailure({
        trackReadyState: "ended",
        currentSettings: { width: 1280, height: 720, frameRate: 30 },
        targetConstraints,
      }),
    ).toBe(true);
  });
});
