const heldTracks = new Set<MediaStreamTrack>();
const releaseListeners = new Set<() => void>();
let generation = 0;

const stopTrack = (track: MediaStreamTrack) => {
  try {
    track.stop();
  } catch {}
};

export class CaptureReleasedError extends Error {
  constructor() {
    super("The call ended before this capture started.");
    this.name = "AbortError";
  }
}

export const isCaptureReleased = (error: unknown): boolean => error instanceof CaptureReleasedError;

export const captureGeneration = (): number => generation;

const hold = async (requestedIn: number, request: () => Promise<MediaStream>): Promise<MediaStream> => {
  if (requestedIn !== generation) throw new CaptureReleasedError();
  const stream = await request();
  if (requestedIn !== generation) {
    stream.getTracks().forEach(stopTrack);
    throw new CaptureReleasedError();
  }
  for (const track of heldTracks) {
    if (track.readyState === "ended") heldTracks.delete(track);
  }
  stream.getTracks().forEach((track) => heldTracks.add(track));
  return stream;
};

export const captureUserMedia = (
  constraints: MediaStreamConstraints,
  requestedIn = generation,
): Promise<MediaStream> => hold(requestedIn, () => navigator.mediaDevices.getUserMedia(constraints));

export const captureDisplayMedia = (
  options?: DisplayMediaStreamOptions,
  requestedIn = generation,
): Promise<MediaStream> => hold(requestedIn, () => navigator.mediaDevices.getDisplayMedia(options));

export const onCapturesReleased = (listener: () => void): (() => void) => {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
};

export const releaseAllCaptures = (): void => {
  generation += 1;
  for (const listener of [...releaseListeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[Meets] A capture owner failed to release:", error);
    }
  }
  const tracks = [...heldTracks];
  heldTracks.clear();
  tracks.forEach(stopTrack);
};
