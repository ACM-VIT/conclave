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
  holdTracks(stream.getTracks());
  return stream;
};

const holdTracks = (tracks: MediaStreamTrack[]) => {
  for (const track of heldTracks) {
    if (track.readyState === "ended") heldTracks.delete(track);
  }
  tracks.forEach((track) => heldTracks.add(track));
};

const holdDerived = (requestedIn: number, tracks: MediaStreamTrack[]): void => {
  if (requestedIn !== generation) {
    tracks.forEach(stopTrack);
    throw new CaptureReleasedError();
  }
  holdTracks(tracks);
};

export const createHeldDestination = (
  context: AudioContext,
  requestedIn: number,
): MediaStreamAudioDestinationNode => {
  const node = context.createMediaStreamDestination();
  holdDerived(requestedIn, node.stream.getTracks());
  return node;
};

export const captureHeldCanvas = (
  canvas: HTMLCanvasElement,
  frameRate: number | undefined,
  requestedIn: number,
): MediaStream => {
  const stream = canvas.captureStream(frameRate);
  holdDerived(requestedIn, stream.getTracks());
  return stream;
};

export const createHeldTrackGenerator = <Init, Track extends MediaStreamTrack>(
  Generator: new (init: Init) => Track,
  init: Init,
  requestedIn: number,
): Track => {
  const track = new Generator(init);
  holdDerived(requestedIn, [track]);
  return track;
};

export const holdClone = (track: MediaStreamTrack, requestedIn: number): MediaStreamTrack => {
  const clone = track.clone();
  holdDerived(requestedIn, [clone]);
  return clone;
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
