export const MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS = 60000;
export const MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS = 15000;

type GetUserMediaWithTimeoutOptions = {
  label: string;
  timeoutMs: number;
};

const createMediaCaptureTimeoutError = (
  label: string,
  timeoutMs: number,
) => {
  const error = new Error(
    `${label} did not respond within ${Math.round(timeoutMs / 1000)}s`,
  );
  error.name = "TimeoutError";
  return error;
};

export const isMediaCaptureTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: unknown; message?: unknown };
  return (
    named.name === "TimeoutError" ||
    (typeof named.message === "string" &&
      /did not respond within \d+s|timed out/i.test(named.message))
  );
};

const stopMediaStreamTracks = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
};

export const getUserMediaWithTimeout = async (
  constraints: MediaStreamConstraints,
  options: GetUserMediaWithTimeoutOptions,
): Promise<MediaStream> => {
  let timedOut = false;
  let timeoutId: number | null = null;
  const mediaPromise = navigator.mediaDevices.getUserMedia(constraints);

  mediaPromise.then(
    (stream) => {
      if (!timedOut) return;
      stopMediaStreamTracks(stream);
      console.warn("[Meets] Stopped late media capture after timeout:", {
        label: options.label,
        tracks: stream.getTracks().map((track) => ({
          id: track.id,
          kind: track.kind,
          readyState: track.readyState,
        })),
      });
    },
    (error: unknown) => {
      if (!timedOut) return;
      console.warn("[Meets] Late media capture failed after timeout:", {
        label: options.label,
        error,
      });
    },
  );

  const timeoutPromise = new Promise<MediaStream>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true;
      reject(createMediaCaptureTimeoutError(options.label, options.timeoutMs));
    }, options.timeoutMs);
  });

  try {
    return await Promise.race([mediaPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
};
