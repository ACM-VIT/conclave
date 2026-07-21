export type VideoFreezeRecoveryState = {
  frames: number;
  bytes: number;
  stalls: number;
  lastKeyFrameRequestAt: number;
  keyFrameRequestsWithoutProgress: number;
};

export type VideoFreezeRecoveryAction =
  | "none"
  | "request-key-frame"
  | "reconsume";

export const MAX_VIDEO_FREEZE_KEYFRAME_REQUESTS = 2;
export const MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS = 2;

export const advanceVideoFreezeRecovery = ({
  previous,
  frames,
  bytes,
  now,
  keyFrameRequestCooldownMs,
  minimumStallByteDelta,
  stallSamplesBeforeKeyFrame,
  maxKeyFrameRequests = MAX_VIDEO_FREEZE_KEYFRAME_REQUESTS,
}: {
  previous: VideoFreezeRecoveryState | null;
  frames: number;
  bytes: number;
  now: number;
  keyFrameRequestCooldownMs: number;
  minimumStallByteDelta: number;
  stallSamplesBeforeKeyFrame: number;
  maxKeyFrameRequests?: number;
}): {
  action: VideoFreezeRecoveryAction;
  state: VideoFreezeRecoveryState;
} => {
  if (!previous || frames < previous.frames || bytes < previous.bytes) {
    return {
      action: "none",
      state: {
        frames,
        bytes,
        stalls: 0,
        lastKeyFrameRequestAt: 0,
        keyFrameRequestsWithoutProgress: 0,
      },
    };
  }

  const decodedFrameProgress = frames > previous.frames;
  const decoderStuck =
    !decodedFrameProgress &&
    frames === previous.frames &&
    bytes - previous.bytes >= minimumStallByteDelta;
  const stalls = decoderStuck ? previous.stalls + 1 : 0;
  const keyFrameRequestsWithoutProgress = decodedFrameProgress
    ? 0
    : previous.keyFrameRequestsWithoutProgress;
  const baseState: VideoFreezeRecoveryState = {
    frames,
    bytes,
    stalls,
    lastKeyFrameRequestAt: previous.lastKeyFrameRequestAt,
    keyFrameRequestsWithoutProgress,
  };

  if (
    stalls < stallSamplesBeforeKeyFrame ||
    now - previous.lastKeyFrameRequestAt < keyFrameRequestCooldownMs
  ) {
    return { action: "none", state: baseState };
  }

  if (keyFrameRequestsWithoutProgress >= maxKeyFrameRequests) {
    return {
      action: "reconsume",
      state: {
        ...baseState,
        stalls: 0,
      },
    };
  }

  return {
    action: "request-key-frame",
    state: {
      ...baseState,
      stalls: 0,
      lastKeyFrameRequestAt: now,
      keyFrameRequestsWithoutProgress:
        keyFrameRequestsWithoutProgress + 1,
    },
  };
};

export const getScreenShareStallRecoveryAction = (
  trackRefreshAttemptsWithoutProgress: number,
  maxTrackRefreshAttempts = MAX_SCREEN_SHARE_TRACK_REFRESH_ATTEMPTS,
): "refresh-track" | "republish" =>
  trackRefreshAttemptsWithoutProgress >= maxTrackRefreshAttempts
    ? "republish"
    : "refresh-track";

export const advanceScreenShareTrackRefreshAttempts = ({
  currentAttempts,
  encodedFrameProgress = false,
  refreshAttempted = false,
}: {
  currentAttempts: number;
  encodedFrameProgress?: boolean;
  refreshAttempted?: boolean;
}): number => {
  if (encodedFrameProgress) return 0;
  if (refreshAttempted) return currentAttempts + 1;
  return currentAttempts;
};

export const shouldRecreateProducerTransport = ({
  hasUsableTransport,
  pendingCameraCodecResetEpoch,
  forCameraPublish,
}: {
  hasUsableTransport: boolean;
  pendingCameraCodecResetEpoch: number | null;
  forCameraPublish: boolean;
}): boolean =>
  !hasUsableTransport ||
  (forCameraPublish && pendingCameraCodecResetEpoch !== null);

const requestedCaptureValue = (constraint: unknown): number | null => {
  if (typeof constraint === "number" && Number.isFinite(constraint)) {
    return constraint;
  }
  if (!constraint || typeof constraint !== "object") return null;
  const value = constraint as {
    exact?: unknown;
    min?: unknown;
    ideal?: unknown;
  };
  for (const candidate of [value.exact, value.min, value.ideal]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * A failed adaptive downshift must not replace a healthy camera track: sender
 * scaling and bitrate caps can apply immediately without a visible source gap.
 * Reopen only when the track died or a live low-resolution capture genuinely
 * cannot satisfy an attempted quality upgrade.
 */
export const shouldReopenCameraAfterConstraintFailure = ({
  trackReadyState,
  currentSettings,
  targetConstraints,
}: {
  trackReadyState: MediaStreamTrackState | null;
  currentSettings: Pick<
    MediaTrackSettings,
    "width" | "height" | "frameRate"
  > | null;
  targetConstraints: Pick<
    MediaTrackConstraints,
    "width" | "height" | "frameRate"
  >;
}): boolean => {
  if (trackReadyState !== "live") return true;
  if (!currentSettings) return false;
  return ([
    [currentSettings.width, targetConstraints.width],
    [currentSettings.height, targetConstraints.height],
    [currentSettings.frameRate, targetConstraints.frameRate],
  ] as const).some(([current, target]) => {
    const requested = requestedCaptureValue(target);
    return (
      requested !== null &&
      typeof current === "number" &&
      Number.isFinite(current) &&
      current < requested
    );
  });
};
