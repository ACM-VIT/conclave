"use client";

import dynamic from "next/dynamic";
import {
  Loader2,
  WandSparkles,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Plus,
  Ghost,
  ChevronDown,
  Check,
  Link2,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { prefetchConclaveAnimation } from "../lib/conclaveAnimation";
import { prefetchConclaveLock } from "../lib/conclaveSound";
import type { Dispatch, SetStateAction } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { signOut, useSession } from "@/lib/auth-client";
import type { RoomInfo } from "@/lib/sfu-types";
import type {
  ConnectionState,
  MeetError,
  PrejoinMediaHandoff,
} from "../lib/types";
import {
  buildCameraVideoConstraints,
  DEFAULT_AUDIO_CONSTRAINTS,
} from "../lib/constants";
import {
  generateRoomCode,
  ROOM_CODE_MAX_LENGTH,
  extractRoomCode,
  sanitizeInstitutionDisplayName,
  sanitizeRoomCodeInput,
  sanitizeRoomCode,
} from "../lib/utils";
import RoomPresenceBadge from "./RoomPresenceBadge";
// import ScheduledMeetingsPanel from "./ScheduledMeetingsPanel";
import { useCameraPermissionState } from "../hooks/useCameraPermissionState";
import {
  useBandwidthHeavyPreloadDeferred,
} from "../hooks/useBandwidthHeavyPreloadDeferred";
import {
  countActiveVideoEffects,
  type VideoEffectsState,
} from "../lib/video-effects";
import { getBrowserNetworkSnapshot } from "../lib/network-information";
import {
  getUserMediaWithTimeout,
  MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
  MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
} from "../lib/media-capture-timeout";
import { prewarmVideoEffectsAssetsDeferred } from "../lib/video-effects-lazy";
import type { VideoEffectsBridgeState } from "./VideoEffectsBridge";

const normalizeGuestName = (value: string): string =>
  value.trim().replace(/\s+/g, " ");
const GUEST_USER_STORAGE_KEY = "conclave:guest-user";

const VideoEffectsPanel = dynamic(() => import("./VideoEffectsPanel"), {
  ssr: false,
});
const VideoEffectsBridge = dynamic(() => import("./VideoEffectsBridge"), {
  ssr: false,
});

const VIDEO_EFFECTS_OFF_STATE: VideoEffectsBridgeState = {
  effectiveStream: null,
  processedTrackVersion: 0,
  processedTrackReady: false,
  status: "off",
  error: null,
  debugStats: null,
};

const getPrejoinVideoConstraints = () => {
  const snapshot = getBrowserNetworkSnapshot();
  const profile = snapshot.emergency
    ? "emergency"
    : snapshot.startupQuality === "poor"
    ? "poor"
    : snapshot.startupQuality === "fair"
    ? "fair"
    : "good";
  return buildCameraVideoConstraints("standard", profile);
};

const createGuestId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `guest-${crypto.randomUUID()}`;
  }
  return `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const buildGuestUser = (
  name: string,
  existingUser?: { id?: string; email?: string | null }
) => {
  const existingGuestId =
    typeof existingUser?.id === "string" && existingUser.id.startsWith("guest-")
      ? existingUser.id
      : undefined;
  const existingEmail =
    typeof existingUser?.email === "string" ? existingUser.email.trim() : "";
  const id = existingGuestId || createGuestId();
  const email = existingEmail || `${id}@guest.conclave`;
  return { id, email, name };
};

interface JoinScreenProps {
  roomId: string;
  onRoomIdChange: (id: string) => void;
  onJoinRoom: (roomId: string) => void;
  isLoading: boolean;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
  userEmail: string;
  connectionState: ConnectionState;
  isAdmin: boolean;
  enableRoomRouting: boolean;
  forceJoinOnly: boolean;
  allowGhostMode: boolean;
  showPermissionHint: boolean;
  rooms: RoomInfo[];
  roomsStatus: "idle" | "loading" | "error";
  onRefreshRooms: () => void;
  displayNameInput: string;
  onDisplayNameInputChange: (value: string) => void;
  isGhostMode: boolean;
  onGhostModeChange: (value: boolean) => void;
  onUserChange: (user: { id: string; email: string; name: string } | null) => void;
  onIsAdminChange: (isAdmin: boolean) => void;
  meetError?: MeetError | null;
  meetingEndedNotice?: string | null;
  onDismissMeetingEndedNotice?: () => void;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
  onEnterStart?: (action: "new" | "join") => void;
}

// Flat, Google-Meet-style lobby (dark Carbon, no gradients/marketing): a single
// screen with the mic/cam self-preview on the left and the join actions on the
// right. The whole 3-phase welcome/auth/join flow was ripped out for this.
const FIELD =
  "w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 h-12 text-[15px] text-[#fafafa] placeholder:text-[#fafafa]/30 transition-[border-color,background-color] duration-150 focus:border-[#F95F4A]/60 focus:bg-white/[0.05] focus:outline-none disabled:opacity-50";
const CTA_PRIMARY =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05] disabled:bg-[#232327] disabled:text-[#fafafa]/40 disabled:cursor-not-allowed";
const CTA_GHOST =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08] disabled:opacity-50";
const DEBUG_VIDEO_EFFECTS_STORAGE_KEY = "conclave:debug-video-effects";

const getSignInHref = (): string => {
  if (typeof window === "undefined") return "/sign-in";
  const next = `${window.location.pathname}${window.location.search}`;
  return `/sign-in?next=${encodeURIComponent(next || "/")}`;
};

const isJoinMediaDebugEnabled = () => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_VIDEO_EFFECTS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const getJoinTrackDebugSnapshot = (track: MediaStreamTrack | null) => {
  if (!track) return null;
  let settings: MediaTrackSettings = {};
  try {
    settings = track.getSettings();
  } catch {
    settings = {};
  }
  return {
    id: track.id,
    kind: track.kind,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings,
  };
};

const getJoinStreamDebugSnapshot = (stream: MediaStream | null) => {
  if (!stream) return null;
  return {
    id: stream.id,
    active: stream.active,
    audioTracks: stream.getAudioTracks().map(getJoinTrackDebugSnapshot),
    videoTracks: stream.getVideoTracks().map(getJoinTrackDebugSnapshot),
  };
};

const logJoinMedia = (event: string, payload?: unknown) => {
  if (!isJoinMediaDebugEnabled()) return;
  if (payload === undefined) {
    console.debug(`[JoinScreen media] ${event}`);
    return;
  }
  console.debug(`[JoinScreen media] ${event}`, payload);
};

const warnJoinMedia = (event: string, payload?: unknown) => {
  if (!isJoinMediaDebugEnabled()) return;
  if (payload === undefined) {
    console.warn(`[JoinScreen media] ${event}`);
    return;
  }
  console.warn(`[JoinScreen media] ${event}`, payload);
};

type DeviceOption = { deviceId: string; label: string };

// Compact device dropdown for the prejoin actions column (mic / camera). Styled
// to match the FIELD inputs; uses a native <select> so it stays accessible.
function DeviceSelect({
  icon: Icon,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  icon: LucideIcon;
  value: string;
  options: DeviceOption[];
  onChange: (deviceId: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="relative">
      <Icon
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
      />
      <select
        aria-label={ariaLabel}
        value={value || options[0]?.deviceId || ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-9 text-[13px] text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.05] focus:border-[#F95F4A]/60 focus:outline-none"
      >
        {options.map((option) => (
          <option
            key={option.deviceId}
            value={option.deviceId}
            className="bg-[#18181b] text-[#fafafa]"
          >
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
      />
    </div>
  );
}

function JoinScreen({
  roomId,
  onRoomIdChange,
  onJoinRoom,
  isLoading,
  isAdmin,
  user,
  userEmail,
  forceJoinOnly,
  enableRoomRouting,
  allowGhostMode,
  showPermissionHint,
  rooms,
  roomsStatus,
  displayNameInput,
  onDisplayNameInputChange,
  isGhostMode,
  onGhostModeChange,
  onUserChange,
  onIsAdminChange,
  meetError,
  meetingEndedNotice,
  onDismissMeetingEndedNotice,
  videoEffects,
  onVideoEffectsChange,
  onPrejoinMediaCommit,
  onEnterStart,
}: JoinScreenProps) {
  const normalizedRoomId =
    roomId === "undefined" || roomId === "null" ? "" : roomId;
  const isRoutedRoom = forceJoinOnly;
  const enforceShortCode = enableRoomRouting || forceJoinOnly;

  // Warm the (large) brand animation while the lobby is idle so the entry
  // overlay can paint instantly the moment the user commits to a meeting.
  useEffect(() => {
    prefetchConclaveAnimation();
    prefetchConclaveLock();
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const processedPreviewTrackRef = useRef<MediaStreamTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const handedOffTrackIdsRef = useRef<Set<string>>(new Set());
  const prejoinAudioRequestGenerationRef = useRef(0);
  const prejoinVideoRequestGenerationRef = useRef(0);
  const toggleCameraInFlightRef = useRef(false);
  const toggleMicInFlightRef = useRef(false);
  const cameraIntentRef = useRef(false);
  const micIntentRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [permissionRequestError, setPermissionRequestError] = useState<
    string | null
  >(null);
  const [isEffectsOpen, setIsEffectsOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [isSigningOut, setIsSigningOut] = useState(false);
  // presenceChecked: a check has started (pill may appear, possibly as "Checking…").
  // presenceSettled: a check has completed at least once, so we show a real count
  // and keep showing it through background polls instead of flickering to "Checking…".
  const [presenceChecked, setPresenceChecked] = useState(false);
  const [presenceSettled, setPresenceSettled] = useState(false);
  // Prejoin device selection + copy-link. Device pickers only act on a live
  // track (a clean swap on the local preview, which the handoff then carries
  // into the call), so none of the toggle/permission paths need to change.
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<DeviceOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState("");
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deferred join: both the guest user (onUserChange) and the host flag
  // (onIsAdminChange) propagate through the parent asynchronously, and the
  // parent rebuilds onJoinRoom with the new isHost only on the next render.
  // So we stash the intent and fire onJoinRoom once both have landed —
  // otherwise "New meeting" joins with a stale isAdmin=false and the SFU
  // replies "No room found" (it only creates a room when isHost is true).
  const [pending, setPending] = useState<{ mode: "new" | "join"; roomId: string } | null>(null);

  const { data: session } = useSession();
  const isSignedInUser = Boolean(
    (session?.user || user) && !user?.id?.startsWith("guest-")
  );
  const hasIdentity = Boolean(user?.id);
  const lastAppliedSessionUserIdRef = useRef<string | null>(null);
  const nameInputValue = guestName || displayNameInput;
  const liveDisplayName = normalizeGuestName(nameInputValue);

  const previewName =
    liveDisplayName ||
    normalizeGuestName(user?.name || "") ||
    (userEmail ? userEmail.split("@")[0] : "") ||
    "You";
  const activeVideoEffectsCount = countActiveVideoEffects(videoEffects);
  const shouldDeferPreviewVideoEffectsPreload =
    useBandwidthHeavyPreloadDeferred();
  const shouldRunPreviewVideoEffects = activeVideoEffectsCount > 0;
  const [videoEffectsBridgeState, setVideoEffectsBridgeState] =
    useState<VideoEffectsBridgeState>(VIDEO_EFFECTS_OFF_STATE);
  const processedPreviewStream = shouldRunPreviewVideoEffects
    ? videoEffectsBridgeState.effectiveStream
    : null;
  const videoEffectsStatus = shouldRunPreviewVideoEffects
    ? videoEffectsBridgeState.status
    : "off";
  const videoEffectsError = shouldRunPreviewVideoEffects
    ? videoEffectsBridgeState.error
    : null;
  const videoEffectsDebugStats = shouldRunPreviewVideoEffects
    ? videoEffectsBridgeState.debugStats
    : null;
  const previewStream = processedPreviewStream ?? localStream;
  const cameraPermissionState = useCameraPermissionState();
  const hasLivePreviewCamera = Boolean(
    localStream
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  );
  const isCameraPermissionBlocked =
    meetError?.code === "PERMISSION_DENIED" ||
    (!hasLivePreviewCamera &&
      (cameraPermissionState === "prompt" ||
        cameraPermissionState === "denied"));
  const shouldShowPermissionCta =
    !hasLivePreviewCamera &&
    !isCameraOn &&
    (cameraPermissionState === "prompt" ||
      cameraPermissionState === "denied" ||
      meetError?.code === "PERMISSION_DENIED");
  const prewarmLiveCameraEffects = (reason: string) => {
    if (activeVideoEffectsCount <= 0 && !isEffectsOpen) return;
    if (shouldDeferPreviewVideoEffectsPreload) return;
    void prewarmVideoEffectsAssetsDeferred({
      segmentation: true,
      face: true,
      reason,
    });
  };
  const openEffectsPanel = () => {
    if (isCameraPermissionBlocked) return;
    setIsEffectsOpen(true);
  };

  type PrejoinMediaKind = "audio" | "video";
  type PrejoinMediaRequestGeneration = Partial<
    Record<PrejoinMediaKind, number>
  >;

  const beginPrejoinMediaRequest = (
    kinds: readonly PrejoinMediaKind[],
  ): PrejoinMediaRequestGeneration => {
    const generation: PrejoinMediaRequestGeneration = {};
    if (kinds.includes("audio")) {
      prejoinAudioRequestGenerationRef.current += 1;
      generation.audio = prejoinAudioRequestGenerationRef.current;
    }
    if (kinds.includes("video")) {
      prejoinVideoRequestGenerationRef.current += 1;
      generation.video = prejoinVideoRequestGenerationRef.current;
    }
    return generation;
  };

  const getCurrentPrejoinMediaGeneration = (kind: PrejoinMediaKind) =>
    kind === "audio"
      ? prejoinAudioRequestGenerationRef.current
      : prejoinVideoRequestGenerationRef.current;

  const isCurrentPrejoinMediaRequest = (
    kind: PrejoinMediaKind,
    generation: number | undefined,
  ) =>
    generation !== undefined &&
    getCurrentPrejoinMediaGeneration(kind) === generation;

  const stopTracks = (tracks: readonly MediaStreamTrack[]) => {
    tracks.forEach((track) => track.stop());
  };

  const commitLocalPreviewStream = (stream: MediaStream | null) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  };

  const commitRequestedPrejoinTracks = (
    tracks: MediaStreamTrack[],
    event: string,
    requestGeneration: PrejoinMediaRequestGeneration,
  ) => {
    const acceptedTracks: MediaStreamTrack[] = [];
    const staleKinds = new Set<PrejoinMediaKind>();
    const currentRequestedKinds = new Set<PrejoinMediaKind>();

    (["audio", "video"] as const).forEach((kind) => {
      if (requestGeneration[kind] === undefined) return;
      if (isCurrentPrejoinMediaRequest(kind, requestGeneration[kind])) {
        currentRequestedKinds.add(kind);
      } else {
        staleKinds.add(kind);
      }
    });

    tracks.forEach((track) => {
      const kind = track.kind === "audio" || track.kind === "video"
        ? track.kind
        : null;
      if (
        !kind ||
        !currentRequestedKinds.has(kind) ||
        track.readyState !== "live"
      ) {
        track.stop();
        return;
      }
      acceptedTracks.push(track);
    });

    const staleKindList = Array.from(staleKinds);
    if (staleKindList.length > 0) {
      logJoinMedia("discard_stale_prejoin_media_request", {
        event,
        requestGeneration,
        staleKinds: staleKindList,
        currentGeneration: {
          audio: prejoinAudioRequestGenerationRef.current,
          video: prejoinVideoRequestGenerationRef.current,
        },
      });
    }

    const hasAcceptedAudio = acceptedTracks.some(
      (track) => track.kind === "audio",
    );
    const hasAcceptedVideo = acceptedTracks.some(
      (track) => track.kind === "video",
    );
    const acceptedTrackIds = new Set(
      acceptedTracks.map((track) => track.id),
    );

    acceptedTracks.forEach((track) => {
      if (track.kind === "video" && "contentHint" in track) {
        track.contentHint = "motion";
      }
    });
    const preservedTracks =
      localStreamRef.current
        ?.getTracks()
        .filter((track) => {
          if (
            (track.kind === "audio" || track.kind === "video") &&
            currentRequestedKinds.has(track.kind)
          ) {
            return false;
          }
          return track.readyState === "live";
        }) ?? [];
    localStreamRef.current?.getTracks().forEach((track) => {
      if (
        acceptedTrackIds.has(track.id) ||
        !(
          (track.kind === "audio" || track.kind === "video") &&
          currentRequestedKinds.has(track.kind)
        )
      ) {
        return;
      }
      track.stop();
    });
    const liveTracks = [...preservedTracks, ...acceptedTracks];
    const nextStream =
      liveTracks.length > 0 ? new MediaStream(liveTracks) : null;
    commitLocalPreviewStream(nextStream);
    if (currentRequestedKinds.has("video")) {
      cameraIntentRef.current = hasAcceptedVideo;
      setIsCameraOn(hasAcceptedVideo);
    }
    if (currentRequestedKinds.has("audio")) {
      micIntentRef.current = hasAcceptedAudio;
      setIsMicOn(hasAcceptedAudio);
    }
    if (hasAcceptedVideo) {
      prewarmLiveCameraEffects("prejoin-full-media-camera-live");
    }
    logJoinMedia(event, {
      stream: getJoinStreamDebugSnapshot(nextStream),
      hasAudio: hasAcceptedAudio,
      hasVideo: hasAcceptedVideo,
      staleKinds: staleKindList,
    });
    return {
      hasAudio: hasAcceptedAudio,
      hasVideo: hasAcceptedVideo,
      staleKinds: staleKindList,
    };
  };

  const requestMicrophoneAndCamera = async () => {
    if (isRequestingPermissions) return;

    const requestGeneration = beginPrejoinMediaRequest(["audio", "video"]);
    setIsRequestingPermissions(true);
    setPermissionRequestError(null);
    try {
      const videoConstraints = getPrejoinVideoConstraints();
      logJoinMedia("get_user_media_full_request", {
        audio: DEFAULT_AUDIO_CONSTRAINTS,
        video: videoConstraints,
      });
      const stream = await getUserMediaWithTimeout(
        {
          audio: DEFAULT_AUDIO_CONSTRAINTS,
          video: videoConstraints,
        },
        {
          label: "prejoin microphone and camera permission request",
          timeoutMs: MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
        },
      );
      commitRequestedPrejoinTracks(
        stream.getTracks(),
        "get_user_media_full_done",
        requestGeneration,
      );
    } catch (err) {
      warnJoinMedia("get_user_media_full_failed", {
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err,
      });
      const fallbackTracks: MediaStreamTrack[] = [];
      const [audioResult, videoResult] = await Promise.allSettled([
        getUserMediaWithTimeout(
          { audio: DEFAULT_AUDIO_CONSTRAINTS },
          {
            label: "prejoin microphone fallback permission request",
            timeoutMs: MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
          },
        ),
        getUserMediaWithTimeout(
          { video: getPrejoinVideoConstraints() },
          {
            label: "prejoin camera fallback permission request",
            timeoutMs: MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
          },
        ),
      ]);

      if (audioResult.status === "fulfilled") {
        fallbackTracks.push(...audioResult.value.getAudioTracks());
      } else {
        warnJoinMedia("get_user_media_audio_fallback_failed", {
          error:
            audioResult.reason instanceof Error
              ? {
                  name: audioResult.reason.name,
                  message: audioResult.reason.message,
                }
              : (audioResult.reason as unknown),
        });
      }
      if (videoResult.status === "fulfilled") {
        fallbackTracks.push(...videoResult.value.getVideoTracks());
      } else {
        warnJoinMedia("get_user_media_video_fallback_failed", {
          error:
            videoResult.reason instanceof Error
              ? {
                  name: videoResult.reason.name,
                  message: videoResult.reason.message,
                }
              : (videoResult.reason as unknown),
        });
      }

      const { hasAudio, hasVideo, staleKinds } = commitRequestedPrejoinTracks(
        fallbackTracks,
        "get_user_media_separate_fallback_done",
        requestGeneration,
      );
      const audioStale = staleKinds.includes("audio");
      const videoStale = staleKinds.includes("video");
      if (audioStale && videoStale) return;
      if (!hasAudio && !audioStale && !hasVideo && !videoStale) {
        cameraIntentRef.current = false;
        micIntentRef.current = false;
        setPermissionRequestError("Permission needed");
      } else if (!hasAudio && !audioStale) {
        setPermissionRequestError("Microphone unavailable");
      } else if (!hasVideo && !videoStale) {
        setPermissionRequestError("Camera unavailable");
      } else {
        setPermissionRequestError(null);
      }
    } finally {
      setIsRequestingPermissions(false);
    }
  };

  const [nextParam, setNextParam] = useState<string | null>(null);
  const hasPushedNextRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const candidate = new URLSearchParams(window.location.search).get("next");
    if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return;
    setNextParam(candidate);
  }, []);
  useEffect(() => {
    if (!nextParam || !session?.user || hasPushedNextRef.current) return;
    hasPushedNextRef.current = true;
    window.location.href = nextParam;
  }, [nextParam, session]);

  useEffect(() => {
    if (!session?.user) {
      lastAppliedSessionUserIdRef.current = null;
      return;
    }
    const isGuestIdentity = Boolean(user?.id?.startsWith("guest-"));
    if (
      (!user || isGuestIdentity) &&
      lastAppliedSessionUserIdRef.current !== session.user.id
    ) {
      onUserChange({
        id: session.user.id,
        email: session.user.email || "",
        name: sanitizeInstitutionDisplayName(
          session.user.name || session.user.email || "User",
          session.user.email || ""
        ),
      });
      lastAppliedSessionUserIdRef.current = session.user.id;
    } else if (user && !isGuestIdentity && !lastAppliedSessionUserIdRef.current) {
      lastAppliedSessionUserIdRef.current = session.user.id;
    }
  }, [session, user, onUserChange]);

  useEffect(() => {
    if (!user?.id?.startsWith("guest-") || guestName.trim().length > 0) return;
    const nextName = normalizeGuestName(user.name || "");
    if (!nextName) return;
    setGuestName(nextName);
    onDisplayNameInputChange(nextName);
  }, [guestName, onDisplayNameInputChange, user]);

  useEffect(() => {
    localStreamRef.current = localStream;
    cameraIntentRef.current = isCameraOn;
    micIntentRef.current = isMicOn;
    logJoinMedia("local_stream_changed", {
      localStream: getJoinStreamDebugSnapshot(localStream),
      isCameraOn,
      isMicOn,
    });
  }, [isCameraOn, isMicOn, localStream]);
  useEffect(() => {
    if (!videoRef.current) return;
    if (previewStream) {
      logJoinMedia("preview_stream_attach", {
        previewStream: getJoinStreamDebugSnapshot(previewStream),
        localStream: getJoinStreamDebugSnapshot(localStream),
        processedTrack: getJoinTrackDebugSnapshot(processedPreviewTrackRef.current),
      });
      videoRef.current.srcObject = previewStream;
      videoRef.current.play().catch((err: unknown) => {
        warnJoinMedia("preview_video_play_failed", {
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : err,
          previewStream: getJoinStreamDebugSnapshot(previewStream),
        });
      });
    } else if (videoRef.current.srcObject) {
      logJoinMedia("preview_stream_clear");
      videoRef.current.srcObject = null;
    }
  }, [localStream, previewStream]);
  useEffect(() => {
    return () => {
      const handedOffTrackIds = handedOffTrackIdsRef.current;
      logJoinMedia("unmount_stop_local_stream", {
        localStream: getJoinStreamDebugSnapshot(localStreamRef.current),
        handedOffTrackIds: Array.from(handedOffTrackIds),
      });
      localStreamRef.current?.getTracks().forEach((track) => {
        if (handedOffTrackIds.has(track.id)) return;
        track.stop();
      });
    };
  }, []);

  const commitPrejoinMedia = () => {
    if (!onPrejoinMediaCommit) return;
    const stream = localStreamRef.current;
    const shouldCommitCamera = cameraIntentRef.current;
    const shouldCommitMic = micIntentRef.current;
    const liveTracks =
      stream
        ?.getTracks()
        .filter((track) => {
          if (track.readyState !== "live") return false;
          if (track.kind === "video") return shouldCommitCamera;
          if (track.kind === "audio") return shouldCommitMic;
          return true;
        }) ?? [];
    handedOffTrackIdsRef.current = new Set(
      liveTracks.map((track) => track.id),
    );
    const handoffStream =
      liveTracks.length > 0 ? new MediaStream(liveTracks) : null;
    const hasLiveVideo = liveTracks.some((track) => track.kind === "video");
    const hasLiveAudio = liveTracks.some((track) => track.kind === "audio");
    logJoinMedia("commit_prejoin_media", {
      handoffStream: getJoinStreamDebugSnapshot(handoffStream),
      isCameraOn: shouldCommitCamera,
      isMicOn: shouldCommitMic,
    });
    onPrejoinMediaCommit({
      stream: handoffStream,
      isCameraOn: shouldCommitCamera && hasLiveVideo,
      isMicOn: shouldCommitMic && hasLiveAudio,
    });
  };

  const toggleCamera = async () => {
    if (toggleCameraInFlightRef.current) {
      logJoinMedia("toggle_camera_ignored_in_flight", {
        isCameraOn,
        localStream: getJoinStreamDebugSnapshot(localStream),
      });
      return;
    }

    const requestGeneration = beginPrejoinMediaRequest(["video"]);
    toggleCameraInFlightRef.current = true;
    try {
      logJoinMedia("toggle_camera_start", {
        isCameraOn,
        localStream: getJoinStreamDebugSnapshot(localStream),
        videoEffects,
      });
      const currentStream = localStreamRef.current ?? localStream;
      if (isCameraOn && currentStream) {
        cameraIntentRef.current = false;
        const track = currentStream.getVideoTracks()[0];
        if (track) {
          logJoinMedia("camera_track_stop", {
            track: getJoinTrackDebugSnapshot(track),
          });
          track.stop();
        }
        const nextTracks = currentStream
          .getTracks()
          .filter((candidate) => candidate !== track);
        commitLocalPreviewStream(
          nextTracks.length > 0 ? new MediaStream(nextTracks) : null,
        );
        setIsCameraOn(false);
        logJoinMedia("toggle_camera_off_done", {
          nextTrackCount: nextTracks.length,
        });
        return;
      }
      try {
        const videoConstraints = getPrejoinVideoConstraints();
        logJoinMedia("get_user_media_video_request", {
          constraints: videoConstraints,
        });
        const stream = await getUserMediaWithTimeout(
          { video: videoConstraints },
          {
            label: "prejoin camera toggle",
            timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
          },
        );
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
          stopTracks(stream.getTracks());
          warnJoinMedia("get_user_media_video_missing_track", {
            stream: getJoinStreamDebugSnapshot(stream),
          });
          return;
        }
        if (!isCurrentPrejoinMediaRequest("video", requestGeneration.video)) {
          stopTracks(stream.getTracks());
          logJoinMedia("discard_stale_prejoin_camera_toggle", {
            requestGeneration,
            currentGeneration: getCurrentPrejoinMediaGeneration("video"),
          });
          return;
        }
        if ("contentHint" in videoTrack) videoTrack.contentHint = "motion";
        const latestStream = localStreamRef.current;
        if (latestStream) {
          const nextStream = new MediaStream([
            ...latestStream.getTracks(),
            videoTrack,
          ]);
          logJoinMedia("camera_track_add_to_existing_stream", {
            receivedStream: getJoinStreamDebugSnapshot(stream),
            nextStream: getJoinStreamDebugSnapshot(nextStream),
          });
          commitLocalPreviewStream(nextStream);
        } else {
          logJoinMedia("camera_stream_set", {
            stream: getJoinStreamDebugSnapshot(stream),
          });
          commitLocalPreviewStream(stream);
        }
        cameraIntentRef.current = true;
        setIsCameraOn(true);
        prewarmLiveCameraEffects("prejoin-camera-toggle-live");
        logJoinMedia("toggle_camera_on_done", {
          track: getJoinTrackDebugSnapshot(videoTrack),
        });
      } catch (err) {
        warnJoinMedia("get_user_media_video_failed", {
          error:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack }
              : err,
        });
        cameraIntentRef.current = false;
      }
    } finally {
      toggleCameraInFlightRef.current = false;
    }
  };

  const toggleMic = async () => {
    if (toggleMicInFlightRef.current) {
      logJoinMedia("toggle_mic_ignored_in_flight", {
        isMicOn,
        localStream: getJoinStreamDebugSnapshot(localStream),
      });
      return;
    }

    const requestGeneration = beginPrejoinMediaRequest(["audio"]);
    toggleMicInFlightRef.current = true;
    logJoinMedia("toggle_mic_start", {
      isMicOn,
      localStream: getJoinStreamDebugSnapshot(localStream),
    });
    try {
      const currentStream = localStreamRef.current ?? localStream;
      if (isMicOn && currentStream) {
        micIntentRef.current = false;
        const track = currentStream.getAudioTracks()[0];
        if (track) {
          logJoinMedia("mic_track_stop", {
            track: getJoinTrackDebugSnapshot(track),
          });
          track.stop();
        }
        const nextTracks = currentStream
          .getTracks()
          .filter((candidate) => candidate !== track);
        commitLocalPreviewStream(
          nextTracks.length > 0 ? new MediaStream(nextTracks) : null,
        );
        setIsMicOn(false);
        logJoinMedia("toggle_mic_off_done", {
          nextTrackCount: nextTracks.length,
        });
        return;
      }

      logJoinMedia("get_user_media_audio_request", {
        constraints: DEFAULT_AUDIO_CONSTRAINTS,
      });
      const stream = await getUserMediaWithTimeout(
        { audio: DEFAULT_AUDIO_CONSTRAINTS },
        {
          label: "prejoin microphone toggle",
          timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
        },
      );
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stopTracks(stream.getTracks());
        warnJoinMedia("get_user_media_audio_missing_track", {
          stream: getJoinStreamDebugSnapshot(stream),
        });
        return;
      }
      if (!isCurrentPrejoinMediaRequest("audio", requestGeneration.audio)) {
        stopTracks(stream.getTracks());
        logJoinMedia("discard_stale_prejoin_mic_toggle", {
          requestGeneration,
          currentGeneration: getCurrentPrejoinMediaGeneration("audio"),
        });
        return;
      }
      const latestStream = localStreamRef.current;
      if (latestStream) {
        const nextStream = new MediaStream([
          ...latestStream.getTracks(),
          audioTrack,
        ]);
        logJoinMedia("mic_track_add_to_existing_stream", {
          receivedStream: getJoinStreamDebugSnapshot(stream),
          nextStream: getJoinStreamDebugSnapshot(nextStream),
        });
        commitLocalPreviewStream(nextStream);
      } else {
        logJoinMedia("mic_stream_set", {
          stream: getJoinStreamDebugSnapshot(stream),
        });
        commitLocalPreviewStream(stream);
      }
      micIntentRef.current = true;
      setIsMicOn(true);
      logJoinMedia("toggle_mic_on_done", {
        track: getJoinTrackDebugSnapshot(audioTrack),
      });
    } catch (err) {
      warnJoinMedia("get_user_media_audio_failed", {
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err,
      });
      micIntentRef.current = false;
    } finally {
      toggleMicInFlightRef.current = false;
    }
  };

  // Fire the actual join once the deferred guest user AND the host flag have
  // both propagated. onJoinRoom is rebuilt by the parent with the right
  // isHost, and arrives on the same render as the updated isAdmin prop.
  useEffect(() => {
    if (!pending || !hasIdentity) return;
    const wantAdmin = pending.mode === "new";
    if (Boolean(isAdmin) !== wantAdmin) return;
    const { mode, roomId: targetId } = pending;
    setPending(null);
    if (mode === "new" && enableRoomRouting && typeof window !== "undefined") {
      window.history.pushState(null, "", `/${targetId}`);
    }
    onRoomIdChange(targetId);
    onJoinRoom(targetId);
  }, [pending, hasIdentity, isAdmin, enableRoomRouting, onJoinRoom, onRoomIdChange]);

  // Ensure a guest user exists (from the name field) before acting; returns
  // false when nothing actionable (no identity and no usable name).
  const ensureGuest = (): boolean => {
    const name = liveDisplayName;
    if (hasIdentity) {
      if (
        user?.id?.startsWith("guest-") &&
        name &&
        name !== normalizeGuestName(user.name || "")
      ) {
        onUserChange(buildGuestUser(name, user));
      }
      return true;
    }
    if (!name) return false;
    onUserChange(buildGuestUser(name, user));
    return true;
  };

  const startMeeting = () => {
    if (!ensureGuest()) return;
    onEnterStart?.("new");
    commitPrejoinMedia();
    onIsAdminChange(true);
    setPending({ mode: "new", roomId: generateRoomCode() });
  };
  const joinMeeting = () => {
    const candidate = enforceShortCode
      ? sanitizeRoomCode(normalizedRoomId)
      : normalizedRoomId.trim();
    if (!candidate) return;
    if (!ensureGuest()) return;
    onEnterStart?.("join");
    commitPrejoinMedia();
    onIsAdminChange(false);
    setPending({ mode: "join", roomId: candidate });
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const clearGuest = () => {
      if (typeof window !== "undefined")
        window.localStorage.removeItem(GUEST_USER_STORAGE_KEY);
    };
    if (!session?.user) {
      clearGuest();
      onUserChange(null);
      onIsAdminChange(false);
      setGuestName("");
      setIsSigningOut(false);
      return;
    }
    await signOut()
      .then(() => {
        clearGuest();
        onUserChange(null);
        onIsAdminChange(false);
        setGuestName("");
      })
      .catch((error) => console.error("Sign out error:", error));
    setIsSigningOut(false);
  };

  const onCodeChange = (raw: string) => {
    const next = enforceShortCode
      ? sanitizeRoomCodeInput(raw).slice(0, ROOM_CODE_MAX_LENGTH)
      : extractRoomCode(raw);
    onRoomIdChange(next);
  };

  const canJoin = normalizedRoomId.trim().length > 0;
  const nameReady = hasIdentity || liveDisplayName.length > 0;

  // Resolve how many people are already in the room we're about to join, matched
  // against the polled occupancy list (see useMeetRooms). A room with no one in
  // it simply isn't in the list, which reads as 0 — "no one else is here yet".
  const presenceTarget = enforceShortCode
    ? sanitizeRoomCode(normalizedRoomId)
    : normalizedRoomId.trim();
  useEffect(() => {
    if (roomsStatus === "loading") setPresenceChecked(true);
    else if (roomsStatus === "idle" && presenceChecked) setPresenceSettled(true);
  }, [roomsStatus, presenceChecked]);
  const matchedRoom = presenceTarget
    ? rooms.find(
        (room) => room.id.toLowerCase() === presenceTarget.toLowerCase(),
      )
    : undefined;
  const showPresence = presenceTarget.length > 0 && presenceChecked;
  // Until the first check settles show "Checking…"; afterwards always show the
  // real count (a room with no one in it isn't in the list, so that's 0).
  const presenceCount = presenceSettled ? matchedRoom?.userCount ?? 0 : null;
  const presenceLoading = !presenceSettled;

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(
        devices
          .filter((d) => d.kind === "audioinput" && d.deviceId)
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      );
      setVideoInputs(
        devices
          .filter((d) => d.kind === "videoinput" && d.deviceId)
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` })),
      );
    } catch {
      // enumeration can fail before permission — leave the lists as-is.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (!navigator.mediaDevices?.addEventListener) return;
    const onDeviceChange = () => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [refreshDevices]);

  // Once a stream is live the OS exposes device labels + the active deviceId,
  // so re-enumerate and sync the dropdowns to whatever is actually in use.
  useEffect(() => {
    void refreshDevices();
    const videoId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    if (videoId) setSelectedVideoId(videoId);
    const audioId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
    if (audioId) setSelectedAudioId(audioId);
  }, [localStream, refreshDevices]);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  const handleSelectVideoDevice = async (deviceId: string) => {
    setSelectedVideoId(deviceId);
    if (!isCameraOn || toggleCameraInFlightRef.current) return;
    const requestGeneration = beginPrejoinMediaRequest(["video"]);
    toggleCameraInFlightRef.current = true;
    try {
      const base = getPrejoinVideoConstraints();
      const videoConstraints =
        base && typeof base === "object"
          ? { ...base, deviceId: { exact: deviceId } }
          : { deviceId: { exact: deviceId } };
      const stream = await getUserMediaWithTimeout(
        { video: videoConstraints },
        {
          label: "prejoin camera device switch",
          timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
        },
      );
      const newTrack = stream.getVideoTracks()[0];
      if (!newTrack) {
        stopTracks(stream.getTracks());
        return;
      }
      if (!isCurrentPrejoinMediaRequest("video", requestGeneration.video)) {
        stopTracks(stream.getTracks());
        logJoinMedia("discard_stale_prejoin_video_device_select", {
          requestGeneration,
          currentGeneration: getCurrentPrejoinMediaGeneration("video"),
        });
        return;
      }
      if ("contentHint" in newTrack) newTrack.contentHint = "motion";
      const current = localStreamRef.current;
      const oldTrack = current?.getVideoTracks()[0] ?? null;
      oldTrack?.stop();
      const others = current?.getTracks().filter((t) => t !== oldTrack) ?? [];
      commitLocalPreviewStream(new MediaStream([...others, newTrack]));
      cameraIntentRef.current = true;
    } catch (err) {
      warnJoinMedia("select_video_device_failed", {
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
    } finally {
      toggleCameraInFlightRef.current = false;
    }
  };

  const handleSelectAudioDevice = async (deviceId: string) => {
    setSelectedAudioId(deviceId);
    if (!isMicOn) return;
    const requestGeneration = beginPrejoinMediaRequest(["audio"]);
    try {
      const stream = await getUserMediaWithTimeout(
        {
          audio: {
            ...DEFAULT_AUDIO_CONSTRAINTS,
            deviceId: { exact: deviceId },
          },
        },
        {
          label: "prejoin microphone device switch",
          timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
        },
      );
      const newTrack = stream.getAudioTracks()[0];
      if (!newTrack) {
        stopTracks(stream.getTracks());
        return;
      }
      if (!isCurrentPrejoinMediaRequest("audio", requestGeneration.audio)) {
        stopTracks(stream.getTracks());
        logJoinMedia("discard_stale_prejoin_audio_device_select", {
          requestGeneration,
          currentGeneration: getCurrentPrejoinMediaGeneration("audio"),
        });
        return;
      }
      const current = localStreamRef.current;
      const oldTrack = current?.getAudioTracks()[0] ?? null;
      oldTrack?.stop();
      const others = current?.getTracks().filter((t) => t !== oldTrack) ?? [];
      commitLocalPreviewStream(new MediaStream([...others, newTrack]));
      micIntentRef.current = true;
    } catch (err) {
      warnJoinMedia("select_audio_device_failed", {
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
    }
  };

  const inviteLink =
    typeof window === "undefined"
      ? ""
      : isRoutedRoom
        ? window.location.href
        : presenceTarget
          ? `${window.location.origin}/${presenceTarget}`
          : "";
  const handleCopyLink = async () => {
    if (!inviteLink || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setLinkCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      // clipboard can be blocked; nothing actionable.
    }
  };

  const showVideoPicker = isCameraOn && videoInputs.length > 0;
  const showAudioPicker = isMicOn && audioInputs.length > 0;
  const showDevicePickers = showVideoPicker || showAudioPicker;
  const handleNameInputChange = (nextName: string) => {
    setGuestName(nextName);
    onDisplayNameInputChange(nextName);
  };

  return (
    <div className="relative min-h-screen w-full bg-[#0a0a0b] text-[#fafafa]">
      <main className="flex min-h-dvh w-full flex-col items-stretch px-0 pb-6 pt-[calc(env(safe-area-inset-top,0px)+5rem)] sm:items-center sm:justify-center sm:px-4 sm:py-10 sm:pt-10">
        <div className="animate-fade-in flex w-full flex-1 flex-col overflow-hidden bg-[#0e0e10] sm:block sm:flex-none sm:max-w-4xl sm:rounded-2xl sm:border sm:border-white/10 md:grid md:min-h-[520px] md:grid-cols-2">
          <div className="relative min-h-[176px] flex-1 bg-[#121214] sm:aspect-video sm:h-auto sm:flex-none md:aspect-auto md:min-h-[520px]">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${isCameraOn ? "" : "hidden"}`}
                />
                {!isCameraOn && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pb-14">
                    <Avatar id={user?.id || previewName} name={previewName} size={76} />
                    <span className="text-[13.5px] text-[#fafafa]/45">Camera is off</span>
                  </div>
                )}
                {shouldShowPermissionCta ? (
                  <button
                    type="button"
                    onClick={requestMicrophoneAndCamera}
                    disabled={isRequestingPermissions}
                    className="absolute left-3 top-3 z-10 inline-flex h-8 max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full bg-[#F95F4A] px-3 text-[12.5px] font-medium text-white transition-[background-color,opacity] duration-150 hover:bg-[#e8553f] disabled:cursor-wait disabled:opacity-75"
                  >
                    {isRequestingPermissions ? (
                      <Loader2 size={14} className="shrink-0 animate-spin" />
                    ) : (
                      <Video size={14} className="shrink-0" />
                    )}
                    <span className="truncate">Allow microphone and camera</span>
                  </button>
                ) : null}
                <div
                  className={`pointer-events-none absolute top-3 inline-flex h-8 items-center rounded-full bg-black/55 px-3 text-[12.5px] font-medium backdrop-blur-sm ${
                    shouldShowPermissionCta ? "right-3" : "left-3"
                  }`}
                >
                  {previewName}
                </div>
                {(showPermissionHint || permissionRequestError) && (
                  <div className="pointer-events-none absolute bottom-[76px] left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-black/65 px-3 py-1.5 text-center text-[12.5px] font-medium text-white/80 backdrop-blur-sm">
                    {permissionRequestError ?? "Permission needed"}
                  </div>
                )}
                <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2.5">
                  <button
                    onClick={toggleMic}
                    aria-label={isMicOn ? "Turn off microphone" : "Turn on microphone"}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 ${
                      isMicOn ? "bg-[#232327] hover:bg-[#2e2e33]" : "bg-[#ea4335] hover:brightness-105"
                    }`}
                  >
                    {isMicOn ? <Mic size={18} /> : <MicOff size={18} />}
                  </button>
                  <button
                    onClick={toggleCamera}
                    aria-label={isCameraOn ? "Turn off camera" : "Turn on camera"}
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 ${
                      isCameraOn ? "bg-[#232327] hover:bg-[#2e2e33]" : "bg-[#ea4335] hover:brightness-105"
                    }`}
                  >
                    {isCameraOn ? <Video size={18} /> : <VideoOff size={18} />}
                  </button>
                  <button
                    type="button"
                    data-testid="prejoin-backgrounds-effects"
                    onClick={openEffectsPanel}
                    onFocus={() => prewarmLiveCameraEffects("prejoin-effects-button")}
                    onPointerEnter={() =>
                      prewarmLiveCameraEffects("prejoin-effects-button")
                    }
                    onTouchStart={() =>
                      prewarmLiveCameraEffects("prejoin-effects-button")
                    }
                    disabled={isCameraPermissionBlocked}
                    aria-label={
                      isCameraPermissionBlocked
                        ? "Backgrounds and effects: Permission needed"
                        : "Backgrounds and effects"
                    }
                    title={
                      isCameraPermissionBlocked
                        ? "Permission needed"
                        : "Backgrounds and effects"
                    }
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 hover:bg-[#2e2e33] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#232327] ${
                      activeVideoEffectsCount > 0
                        ? "bg-[#F95F4A] hover:bg-[#ff6d5a]"
                        : "bg-[#232327]"
                    }`}
                  >
                    <WandSparkles size={18} />
                  </button>
                </div>
              </div>

          <div className="safe-area-pb flex min-h-0 shrink-0 flex-col justify-start gap-3 p-5 pb-10 sm:gap-4 sm:p-8 sm:pb-14 md:min-h-[520px] md:justify-center">
            <div className="space-y-1.5">
              <h1
                className="text-[22px] leading-tight text-[#fafafa]"
                style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
              >
                {isRoutedRoom ? "Ready to join?" : "Start a meeting"}
              </h1>
              <p className="text-[13.5px] text-[#fafafa]/55">
                {isRoutedRoom
                  ? "Check your camera and mic before you join."
                  : "Create a room, or join one with a code."}
              </p>
            </div>
            {meetingEndedNotice ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-xl border border-[#F95F4A]/25 bg-[#F95F4A]/10 px-3.5 py-3 text-left text-[13px] leading-snug text-[#fafafa]"
              >
                <Info
                  size={16}
                  className="mt-0.5 shrink-0 text-[#F95F4A]"
                  aria-hidden="true"
                />
                <p className="min-w-0 flex-1">{meetingEndedNotice}</p>
                {onDismissMeetingEndedNotice ? (
                  <button
                    type="button"
                    onClick={onDismissMeetingEndedNotice}
                    aria-label="Dismiss meeting ended notice"
                    className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#fafafa]/55 transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
              {isSignedInUser ? (
                <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium">{previewName}</p>
                    {userEmail && (
                      <p className="truncate text-[12px] text-[#fafafa]/60">{userEmail}</p>
                    )}
                  </div>
                  <button
                    onClick={handleSignOut}
                    disabled={isSigningOut}
                    className="shrink-0 text-[13px] text-[#fafafa]/55 transition-colors hover:text-[#fafafa] disabled:opacity-50"
                  >
                    {isSigningOut ? "…" : "Sign out"}
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="block text-[11.5px] font-semibold text-[#fafafa]/40">
                    Your name
                  </label>
                  <input
                    type="text"
                    value={nameInputValue}
                    onChange={(e) => handleNameInputChange(e.target.value)}
                    placeholder="Enter your name"
                    className={FIELD}
                  />
                </div>
              )}

              {showDevicePickers && (
                <div className="space-y-2">
                  {showVideoPicker && (
                    <DeviceSelect
                      icon={Video}
                      ariaLabel="Camera"
                      value={selectedVideoId}
                      options={videoInputs}
                      onChange={handleSelectVideoDevice}
                    />
                  )}
                  {showAudioPicker && (
                    <DeviceSelect
                      icon={Mic}
                      ariaLabel="Microphone"
                      value={selectedAudioId}
                      options={audioInputs}
                      onChange={handleSelectAudioDevice}
                    />
                  )}
                </div>
              )}

              {!isRoutedRoom && (
                  <button
                    onClick={startMeeting}
                    disabled={isLoading || !nameReady}
                    className={CTA_PRIMARY}
                  >
                    <Plus size={18} />
                    New meeting
                  </button>
              )}

              {/* ScheduledMeetingsPanel disabled for now
              <ScheduledMeetingsPanel isSignedIn={isSignedInUser} />
              */}

              {allowGhostMode && (
                <button
                  type="button"
                  onClick={() => onGhostModeChange(!isGhostMode)}
                  aria-pressed={isGhostMode}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left transition-colors duration-150 hover:bg-white/[0.08]"
                >
                  <Ghost
                    size={18}
                    className={`shrink-0 transition-colors duration-[120ms] ${
                      isGhostMode ? "text-[#F95F4A]" : "text-[#fafafa]/60"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-[#fafafa]">
                      Join as ghost
                    </span>
                    <span className="block truncate text-[12.5px] text-[#fafafa]/60">
                      Others won&apos;t see you join
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[120ms] ${
                      isGhostMode ? "bg-[#F95F4A]" : "bg-[#fafafa]/[0.14]"
                    }`}
                  >
                    <span
                      className={`absolute h-[16px] w-[16px] rounded-full bg-white transition-transform duration-[120ms] ${
                        isGhostMode ? "translate-x-[19px]" : "translate-x-[3px]"
                      }`}
                    />
                  </span>
                </button>
              )}

              <div className="space-y-1.5">
                <div className="flex min-h-[16px] items-center justify-between gap-3">
                  <label className="text-[11.5px] font-semibold text-[#fafafa]/40">
                    {isRoutedRoom ? "Room" : "Join with a code"}
                  </label>
                  {showPresence ? (
                    <RoomPresenceBadge
                      count={presenceCount}
                      loading={presenceLoading}
                    />
                  ) : null}
                </div>
                <input
                  type="text"
                  value={normalizedRoomId}
                  onChange={(e) => onCodeChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canJoin) joinMeeting();
                  }}
                  placeholder="Enter a code or link"
                  readOnly={isRoutedRoom}
                  autoFocus={isRoutedRoom}
                  className={FIELD}
                />
                <button
                  onClick={joinMeeting}
                  disabled={isLoading || !canJoin || !nameReady}
                  className={CTA_GHOST}
                >
                  Join
                </button>
              </div>

              {inviteLink && (
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-[13.5px] text-[#fafafa]/70 transition-colors duration-150 hover:bg-white/[0.06]"
                >
                  {linkCopied ? (
                    <Check size={16} className="shrink-0 text-[#22c55e]" />
                  ) : (
                    <Link2 size={16} className="shrink-0 text-[#fafafa]/45" />
                  )}
                  <span className="truncate">
                    {linkCopied ? "Link copied" : "Copy joining link"}
                  </span>
                </button>
              )}

              {!isSignedInUser && (
                <>
                  <div className="flex items-center gap-3 py-1">
                    <div className="h-px flex-1 bg-white/10" />
                    <span className="text-[12px] text-[#fafafa]/40">or</span>
                    <div className="h-px flex-1 bg-white/10" />
                  </div>
                  <a href={getSignInHref()} className={CTA_GHOST}>
                    Sign in
                  </a>
                </>
              )}
          </div>
        </div>
      </main>
      {shouldRunPreviewVideoEffects ? (
        <VideoEffectsBridge
          sourceStream={localStream}
          effects={videoEffects}
          processedVideoTrackRef={processedPreviewTrackRef}
          onStateChange={setVideoEffectsBridgeState}
        />
      ) : null}
      {isEffectsOpen && (
        <VideoEffectsPanel
          variant="dialog"
          effects={videoEffects}
          onEffectsChange={onVideoEffectsChange}
          localStream={previewStream}
          isCameraOff={!isCameraOn}
          status={videoEffectsStatus}
          error={videoEffectsError}
          debugStats={videoEffectsDebugStats}
          activeCount={activeVideoEffectsCount}
          deferPreload={shouldDeferPreviewVideoEffectsPreload}
          cameraPermissionBlocked={isCameraPermissionBlocked}
          showFilters={!isCameraPermissionBlocked}
          onToggleCamera={toggleCamera}
          onClose={() => setIsEffectsOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(JoinScreen);
