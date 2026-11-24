const heldTracks = new Set<MediaStreamTrack>();
const releaseListeners = new Set<() => void>();
let generation = 0;

const stopTrack = (track: MediaStreamTrack) => {
  try {
    track.stop();
  } catch {}
};

const releasedError = () =>
  new DOMException("The call ended before this capture started.", "AbortError");

const hold = async (request: Promise<MediaStream>): Promise<MediaStream> => {
  const requestedIn = generation;
  const stream = await request;
  if (requestedIn !== generation) {
    stream.getTracks().forEach(stopTrack);
    throw releasedError();
  }
  for (const track of heldTracks) {
    if (track.readyState === "ended") heldTracks.delete(track);
  }
  stream.getTracks().forEach((track) => heldTracks.add(track));
  return stream;
};

export const captureUserMedia = (
  constraints: MediaStreamConstraints,
): Promise<MediaStream> => hold(navigator.mediaDevices.getUserMedia(constraints));

export const captureDisplayMedia = (
  options?: DisplayMediaStreamOptions,
): Promise<MediaStream> => hold(navigator.mediaDevices.getDisplayMedia(options));

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
