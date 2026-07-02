import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import {
  advanceQueue,
  expectedPosition,
  getPlayback,
  getQueue,
  writePlayback,
} from "../../core/doc/index";
import type { PlaybackRecord, PlaybackState } from "../../core/model/types";

// If the local player drifts more than this from the extrapolated doc position,
// we seek. 1.5s absorbs buffering jitter while keeping everyone visibly in sync.
const DRIFT_THRESHOLD_SECONDS = 1.5;

// While the doc record has not changed, never hard-seek more often than this.
// A genuinely stuck player still converges (the anchored expected position is
// monotonic), but a pathological source can no longer thrash seek after seek.
const CORRECTION_COOLDOWN_MS = 2_500;

// Never seek into the last moments of a finite video: the YouTube embed treats
// past-the-end seeks unpredictably (sometimes restarting at 0), and the ENDED
// event should be the thing that closes a video out.
const END_GUARD_SECONDS = 0.75;

// How long after asking for playback we wait before deciding the browser
// blocked autoplay and a user gesture is required.
const AUTOPLAY_PROBE_MS = 1200;

export type GestureNeed = "none" | "sound" | "sync";

/**
 * The media element react-player v3 renders (youtube-video-element) implements
 * the HTMLMediaElement interface: `currentTime` is readable AND assignable
 * (assigning seeks), `play`/`pause` are promises, `paused`/`muted`/`duration`
 * read live state. That is the whole surface this hook needs.
 */
export type WatchMediaElement = Pick<
  HTMLVideoElement,
  | "currentTime"
  | "duration"
  | "paused"
  | "muted"
  | "play"
  | "pause"
  | "seeking"
  | "textTracks"
>;

type MediaEvent = React.SyntheticEvent<HTMLVideoElement>;

export type SyncedPlaybackHandle = {
  /** Callback ref for `<ReactPlayer ref>`; captures the media element. */
  attachPlayer: (element: WatchMediaElement | null) => void;

  /* ---- Declarative props for <ReactPlayer>. The player FOLLOWS the doc; it
     never leads. All intent enters through the actions below, which write the
     doc first, so there is no echo problem by construction. ---- */
  playing: boolean;
  mutedProp: boolean;
  /** 0..1 for the media element (the UI works in 0..100). */
  volumeProp: number;
  rate: number;

  /* ---- Media event handlers to spread onto <ReactPlayer>. ---- */
  onReady: () => void;
  onTimeUpdate: (event: MediaEvent) => void;
  onDurationChange: (event: MediaEvent) => void;
  onPlaying: () => void;
  onEnded: () => void;
  onError: (event: MediaEvent) => void;

  /* ---- UI state. ---- */
  ready: boolean;
  error: string | null;
  gestureNeed: GestureNeed;
  muted: boolean;
  /** Local volume 0..100 (never synced). */
  volume: number;
  currentTime: number;
  duration: number;
  playbackState: PlaybackState;
  /** Whether this video has caption tracks at all. */
  captionsAvailable: boolean;
  /** Whether a caption track is currently showing (local only). */
  captionsOn: boolean;
  /** The video's caption tracks, with the active one flagged. */
  captionTracks: WatchCaptionTrack[];
  /** Whether the player exposes caption font sizing. */
  captionSizeAvailable: boolean;
  /** Current caption size step (-1 small, 0 default, 2 large, 3 huge). */
  captionFontSize: number;

  /* ---- Actions (the ONLY sources of playback intent). ---- */
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  toggleMute: () => void;
  setVolume: (value: number) => void;
  toggleCaptions: () => void;
  /** Show captions in this language, or turn them off with null. */
  setCaptionTrack: (language: string | null) => void;
  setCaptionFontSize: (size: number) => void;
  resolveGesture: () => void;
};

export type WatchCaptionTrack = {
  language: string;
  label: string;
  active: boolean;
};

/**
 * Best-effort handle on the element's underlying YT player. Internal to
 * youtube-video-element, so everything is feature-detected and every call is
 * guarded; if a future version hides it, the api-backed paths simply vanish.
 */
type CaptionsApi = {
  setOption?: (module: string, option: string, value: unknown) => void;
  getOption?: (module: string, option: string) => unknown;
  loadModule?: (module: string) => void;
};

const captionsApiOf = (
  element: WatchMediaElement | null,
): CaptionsApi | null => {
  const api = (element as unknown as { api?: CaptionsApi } | null)?.api;
  return api && typeof api === "object" ? api : null;
};

type ApiCaptionState = {
  tracks: { language: string; label: string }[];
  activeLanguage: string | null;
};

/**
 * Read caption state straight from the YT player. The element only mirrors
 * YouTube's tracklist into `textTracks` during PLAYING/BUFFERING state
 * changes, and the captions module loads lazily, so on plenty of runs the DOM
 * list stays empty forever while the iframe renders captions anyway. The api
 * is the ground truth; the DOM mirror is a convenience.
 */
const readApiCaptions = (
  element: WatchMediaElement | null,
): ApiCaptionState | null => {
  const api = captionsApiOf(element);
  if (!api || typeof api.getOption !== "function") return null;
  try {
    const rawList = api.getOption("captions", "tracklist");
    if (!Array.isArray(rawList) || rawList.length === 0) return null;
    const tracks: ApiCaptionState["tracks"] = [];
    for (const entry of rawList) {
      const record = entry as {
        languageCode?: unknown;
        displayName?: unknown;
        languageName?: unknown;
      } | null;
      const language =
        record && typeof record.languageCode === "string"
          ? record.languageCode
          : null;
      if (!language) continue;
      const label =
        (record && typeof record.displayName === "string" && record.displayName) ||
        (record && typeof record.languageName === "string" && record.languageName) ||
        language;
      tracks.push({ language, label });
    }
    if (tracks.length === 0) return null;
    const active = api.getOption("captions", "track") as
      | { languageCode?: unknown }
      | null
      | undefined;
    const activeLanguage =
      active && typeof active.languageCode === "string"
        ? active.languageCode
        : null;
    return { tracks, activeLanguage };
  } catch {
    return null;
  }
};

type UseSyncedPlaybackArgs = {
  doc: Y.Doc;
  videoId: string | null;
  /** When true, actions author nothing; the player still follows the doc. */
  readOnly: boolean;
};

/**
 * The sync engine for Watch together, built on one rule: the shared doc is the
 * single source of playback intent. Our custom controls write the doc; the
 * player follows it declaratively via the `playing` prop plus drift-corrected
 * seeks. Native player controls are hidden and the iframe is click-shielded by
 * the component, so no player event is ever ambiguous user intent, which is
 * what previously forced echo-guard heuristics (and their failure modes).
 */
export function useSyncedPlayback({
  doc,
  videoId,
  readOnly,
}: UseSyncedPlaybackArgs): SyncedPlaybackHandle {
  const elementRef = useRef<WatchMediaElement | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const videoIdRef = useRef<string | null>(videoId);
  videoIdRef.current = videoId;
  // The last video this client advanced away from, so a duplicate ENDED event
  // cannot make the same client advance the queue twice.
  const advancedFromRef = useRef<string | null>(null);

  const [record, setRecord] = useState<PlaybackRecord>(() => getPlayback(doc));
  const recordRef = useRef(record);
  recordRef.current = record;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gestureNeed, setGestureNeed] = useState<GestureNeed>("none");
  // Start muted so the initial autoplay satisfies browser policy; the gesture
  // overlay lifts the mute on a real click. Volume and mute never sync.
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [volume, setVolumeState] = useState(100);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionTracks, setCaptionTracks] = useState<WatchCaptionTrack[]>([]);
  const [captionSizeAvailable, setCaptionSizeAvailable] = useState(false);
  const [captionFontSize, setCaptionFontSizeState] = useState(0);
  const captionFontSizeRef = useRef(0);
  captionFontSizeRef.current = captionFontSize;
  // The embed loads YouTube's captions module lazily (cc_load_policy 1, the
  // element's default, force-displays captions once it arrives). Each new
  // video gets one initialization pass applying the user's sticky session
  // preference, which starts as off.
  const captionsPreferredRef = useRef(false);
  const captionsInitializedForRef = useRef<string | null>(null);
  const captionsNudgedForRef = useRef<string | null>(null);
  // Declared before syncCaptionState (which runs it), assigned after the
  // callback below is created.
  const applyCaptionFontSizeRef = useRef<(() => void) | null>(null);

  // Show one track (or none) through BOTH surfaces: DOM track modes when the
  // mirror exists, and the player api directly so it also works when the
  // mirror never materialized. The two are idempotent with each other.
  const applyCaptionTrack = useCallback((language: string | null) => {
    const element = elementRef.current;
    if (!element) return;
    try {
      const domList = element.textTracks ? Array.from(element.textTracks) : [];
      for (const track of domList) {
        track.mode =
          language !== null && track.language === language
            ? "showing"
            : "disabled";
      }
    } catch {
      /* mirror not ready */
    }
    try {
      captionsApiOf(element)?.setOption?.(
        "captions",
        "track",
        language !== null ? { languageCode: language } : {},
      );
    } catch {
      /* api not ready */
    }
  }, []);

  // Read caption state from the DOM mirror AND the player api, preferring the
  // api for what is actually showing. Re-read on the safety tick, since both
  // surfaces materialize at their own pace.
  const syncCaptionState = useCallback(() => {
    const element = elementRef.current;
    if (!element) {
      setCaptionsAvailable(false);
      setCaptionsOn(false);
      setCaptionTracks([]);
      return;
    }
    let domList: TextTrack[] = [];
    try {
      domList = element.textTracks ? Array.from(element.textTracks) : [];
    } catch {
      domList = [];
    }
    const apiState = readApiCaptions(element);
    const currentVideo = videoIdRef.current;

    // Neither surface has tracks yet: nudge the captions module once per
    // video so a lazy load cannot leave the CC control missing forever while
    // the iframe renders captions on its own.
    if (
      domList.length === 0 &&
      !apiState &&
      currentVideo &&
      captionsNudgedForRef.current !== currentVideo
    ) {
      captionsNudgedForRef.current = currentVideo;
      try {
        captionsApiOf(element)?.loadModule?.("captions");
      } catch {
        /* module load is best effort */
      }
    }

    const available = domList.length > 0 || apiState !== null;
    const domShowing =
      domList.find((track) => track.mode === "showing")?.language ?? null;
    let activeLanguage = apiState?.activeLanguage ?? domShowing;

    // One-time per video: apply the sticky caption preference. The captions
    // module force-displays by default, so default-off means actively turning
    // the track off as soon as EITHER surface shows captions exist.
    if (
      available &&
      currentVideo &&
      captionsInitializedForRef.current !== currentVideo
    ) {
      captionsInitializedForRef.current = currentVideo;
      if (captionsPreferredRef.current) {
        const preferred =
          typeof navigator !== "undefined" && navigator.language
            ? navigator.language.slice(0, 2).toLowerCase()
            : "en";
        const languages =
          domList.length > 0
            ? domList.map((track) => track.language)
            : (apiState?.tracks ?? []).map((track) => track.language);
        const pick =
          languages.find((language) =>
            language?.toLowerCase().startsWith(preferred),
          ) ?? languages[0] ?? null;
        applyCaptionTrack(pick);
        activeLanguage = pick;
        applyCaptionFontSizeRef.current?.();
      } else {
        applyCaptionTrack(null);
        activeLanguage = null;
      }
    }

    setCaptionsAvailable(available);
    setCaptionsOn(activeLanguage !== null);
    setCaptionSizeAvailable(
      typeof captionsApiOf(element)?.setOption === "function",
    );
    setCaptionTracks((previous) => {
      const next: WatchCaptionTrack[] =
        domList.length > 0
          ? domList.map((track) => ({
              language: track.language,
              label: track.label || track.language,
              active: track.language === activeLanguage,
            }))
          : (apiState?.tracks ?? []).map((track) => ({
              language: track.language,
              label: track.label,
              active: track.language === activeLanguage,
            }));
      // Keep the reference stable when nothing changed, so consumers do not
      // re-render once a second.
      const same =
        previous.length === next.length &&
        previous.every(
          (track, index) =>
            track.language === next[index].language &&
            track.label === next[index].label &&
            track.active === next[index].active,
        );
      return same ? previous : next;
    });
  }, [applyCaptionTrack]);

  // The captions module forgets styling between videos; reapply the chosen
  // size whenever a track goes live.
  const applyCaptionFontSize = useCallback(() => {
    const size = captionFontSizeRef.current;
    if (size === 0) return;
    try {
      captionsApiOf(elementRef.current)?.setOption?.(
        "captions",
        "fontSize",
        size,
      );
    } catch {
      /* styling is best effort */
    }
  }, []);
  applyCaptionFontSizeRef.current = applyCaptionFontSize;

  /* ---- Drift correction, hardened against restart loops. ----
     The doc's `updatedAt` is the WRITER'S wall clock. Extrapolating from it on
     every check means a writer whose clock runs ahead freezes everyone else's
     expected position at `positionSeconds` (elapsed clamps to zero), so each
     client plays a second, gets yanked back, and loops. Instead, each distinct
     record is anchored ONCE to local receipt time; from then on the expected
     position advances on the local clock only, which makes it monotonic no
     matter whose clock wrote the record. */

  type PlaybackAnchor = {
    key: string;
    state: PlaybackState;
    rate: number;
    position: number;
    at: number;
  };

  const anchorRef = useRef<PlaybackAnchor | null>(null);
  const lastCorrectionRef = useRef<{ key: string; at: number } | null>(null);

  const anchorFor = useCallback((target: PlaybackRecord): PlaybackAnchor => {
    const key = `${target.state}|${target.positionSeconds}|${target.rate}|${target.updatedAt}`;
    const existing = anchorRef.current;
    if (existing && existing.key === key) return existing;
    const now = Date.now();
    // Sender-clock extrapolation exactly once, as a best effort for records
    // that were written before we loaded (late join). For a live write the
    // elapsed term is just network latency, and a future-skewed writer clock
    // contributes nothing because expectedPosition clamps negative elapsed.
    const anchor: PlaybackAnchor = {
      key,
      state: target.state,
      rate: target.rate,
      position: Math.max(0, expectedPosition(target, now)),
      at: now,
    };
    anchorRef.current = anchor;
    return anchor;
  }, []);

  // Seek the local player toward the doc when it has drifted too far.
  const correctDrift = useCallback(
    (target: PlaybackRecord) => {
      const element = elementRef.current;
      if (!element) return;
      const anchor = anchorFor(target);
      const now = Date.now();
      const expected =
        anchor.state === "playing"
          ? anchor.position + ((now - anchor.at) / 1000) * anchor.rate
          : anchor.position;
      if (!Number.isFinite(expected)) return;

      let current = 0;
      let elementDuration = Number.NaN;
      try {
        current = element.currentTime ?? 0;
        // A seek already in flight makes currentTime unreliable; check again
        // on the next tick instead of stacking seeks.
        if (element.seeking === true) return;
        elementDuration = element.duration;
      } catch {
        return;
      }

      // Live streams have no shared timeline to converge on; play/pause still
      // follows the doc, but position is the stream's business.
      if (elementDuration === Number.POSITIVE_INFINITY) return;

      let seekTarget = Math.max(0, expected);
      if (Number.isFinite(elementDuration) && elementDuration > END_GUARD_SECONDS * 2) {
        seekTarget = Math.min(seekTarget, elementDuration - END_GUARD_SECONDS);
      }
      if (Math.abs(current - seekTarget) <= DRIFT_THRESHOLD_SECONDS) return;

      // Fresh intent (a new record) seeks immediately; repeat corrections for
      // the SAME record are rate-limited so no failure mode can seek-loop.
      const last = lastCorrectionRef.current;
      if (last && last.key === anchor.key && now - last.at < CORRECTION_COOLDOWN_MS) {
        return;
      }
      lastCorrectionRef.current = { key: anchor.key, at: now };
      try {
        element.currentTime = seekTarget;
      } catch {
        /* element not ready to seek yet */
      }
    },
    [anchorFor],
  );

  // Follow the doc: mirror the record into state (which drives the `playing`
  // prop) and correct position drift on every remote change.
  useEffect(() => {
    const sync = () => {
      const next = getPlayback(doc);
      setRecord(next);
      correctDrift(next);
    };
    doc.on("update", sync);
    sync();
    return () => {
      doc.off("update", sync);
    };
  }, [correctDrift, doc]);

  // A gentle safety tick: keeps the time display fresh when timeupdate is
  // throttled (hidden tabs), re-checks drift while paused, and keeps polling
  // caption availability. Not gated on `ready`, so caption detection still
  // runs even if the ready event was missed; every step is element-guarded.
  useEffect(() => {
    const interval = setInterval(() => {
      const element = elementRef.current;
      if (!element) return;
      try {
        setCurrentTime(element.currentTime ?? 0);
      } catch {
        /* ignore */
      }
      correctDrift(recordRef.current);
      syncCaptionState();
    }, 1000);
    return () => clearInterval(interval);
  }, [correctDrift, syncCaptionState]);

  // A new video started: allow it to advance the queue when it ends, clear any
  // stale error from the previous one, and let the fresh element correct
  // immediately instead of inheriting the previous video's seek cooldown.
  useEffect(() => {
    if (!videoId) return;
    if (advancedFromRef.current !== videoId) {
      advancedFromRef.current = null;
    }
    lastCorrectionRef.current = null;
    setError(null);
  }, [videoId]);

  // Probe for blocked autoplay: if the room wants playback but the element is
  // still paused shortly after, a gesture is needed to start at all ("sync").
  // If it plays but only because we are muted, a gesture buys sound ("sound").
  useEffect(() => {
    if (!ready || record.state !== "playing") return;
    const timer = setTimeout(() => {
      const element = elementRef.current;
      if (!element) return;
      if (element.paused) {
        setGestureNeed((prev) => (prev === "none" ? "sync" : prev));
      } else if (mutedRef.current) {
        setGestureNeed((prev) => (prev === "none" ? "sound" : prev));
      }
    }, AUTOPLAY_PROBE_MS);
    return () => clearTimeout(timer);
  }, [ready, record.state, videoId]);

  /* ---- Media event handlers. None of these author intent; with the iframe
     shielded, player events can only be consequences of the doc. ---- */

  const onReady = useCallback(() => {
    setReady(true);
    setError(null);
    correctDrift(recordRef.current);
  }, [correctDrift]);

  const onTimeUpdate = useCallback(
    (event: MediaEvent) => {
      const element = event.currentTarget;
      setCurrentTime(element.currentTime ?? 0);
      if (recordRef.current.state === "playing") {
        correctDrift(recordRef.current);
      }
    },
    [correctDrift],
  );

  const onDurationChange = useCallback((event: MediaEvent) => {
    const value = event.currentTarget.duration;
    setDuration(typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, []);

  const onPlaying = useCallback(() => {
    // Playback genuinely running: downgrade or clear the gesture prompt.
    setGestureNeed((prev) => {
      if (prev === "none") return prev;
      return mutedRef.current ? "sound" : "none";
    });
  }, []);

  const onEnded = useCallback(() => {
    const ended = videoIdRef.current;
    if (readOnlyRef.current || !ended) return;
    if (advancedFromRef.current === ended) return;
    const queue = getQueue(doc);
    if (queue.length > 0) {
      advancedFromRef.current = ended;
      advanceQueue(doc, ended);
      return;
    }
    // Nothing queued: park the doc at the end so late joiners do not see the
    // position extrapolate past the duration forever.
    const element = elementRef.current;
    let position = 0;
    try {
      position = element?.duration ?? element?.currentTime ?? 0;
    } catch {
      position = 0;
    }
    writePlayback(doc, { state: "paused", positionSeconds: position, rate: 1 });
  }, [doc]);

  const onError = useCallback((event: MediaEvent) => {
    const mediaError = event.currentTarget?.error;
    const message =
      mediaError && typeof mediaError.message === "string" && mediaError.message.trim()
        ? mediaError.message.trim()
        : "This video failed to play. It may not allow embedding.";
    setError(message);
  }, []);

  /* ---- Actions: write the doc first, the player follows. ---- */

  const readElementTime = useCallback((): number => {
    const element = elementRef.current;
    if (!element) return recordRef.current.positionSeconds;
    try {
      const value = element.currentTime;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return recordRef.current.positionSeconds;
    }
  }, []);

  const play = useCallback(() => {
    if (readOnlyRef.current) return;
    writePlayback(doc, {
      state: "playing",
      positionSeconds: readElementTime(),
      rate: recordRef.current.rate,
    });
  }, [doc, readElementTime]);

  const pause = useCallback(() => {
    if (readOnlyRef.current) return;
    writePlayback(doc, {
      state: "paused",
      positionSeconds: readElementTime(),
      rate: recordRef.current.rate,
    });
  }, [doc, readElementTime]);

  const seek = useCallback(
    (seconds: number) => {
      if (readOnlyRef.current) return;
      const target = Math.max(0, seconds);
      const element = elementRef.current;
      if (element) {
        try {
          element.currentTime = target;
        } catch {
          /* ignore */
        }
      }
      setCurrentTime(target);
      writePlayback(doc, {
        state: recordRef.current.state,
        positionSeconds: target,
        rate: recordRef.current.rate,
      });
    },
    [doc],
  );

  /* ---- Local mute / volume (never synced). ---- */

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      const element = elementRef.current;
      if (element) {
        try {
          // Assign directly as well as via the prop, so an unmute stays inside
          // the user's click for browser gesture rules.
          element.muted = next;
        } catch {
          /* ignore */
        }
      }
      if (!next) {
        setGestureNeed((prev2) => (prev2 === "sound" ? "none" : prev2));
      }
      return next;
    });
  }, []);

  const setVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    setVolumeState(clamped);
    if (clamped > 0) {
      setMuted((prev) => {
        if (!prev) return prev;
        const element = elementRef.current;
        if (element) {
          try {
            element.muted = false;
          } catch {
            /* ignore */
          }
        }
        return false;
      });
    }
  }, []);

  // Toggle closed captions on the local player only (never synced). Works
  // through the DOM mirror and the player api alike, so the control functions
  // even when the element never mirrored the tracklist. Preference order when
  // enabling: the browser language, then the first track.
  const toggleCaptions = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;
    let domList: TextTrack[] = [];
    try {
      domList = element.textTracks ? Array.from(element.textTracks) : [];
    } catch {
      domList = [];
    }
    const apiState = readApiCaptions(element);
    if (domList.length === 0 && !apiState) return;
    const domShowing = domList.some((track) => track.mode === "showing");
    const isOn = (apiState?.activeLanguage ?? null) !== null || domShowing;
    if (isOn) {
      applyCaptionTrack(null);
      captionsPreferredRef.current = false;
      setCaptionsOn(false);
      return;
    }
    captionsPreferredRef.current = true;
    const preferred =
      typeof navigator !== "undefined" && navigator.language
        ? navigator.language.slice(0, 2).toLowerCase()
        : "en";
    const languages =
      domList.length > 0
        ? domList.map((track) => track.language)
        : (apiState?.tracks ?? []).map((track) => track.language);
    const pick =
      languages.find((language) =>
        language?.toLowerCase().startsWith(preferred),
      ) ?? languages[0];
    if (!pick) return;
    applyCaptionTrack(pick);
    setCaptionsOn(true);
    applyCaptionFontSize();
  }, [applyCaptionTrack, applyCaptionFontSize]);

  const setCaptionTrack = useCallback(
    (language: string | null) => {
      applyCaptionTrack(language);
      captionsPreferredRef.current = language !== null;
      setCaptionsOn(language !== null);
      if (language !== null) applyCaptionFontSize();
      syncCaptionState();
    },
    [applyCaptionTrack, applyCaptionFontSize, syncCaptionState],
  );

  const setCaptionFontSize = useCallback(
    (size: number) => {
      setCaptionFontSizeState(size);
      captionFontSizeRef.current = size;
      try {
        captionsApiOf(elementRef.current)?.setOption?.(
          "captions",
          "fontSize",
          size,
        );
      } catch {
        /* styling is best effort */
      }
    },
    [],
  );

  // Resolve the gesture overlay with a real click: unmute synchronously (so the
  // gesture context applies) and kick playback if the room wants it running.
  const resolveGesture = useCallback(() => {
    setGestureNeed("none");
    setMuted(false);
    const element = elementRef.current;
    if (!element) return;
    try {
      element.muted = false;
      if (recordRef.current.state === "playing" && element.paused) {
        void element.play()?.catch?.(() => {
          /* the reconcile props keep trying */
        });
      }
    } catch {
      /* ignore */
    }
    correctDrift(recordRef.current);
  }, [correctDrift]);

  const attachPlayer = useCallback((element: WatchMediaElement | null) => {
    elementRef.current = element;
  }, []);

  return {
    attachPlayer,
    playing: Boolean(videoId) && record.state === "playing",
    mutedProp: muted,
    volumeProp: volume / 100,
    rate: record.rate,
    onReady,
    onTimeUpdate,
    onDurationChange,
    onPlaying,
    onEnded,
    onError,
    ready,
    error,
    gestureNeed,
    muted,
    volume,
    currentTime,
    duration,
    playbackState: record.state,
    captionsAvailable,
    captionsOn,
    captionTracks,
    captionSizeAvailable,
    captionFontSize,
    play,
    pause,
    seek,
    toggleMute,
    setVolume,
    toggleCaptions,
    setCaptionTrack,
    setCaptionFontSize,
    resolveGesture,
  };
}
