export const BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS = 180;

export type BackgroundAudioBufferApplyStatus =
  | "applied"
  | "unchanged"
  | "reset"
  | "unsupported"
  | "error";

export type BackgroundAudioBufferApplyResult = {
  status: BackgroundAudioBufferApplyStatus;
  observedTargetMs: number | null;
};

type ReceiverWithJitterBufferTarget = {
  jitterBufferTarget: DOMHighResTimeStamp | null;
};

/**
 * Gives hidden meeting tabs enough received-audio headroom to tolerate browser
 * scheduling jitter. Returning to the foreground restores browser-controlled
 * buffering so interactive latency does not stay elevated.
 */
export const applyBackgroundAudioBuffer = (
  receiver: unknown,
  isDocumentVisible: boolean,
): BackgroundAudioBufferApplyResult => {
  if (
    (typeof receiver !== "object" || receiver === null) &&
    typeof receiver !== "function"
  ) {
    return { status: "unsupported", observedTargetMs: null };
  }

  try {
    if (!("jitterBufferTarget" in receiver)) {
      return { status: "unsupported", observedTargetMs: null };
    }

    const targetReceiver = receiver as ReceiverWithJitterBufferTarget;
    const currentTarget = targetReceiver.jitterBufferTarget;
    if (
      currentTarget !== null &&
      (typeof currentTarget !== "number" || !Number.isFinite(currentTarget))
    ) {
      return { status: "error", observedTargetMs: null };
    }

    const requestedTarget = isDocumentVisible
      ? null
      : BACKGROUND_AUDIO_JITTER_BUFFER_TARGET_MS;
    if (currentTarget === requestedTarget) {
      return { status: "unchanged", observedTargetMs: currentTarget };
    }

    targetReceiver.jitterBufferTarget = requestedTarget;
    const observedTarget = targetReceiver.jitterBufferTarget;
    if (observedTarget !== requestedTarget) {
      return { status: "error", observedTargetMs: observedTarget };
    }

    return {
      status: requestedTarget === null ? "reset" : "applied",
      observedTargetMs: observedTarget,
    };
  } catch {
    return { status: "error", observedTargetMs: null };
  }
};
