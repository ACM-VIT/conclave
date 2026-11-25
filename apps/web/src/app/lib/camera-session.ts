export type CameraSession = {
  run: <T>(operation: () => Promise<T>) => Promise<T>;
  admit: (tracks: readonly MediaStreamTrack[]) => void;
  own: (track: MediaStreamTrack, origin?: MediaStreamTrack | null) => void;
  originOf: (track: MediaStreamTrack) => MediaStreamTrack | null;
  keepOnly: (keep: ReadonlySet<MediaStreamTrack>) => void;
  drain: () => void;
};

type CameraSessionOptions = {
  isChosen: () => boolean;
  committed: () => MediaStreamTrack | null;
  stop: (track: MediaStreamTrack) => void;
  reconcile: () => Promise<void>;
};

export const createCameraSession = ({
  isChosen,
  committed,
  stop,
  reconcile,
}: CameraSessionOptions): CameraSession => {
  const owned = new Map<MediaStreamTrack, MediaStreamTrack | null>();
  let tail: Promise<unknown> = Promise.resolve();

  const forgetEnded = () => {
    for (const track of owned.keys()) {
      if (track.readyState === "ended") owned.delete(track);
    }
  };

  const keepOnly = (keep: ReadonlySet<MediaStreamTrack>) => {
    for (const track of [...owned.keys()]) {
      if (keep.has(track)) continue;
      owned.delete(track);
      stop(track);
    }
  };

  const own = (track: MediaStreamTrack, origin: MediaStreamTrack | null = null) => {
    forgetEnded();
    if (!owned.has(track) || origin) owned.set(track, origin);
  };

  return {
    run: <T,>(operation: () => Promise<T>): Promise<T> => {
      const job = tail.then(async () => {
        const camera = committed();
        if (camera) own(camera);
        try {
          return await operation();
        } finally {
          await reconcile().catch(() => {});
        }
      });
      tail = job.catch(() => {});
      return job;
    },
    admit: (tracks) => {
      for (const track of tracks) {
        if (track.kind !== "video") continue;
        if (isChosen()) {
          own(track);
        } else {
          stop(track);
        }
      }
    },
    own,
    originOf: (track) => owned.get(track) ?? null,
    keepOnly,
    drain: () => keepOnly(new Set()),
  };
};
