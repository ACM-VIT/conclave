import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import {
  advanceQueue,
  expectedPosition,
  getPlayback,
  getQueue,
  getVideoId,
  writePlayback,
} from "../../core/doc/index";
import type { PlaybackRecord, PlaybackState } from "../../core/model/types";
import {
  LIVE_EDGE_TOLERANCE_SECONDS,
  liveEdgeLag,
  liveEdgeTime,
  planPlaybackCorrection,
} from "../playbackSync";

const CORRECTION_COOLDOWN_MS = 2_500;

const END_GUARD_SECONDS = 0.75;

const AUTOPLAY_PROBE_MS = 1200;

export type GestureNeed = "none" | "sound" | "sync";

type WatchMediaElement = Pick<
  HTMLVideoElement,
  | "currentTime"
  | "duration"
  | "paused"
  | "muted"
  | "play"
  | "pause"
  | "seeking"
  | "seekable"
  | "playbackRate"
  | "textTracks"
>;

type MediaEvent = React.SyntheticEvent<HTMLVideoElement>;

export type SyncedPlaybackHandle = {
  attachPlayer: (element: WatchMediaElement | null) => void;

  playing: boolean;
  mutedProp: boolean;
  volumeProp: number;
  rate: number;

  onReady: () => void;
  onTimeUpdate: (event: MediaEvent) => void;
  onDurationChange: (event: MediaEvent) => void;
  onPlaying: () => void;
  onEnded: () => void;
  onError: (event: MediaEvent) => void;

  ready: boolean;
  error: string | null;
  gestureNeed: GestureNeed;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  playbackState: PlaybackState;
  isLive: boolean;
  isAtLiveEdge: boolean;
  captionsAvailable: boolean;
  captionsOn: boolean;
  captionTracks: WatchCaptionTrack[];
  captionSizeAvailable: boolean;
  captionFontSize: number;

  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  goLive: () => void;
  toggleMute: () => void;
  setVolume: (value: number) => void;
  toggleCaptions: () => void;
  setCaptionTrack: (language: string | null) => void;
  setCaptionFontSize: (size: number) => void;
  resolveGesture: () => void;
};

export type WatchCaptionTrack = {
  language: string;
  label: string;
  active: boolean;
};

type CaptionsApi = {
  setOption?: (module: string, option: string, value: unknown) => void;
  getOption?: (module: string, option: string) => unknown;
  loadModule?: (module: string) => void;
};

type YoutubeVideoData = {
  isLive?: unknown;
  isLiveContent?: unknown;
  liveBroadcastContent?: unknown;
};

type YoutubeMediaApi = CaptionsApi & {
  getVideoData?: () => YoutubeVideoData;
  playerInfo?: { videoData?: YoutubeVideoData };
};

const captionsApiOf = (
  element: WatchMediaElement | null,
): CaptionsApi | null => {
  const api = (element as unknown as { api?: YoutubeMediaApi } | null)?.api;
  return api && typeof api === "object" ? api : null;
};

const readApiLiveStatus = (
  element: WatchMediaElement | null,
): boolean | null => {
  const api = (element as unknown as { api?: YoutubeMediaApi } | null)?.api;
  if (!api || typeof api !== "object") return null;
  let direct: YoutubeVideoData | null = null;
  try {
    direct = api.getVideoData?.() ?? null;
  } catch {
    direct = null;
  }
  const candidates = [direct, api.playerInfo?.videoData].filter(
    (value): value is YoutubeVideoData => Boolean(value),
  );
  let sawExplicitFalse = false;
  for (const data of candidates) {
    if (
      data.isLive === true ||
      data.isLiveContent === true ||
      data.liveBroadcastContent === "live"
    ) {
      return true;
    }
    if (
      data.isLive === false ||
      data.isLiveContent === false ||
      data.liveBroadcastContent === "none"
    ) {
      sawExplicitFalse = true;
    }
  }
  return sawExplicitFalse ? false : null;
};

const playbackKey = (record: PlaybackRecord): string =>
  `${record.state}|${record.positionSeconds}|${record.rate}|${record.updatedAt}|${record.liveEdge}`;

const readElementLiveEdge = (
  element: WatchMediaElement,
  duration: number,
): number | null => {
  try {
    const ranges = element.seekable;
    if (ranges && ranges.length > 0) {
      const end = ranges.end(ranges.length - 1);
      const edge = liveEdgeTime(end);
      if (edge !== null) return edge;
    }
  } catch {
  }
  return liveEdgeTime(duration);
};

type ApiCaptionState = {
  tracks: { language: string; label: string }[];
  activeLanguage: string | null;
};

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
  readOnly: boolean;
  liveHint?: boolean | null;
  writeOnce: (key: string, write: (doc: Y.Doc) => void) => void;
};

export function useSyncedPlayback({
  doc,
  videoId,
  readOnly,
  liveHint = null,
  writeOnce,
}: UseSyncedPlaybackArgs): SyncedPlaybackHandle {
  const elementRef = useRef<WatchMediaElement | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const videoIdRef = useRef<string | null>(videoId);
  videoIdRef.current = videoId;
  const liveHintRef = useRef<boolean | null>(liveHint);
  liveHintRef.current = liveHint;

  const [record, setRecord] = useState<PlaybackRecord>(() => getPlayback(doc));
  const recordRef = useRef(record);
  recordRef.current = record;
  const [effectiveRate, setEffectiveRate] = useState(record.rate);
  const effectiveRateRef = useRef(effectiveRate);
  effectiveRateRef.current = effectiveRate;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gestureNeed, setGestureNeed] = useState<GestureNeed>("none");
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const [volume, setVolumeState] = useState(100);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [detectedLive, setDetectedLive] = useState<boolean | null>(null);
  const detectedLiveRef = useRef<boolean | null>(detectedLive);
  detectedLiveRef.current = detectedLive;
  const isLive = liveHint ?? detectedLive ?? false;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const [isAtLiveEdge, setIsAtLiveEdge] = useState(false);
  const initializedLiveForRef = useRef<string | null>(null);
  const [captionsAvailable, setCaptionsAvailable] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionTracks, setCaptionTracks] = useState<WatchCaptionTrack[]>([]);
  const [captionSizeAvailable, setCaptionSizeAvailable] = useState(false);
  const [captionFontSize, setCaptionFontSizeState] = useState(0);
  const captionFontSizeRef = useRef(0);
  captionFontSizeRef.current = captionFontSize;
  const captionsPreferredRef = useRef(false);
  const captionsInitializedForRef = useRef<string | null>(null);
  const captionsNudgedForRef = useRef<string | null>(null);
  const applyCaptionFontSizeRef = useRef<(() => void) | null>(null);

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
    }
    try {
      captionsApiOf(element)?.setOption?.(
        "captions",
        "track",
        language !== null ? { languageCode: language } : {},
      );
    } catch {
    }
  }, []);

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
      }
    }

    const available = domList.length > 0 || apiState !== null;
    const domShowing =
      domList.find((track) => track.mode === "showing")?.language ?? null;
    let activeLanguage = apiState?.activeLanguage ?? domShowing;

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
    }
  }, []);
  applyCaptionFontSizeRef.current = applyCaptionFontSize;

  const applyPlaybackRate = useCallback((nextRate: number) => {
    if (!Number.isFinite(nextRate) || nextRate <= 0) return;
    if (Math.abs(effectiveRateRef.current - nextRate) < 0.01) return;
    effectiveRateRef.current = nextRate;
    setEffectiveRate(nextRate);
    const element = elementRef.current;
    if (!element) return;
    try {
      element.playbackRate = nextRate;
    } catch {
    }
  }, []);

  type MediaSnapshot = {
    current: number;
    duration: number;
    live: boolean;
    liveEdge: number | null;
  };

  const syncMediaSnapshot = useCallback((): MediaSnapshot | null => {
    const element = elementRef.current;
    if (!element) return null;
    let nextCurrent = 0;
    let nextDuration = 0;
    try {
      nextCurrent = Number.isFinite(element.currentTime)
        ? element.currentTime
        : 0;
      nextDuration = Number.isFinite(element.duration) ? element.duration : 0;
    } catch {
      return null;
    }

    const apiLive = readApiLiveStatus(element);
    if (liveHintRef.current === null && apiLive !== null) {
      detectedLiveRef.current = apiLive;
      setDetectedLive((previous) =>
        previous === apiLive ? previous : apiLive,
      );
    }
    const liveNow =
      liveHintRef.current ?? apiLive ?? detectedLiveRef.current ?? false;
    isLiveRef.current = liveNow;
    const edge = liveNow
      ? readElementLiveEdge(element, nextDuration)
      : null;
    setCurrentTime(nextCurrent);
    setDuration(nextDuration);
    setIsAtLiveEdge(
      liveNow && edge !== null
        ? edge - nextCurrent <= LIVE_EDGE_TOLERANCE_SECONDS
        : false,
    );
    return {
      current: nextCurrent,
      duration: nextDuration,
      live: liveNow,
      liveEdge: edge,
    };
  }, []);

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
    const key = playbackKey(target);
    const existing = anchorRef.current;
    if (existing && existing.key === key) return existing;
    const now = Date.now();
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

  const correctDrift = useCallback(
    (target: PlaybackRecord) => {
      const element = elementRef.current;
      if (!element) return;
      const previousAnchor = anchorRef.current;
      const now = Date.now();
      const previousExpected = previousAnchor
        ? previousAnchor.state === "playing"
          ? previousAnchor.position +
            ((now - previousAnchor.at) / 1000) * previousAnchor.rate
          : previousAnchor.position
        : null;
      const anchor = anchorFor(target);

      let current = 0;
      let elementDuration = Number.NaN;
      try {
        current = element.currentTime ?? 0;
        if (element.seeking === true) return;
        elementDuration = element.duration;
      } catch {
        return;
      }

      const followsLiveEdge =
        isLiveRef.current && target.liveEdge;
      const edge = followsLiveEdge
        ? readElementLiveEdge(element, elementDuration)
        : null;
      const expected =
        edge ??
        (anchor.state === "playing"
          ? anchor.position + ((now - anchor.at) / 1000) * anchor.rate
          : anchor.position);
      if (!Number.isFinite(expected)) return;

      let seekTarget = Math.max(0, expected);
      if (
        !followsLiveEdge &&
        Number.isFinite(elementDuration) &&
        elementDuration > END_GUARD_SECONDS * 2
      ) {
        seekTarget = Math.min(seekTarget, elementDuration - END_GUARD_SECONDS);
      }
      const recordChanged =
        previousAnchor !== null && previousAnchor.key !== anchor.key;
      const forceSeek =
        recordChanged &&
        (target.liveEdge ||
          (previousExpected !== null &&
            Math.abs(seekTarget - previousExpected) > 1.5));
      const correction = planPlaybackCorrection({
        current,
        target: seekTarget,
        state: anchor.state,
        baseRate: anchor.rate,
        forceSeek,
      });

      if (correction.kind !== "seek") {
        applyPlaybackRate(correction.rate);
        return;
      }
      applyPlaybackRate(correction.rate);

      const last = lastCorrectionRef.current;
      if (
        last &&
        last.key === anchor.key &&
        now - last.at < CORRECTION_COOLDOWN_MS
      ) {
        return;
      }
      lastCorrectionRef.current = { key: anchor.key, at: now };
      try {
        element.currentTime = correction.target;
      } catch {
      }
    },
    [anchorFor, applyPlaybackRate],
  );

  useEffect(() => {
    const sync = () => {
      const next = getPlayback(doc);
      if (playbackKey(next) === playbackKey(recordRef.current)) return;
      recordRef.current = next;
      setRecord(next);
      correctDrift(next);
    };
    doc.on("update", sync);
    sync();
    return () => {
      doc.off("update", sync);
    };
  }, [correctDrift, doc]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!syncMediaSnapshot()) return;
      correctDrift(recordRef.current);
      syncCaptionState();
    }, 1000);
    return () => clearInterval(interval);
  }, [correctDrift, syncCaptionState, syncMediaSnapshot]);

  const initializeLivePlayback = useCallback(() => {
    const currentVideo = videoIdRef.current;
    if (!currentVideo || !isLiveRef.current) return;
    const snapshot = syncMediaSnapshot();
    const element = elementRef.current;
    if (!snapshot?.live || snapshot.liveEdge === null || !element) return;
    if (initializedLiveForRef.current === currentVideo) return;

    const target = recordRef.current;
    initializedLiveForRef.current = currentVideo;
    if (!target.liveEdge) {
      correctDrift(target);
      return;
    }

    applyPlaybackRate(target.rate);
    setCurrentTime(snapshot.liveEdge);
    try {
      element.currentTime = snapshot.liveEdge;
    } catch {
    }

  }, [applyPlaybackRate, correctDrift, syncMediaSnapshot]);

  useEffect(() => {
    anchorRef.current = null;
    lastCorrectionRef.current = null;
    initializedLiveForRef.current = null;
    detectedLiveRef.current = null;
    isLiveRef.current = false;
    setDetectedLive(null);
    setIsAtLiveEdge(false);
    setCurrentTime(0);
    setDuration(0);
    setReady(false);
    setGestureNeed("none");
    setError(null);
  }, [videoId]);

  useEffect(() => {
    if (!ready || !isLive) return;
    initializeLivePlayback();
  }, [initializeLivePlayback, isLive, ready, videoId]);

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

  const onReady = useCallback(() => {
    setReady(true);
    setError(null);
    syncMediaSnapshot();
    correctDrift(recordRef.current);
  }, [correctDrift, syncMediaSnapshot]);

  const onTimeUpdate = useCallback(
    (event: MediaEvent) => {
      const element = event.currentTarget;
      setCurrentTime(element.currentTime ?? 0);
      if (isLiveRef.current) {
        const lag = liveEdgeLag(element.currentTime, element.duration);
        setIsAtLiveEdge(
          lag !== null && lag <= LIVE_EDGE_TOLERANCE_SECONDS,
        );
      }
      if (recordRef.current.state === "playing") {
        correctDrift(recordRef.current);
      }
    },
    [correctDrift],
  );

  const onDurationChange = useCallback(() => {
    syncMediaSnapshot();
  }, [syncMediaSnapshot]);

  const onPlaying = useCallback(() => {
    syncMediaSnapshot();
    initializeLivePlayback();
    setGestureNeed((prev) => {
      if (prev === "none") return prev;
      return mutedRef.current ? "sound" : "none";
    });
  }, [initializeLivePlayback, syncMediaSnapshot]);

  const onEnded = useCallback(() => {
    const ended = videoIdRef.current;
    if (readOnlyRef.current || !ended) return;
    const element = elementRef.current;
    let position = 0;
    try {
      position = element?.duration ?? element?.currentTime ?? 0;
    } catch {
      position = 0;
    }
    writeOnce(`ended:${ended}:${recordRef.current.updatedAt}`, (live) => {
      if (getQueue(live).length > 0) {
        advanceQueue(live, ended);
        return;
      }
      if (getVideoId(live) !== ended) return;
      writePlayback(live, {
        state: "paused",
        positionSeconds: position,
        rate: 1,
        liveEdge: false,
      });
    });
  }, [writeOnce]);

  const onError = useCallback((event: MediaEvent) => {
    const mediaError = event.currentTarget?.error;
    const message =
      mediaError && typeof mediaError.message === "string" && mediaError.message.trim()
        ? mediaError.message.trim()
        : "This video failed to play. It may not allow embedding.";
    setError(message);
  }, []);

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
      liveEdge: false,
    });
  }, [doc, readElementTime]);

  const pause = useCallback(() => {
    if (readOnlyRef.current) return;
    writePlayback(doc, {
      state: "paused",
      positionSeconds: readElementTime(),
      rate: recordRef.current.rate,
      liveEdge: false,
    });
  }, [doc, readElementTime]);

  const seek = useCallback(
    (seconds: number) => {
      if (readOnlyRef.current) return;
      const target = Math.max(0, seconds);
      applyPlaybackRate(recordRef.current.rate);
      const element = elementRef.current;
      if (element) {
        try {
          element.currentTime = target;
        } catch {
        }
      }
      setCurrentTime(target);
      setIsAtLiveEdge(false);
      writePlayback(doc, {
        state: recordRef.current.state,
        positionSeconds: target,
        rate: recordRef.current.rate,
        liveEdge: false,
      });
    },
    [applyPlaybackRate, doc],
  );

  const goLive = useCallback(() => {
    if (readOnlyRef.current || !isLiveRef.current) return;
    const snapshot = syncMediaSnapshot();
    const element = elementRef.current;
    if (!snapshot?.live || snapshot.liveEdge === null || !element) return;

    applyPlaybackRate(recordRef.current.rate);
    setCurrentTime(snapshot.liveEdge);
    try {
      element.currentTime = snapshot.liveEdge;
    } catch {
    }
    writePlayback(doc, {
      state: "playing",
      positionSeconds: snapshot.liveEdge,
      rate: recordRef.current.rate,
      liveEdge: true,
    });
  }, [applyPlaybackRate, doc, syncMediaSnapshot]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      const element = elementRef.current;
      if (element) {
        try {
          element.muted = next;
        } catch {
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
          }
        }
        return false;
      });
    }
  }, []);

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
      }
    },
    [],
  );

  const resolveGesture = useCallback(() => {
    setGestureNeed("none");
    setMuted(false);
    const element = elementRef.current;
    if (!element) return;
    try {
      element.muted = false;
      if (recordRef.current.state === "playing" && element.paused) {
        void element.play()?.catch?.(() => {
        });
      }
    } catch {
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
    rate: effectiveRate,
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
    isLive,
    isAtLiveEdge,
    captionsAvailable,
    captionsOn,
    captionTracks,
    captionSizeAvailable,
    captionFontSize,
    play,
    pause,
    seek,
    goLive,
    toggleMute,
    setVolume,
    toggleCaptions,
    setCaptionTrack,
    setCaptionFontSize,
    resolveGesture,
  };
}
