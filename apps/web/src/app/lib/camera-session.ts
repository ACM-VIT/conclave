export type CameraCaptureHolder = "queue" | "requester";

export type CameraSession = {
  run: <T>(operation: () => Promise<T>) => Promise<T>;
  admit: (tracks: readonly MediaStreamTrack[], holder: CameraCaptureHolder) => void;
  own: (track: MediaStreamTrack, origin: MediaStreamTrack) => void;
  originOf: (track: MediaStreamTrack) => MediaStreamTrack | null;
  release: () => void;
  drain: () => void;
};

type CameraSessionOptions = {
  isChosen: () => boolean;
  committed: () => MediaStreamTrack | null;
  sent: () => MediaStreamTrack | null;
  stop: (track: MediaStreamTrack) => void;
  reconcile: () => Promise<void>;
};

type Holding = {
  origin: MediaStreamTrack | null;
  heldByRequester: boolean;
};

export const createCameraSession = ({
  isChosen,
  committed,
  sent,
  stop,
  reconcile,
}: CameraSessionOptions): CameraSession => {
  const owned = new Map<MediaStreamTrack, Holding>();
  let tail: Promise<unknown> = Promise.resolve();

  const takeOver = (track: MediaStreamTrack) => {
    owned.set(track, { origin: owned.get(track)?.origin ?? null, heldByRequester: false });
  };

  const release = () => {
    const shown = committed();
    if (shown) takeOver(shown);
    const sending = sent();
    for (const [track, holding] of [...owned]) {
      if (track.readyState === "ended") {
        owned.delete(track);
        continue;
      }
      if (track === shown || track === sending || holding.heldByRequester) continue;
      owned.delete(track);
      stop(track);
    }
  };

  return {
    run: <T,>(operation: () => Promise<T>): Promise<T> => {
      const job = tail.then(async () => {
        const shown = committed();
        if (shown) takeOver(shown);
        try {
          return await operation();
        } finally {
          await reconcile().catch(() => {});
        }
      });
      tail = job.catch(() => {});
      return job;
    },
    admit: (tracks, holder) => {
      for (const track of tracks) {
        if (track.kind !== "video") continue;
        if (isChosen()) {
          owned.set(track, { origin: null, heldByRequester: holder === "requester" });
        } else {
          stop(track);
        }
      }
    },
    own: (track, origin) => {
      owned.set(track, { origin, heldByRequester: false });
    },
    originOf: (track) => owned.get(track)?.origin ?? null,
    release,
    drain: () => {
      for (const track of [...owned.keys()]) {
        owned.delete(track);
        stop(track);
      }
    },
  };
};
