type PresentationWaiter = {
  settle: (result: RemoteVideoPresentationResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const presentationWaiters = new WeakMap<MediaStream, Set<PresentationWaiter>>();
const presentationObserverCounts = new WeakMap<MediaStream, number>();

export type RemoteVideoPresentationResult =
  | "presented"
  | "observed-timeout"
  | "unobserved";

const removeWaiter = (stream: MediaStream, waiter: PresentationWaiter) => {
  const waiters = presentationWaiters.get(stream);
  if (!waiters) return;
  waiters.delete(waiter);
  if (waiters.size === 0) {
    presentationWaiters.delete(stream);
  }
};

/**
 * Waits for a rendered video element to present the replacement stream. The
 * bounded false result is valid for streams that have no mounted tile (for
 * example an offscreen overflow participant).
 */
export const waitForRemoteVideoPresentation = ({
  stream,
  timeoutMs,
}: {
  stream: MediaStream;
  timeoutMs: number;
}): Promise<RemoteVideoPresentationResult> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: RemoteVideoPresentationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timeoutId);
      removeWaiter(stream, waiter);
      resolve(result);
    };
    const waiter: PresentationWaiter = {
      settle,
      timeoutId: setTimeout(
        () =>
          settle(
            (presentationObserverCounts.get(stream) ?? 0) > 0
              ? "observed-timeout"
              : "unobserved",
          ),
        Math.max(1, timeoutMs),
      ),
    };
    const waiters = presentationWaiters.get(stream) ?? new Set();
    waiters.add(waiter);
    presentationWaiters.set(stream, waiters);
  });

export const notifyRemoteVideoPresented = (stream: MediaStream): void => {
  const waiters = presentationWaiters.get(stream);
  if (!waiters) return;
  for (const waiter of [...waiters]) {
    waiter.settle("presented");
  }
};

/**
 * Arms before playback starts and resolves handoff waiters only after the
 * compositor exposes a frame belonging to this exact MediaStream.
 */
export const observeRemoteVideoPresentation = (
  video: HTMLVideoElement,
  stream: MediaStream,
): (() => void) => {
  let cancelled = false;
  let callbackId: number | null = null;
  presentationObserverCounts.set(
    stream,
    (presentationObserverCounts.get(stream) ?? 0) + 1,
  );
  const presented = () => {
    if (cancelled || video.srcObject !== stream) return;
    notifyRemoteVideoPresented(stream);
  };

  if (typeof video.requestVideoFrameCallback === "function") {
    callbackId = video.requestVideoFrameCallback(() => presented());
  } else {
    video.addEventListener("loadeddata", presented);
    video.addEventListener("playing", presented);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      requestAnimationFrame(presented);
    }
  }

  return () => {
    cancelled = true;
    const observerCount = presentationObserverCounts.get(stream) ?? 0;
    if (observerCount <= 1) {
      presentationObserverCounts.delete(stream);
    } else {
      presentationObserverCounts.set(stream, observerCount - 1);
    }
    if (
      callbackId !== null &&
      typeof video.cancelVideoFrameCallback === "function"
    ) {
      video.cancelVideoFrameCallback(callbackId);
    }
    video.removeEventListener("loadeddata", presented);
    video.removeEventListener("playing", presented);
  };
};
