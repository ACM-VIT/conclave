"use client";

import { toSafeNextPath } from "../lib/safe-next-path";
import dynamic from "next/dynamic";
import {
  Headphones,
  Loader2,
  WandSparkles,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Plus,
  ChevronDown,
  Check,
  Link2,
  Link2Off,
  Info,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { prefetchConclaveAnimation } from "../lib/conclaveAnimation";
import { prefetchConclaveLock } from "../lib/conclaveSound";
import type { Dispatch, SetStateAction } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { signOut, useSession } from "@/lib/auth-client";
import { getMeetingLinkOrigins } from "@/lib/site-url";
import { buildMeetingPath, buildMeetingUrl, type RoomDestination } from "@/lib/meeting-links";
import { resolveMeetingClientId } from "@/lib/sfu-client-id";
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
  PASTED_INPUT,
  applyFieldEdit,
  inputEditRange,
  normalizeCodeField,
  parseCodeFieldPaste,
  planFieldEdit,
  sanitizeInstitutionDisplayName,
  trackFieldHistory,
} from "../lib/utils";
import type { SetupNotice } from "../lib/setup-notice";
import RoomPresenceBadge from "./RoomPresenceBadge";
import { useCameraAccessBlocked } from "../hooks/useCameraAccessBlocked";
import { useClipboardCopy } from "../hooks/useClipboardCopy";
import { useCodeField } from "../hooks/useCodeField";
import { applyRejoinMedia, saveRejoinIntent, type RejoinMedia } from "../lib/rejoin-intent";
import { useRejoinMediaRestore } from "../hooks/useRejoinMediaRestore";
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
import {
  getCameraBaseVideoQuality,
  readStoredMediaQualitySettings,
  resolveCameraPublishSettings,
  resolveEffectiveCameraPublishSettings,
} from "../lib/media-quality-settings";

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

const getPrejoinVideoConstraints = (effectsActive = false) => {
  const snapshot = getBrowserNetworkSnapshot();
  const mediaQualitySettings = readStoredMediaQualitySettings();
  const profile = snapshot.emergency
    ? "emergency"
    : snapshot.startupQuality === "poor"
    ? "poor"
    : snapshot.startupQuality === "fair"
    ? "fair"
    : "good";
  return buildCameraVideoConstraints(
    getCameraBaseVideoQuality(mediaQualitySettings.camera),
    profile,
    undefined,
    resolveEffectiveCameraPublishSettings(
      mediaQualitySettings.camera,
      effectsActive,
    ),
  );
};

const applyPrejoinCameraContentHint = (
  track: MediaStreamTrack | null | undefined,
) => {
  if (!track || !("contentHint" in track)) return;
  const settings = readStoredMediaQualitySettings();
  track.contentHint = resolveCameraPublishSettings(settings.camera).contentHint;
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

type PrejoinMediaKind = "audio" | "video";
type PrejoinCapture = { source: "choice" | "restore" | "permissions" };
type PrejoinCaptureSlots = Partial<Record<PrejoinMediaKind, PrejoinCapture>>;
const PREJOIN_MEDIA_KINDS: readonly PrejoinMediaKind[] = ["audio", "video"];

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
  clientId?: string;
  showPermissionHint: boolean;
  rooms: RoomInfo[];
  roomsStatus: "idle" | "loading" | "error";
  onRefreshRooms: (id?: string) => void;
  displayNameInput: string;
  onDisplayNameInputChange: (value: string) => void;
  onUserChange: (user: { id: string; email: string; name: string } | null) => void;
  onIsAdminChange: (isAdmin: boolean) => void;
  mediaError?: MeetError | null;
  setupNotice?: SetupNotice | null;
  onDismissSetupNotice?: () => void;
  initialMedia?: RejoinMedia | null;
  onInitialMediaUsed?: () => void;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
  onEnterStart?: (action: "new" | "join") => void;
}

const FIELD =
  "w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 h-12 short-screen:h-11 text-[15px] text-[#fafafa] placeholder:text-[#fafafa]/30 transition-[border-color,background-color] duration-150 focus:border-[#F95F4A]/60 focus:bg-white/[0.05] focus:outline-none disabled:opacity-50";
const CTA_PRIMARY =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl short-screen:h-11 bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-[1.05] disabled:bg-[#232327] disabled:text-[#fafafa]/40 disabled:cursor-not-allowed";
const CTA_GHOST =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl short-screen:h-11 border border-white/10 bg-white/[0.04] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.08] disabled:opacity-50";
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

const deviceLabel = (options: DeviceOption[], selectedId: string) =>
  (options.find((option) => option.deviceId === selectedId) ?? options[0])?.label;

function DeviceSelect({
  icon: Icon,
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
}: {
  icon: LucideIcon;
  value: string;
  options: DeviceOption[];
  onChange: (deviceId: string) => void;
  ariaLabel: string;
  placeholder: string;
}) {
  const disabled = options.length === 0;
  return (
    <div className="relative min-w-0">
      <Icon
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#fafafa]/45"
      />
      <select
        aria-label={ariaLabel}
        disabled={disabled}
        value={disabled ? "" : value || options[0]?.deviceId || ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full cursor-pointer appearance-none truncate rounded-xl border border-white/10 bg-white/[0.03] pl-9 pr-8 text-[13px] text-[#fafafa] transition-colors duration-150 hover:bg-white/[0.05] focus:border-[#F95F4A]/60 focus:outline-none disabled:cursor-default disabled:text-[#fafafa]/40 disabled:hover:bg-white/[0.03]"
      >
        {disabled ? (
          <option value="" className="bg-[#18181b] text-[#fafafa]">
            {placeholder}
          </option>
        ) : (
          options.map((option) => (
            <option
              key={option.deviceId}
              value={option.deviceId}
              className="bg-[#18181b] text-[#fafafa]"
            >
              {option.label}
            </option>
          ))
        )}
      </select>
      <ChevronDown
        size={15}
        className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 ${disabled ? "text-[#fafafa]/20" : "text-[#fafafa]/45"}`}
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
  clientId,
  enableRoomRouting,
  showPermissionHint,
  rooms,
  roomsStatus,
  onRefreshRooms,
  displayNameInput,
  onDisplayNameInputChange,
  onUserChange,
  onIsAdminChange,
  mediaError,
  setupNotice,
  onDismissSetupNotice,
  initialMedia,
  onInitialMediaUsed,
  videoEffects,
  onVideoEffectsChange,
  onPrejoinMediaCommit,
  onEnterStart,
}: JoinScreenProps) {
  const pageClientId = resolveMeetingClientId(clientId);
  const codeField = useCodeField(roomId, getMeetingLinkOrigins(), pageClientId, enableRoomRouting || forceJoinOnly);
  const isRoutedRoom = forceJoinOnly;
  const nameInputId = useId();
  const codeInputId = useId();
  const codeProblemId = useId();
  const noLinkReasonId = useId();

  useEffect(() => {
    prefetchConclaveAnimation();
    prefetchConclaveLock();
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const processedPreviewTrackRef = useRef<MediaStreamTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const handedOffTrackIdsRef = useRef<Set<string>>(new Set());
  const captureSlotsRef = useRef<PrejoinCaptureSlots>({});
  const hadCarriedMediaRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  // Join without sending or receiving video (for slow connections). Carried
  // into the meeting through the prejoin media handoff.
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  // Read by async camera paths, which must not start video once audio-only
  // mode is on even if they began before it was turned on.
  const audioOnlyRef = useRef(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [permissionRequestError, setPermissionRequestError] = useState<
    string | null
  >(null);
  const [isEffectsOpen, setIsEffectsOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [presenceChecked, setPresenceChecked] = useState(false);
  const [presenceSettled, setPresenceSettled] = useState(false);
  const [audioInputs, setAudioInputs] = useState<DeviceOption[]>([]);
  const [videoInputs, setVideoInputs] = useState<DeviceOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState("");
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [pending, setPending] = useState<{ mode: "new" | "join"; destination: RoomDestination } | null>(null);

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
  const hasLivePreviewCamera = Boolean(
    localStream
      ?.getVideoTracks()
      .some((track) => track.readyState === "live" && track.enabled),
  );
  const isCameraPermissionBlocked = useCameraAccessBlocked({
    hasLiveCamera: hasLivePreviewCamera,
    mediaError,
  });
  const shouldShowPermissionCta = !isCameraOn && isCameraPermissionBlocked;
  const tightAudioChip = shouldShowPermissionCta && isAudioOnly;
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

  const setCaptureSlots = (next: PrejoinCaptureSlots) => {
    captureSlotsRef.current = next;
    setIsRequestingPermissions(
      PREJOIN_MEDIA_KINDS.some((kind) => next[kind]?.source === "permissions"),
    );
  };

  const cancelCaptures = (
    matches: (owner: PrejoinCapture, kind: PrejoinMediaKind) => boolean,
  ) => {
    const next = { ...captureSlotsRef.current };
    let changed = false;
    for (const kind of PREJOIN_MEDIA_KINDS) {
      const owner = next[kind];
      if (!owner || !matches(owner, kind)) continue;
      delete next[kind];
      changed = true;
    }
    if (changed) setCaptureSlots(next);
  };

  const beginCapture = (
    source: PrejoinCapture["source"],
    kinds: readonly PrejoinMediaKind[],
  ) => {
    const owner: PrejoinCapture = { source };
    const next = { ...captureSlotsRef.current };
    for (const kind of kinds) next[kind] = owner;
    setCaptureSlots(next);
    return {
      currentKinds: () => kinds.filter((kind) => captureSlotsRef.current[kind] === owner),
      release: () => cancelCaptures((candidate) => candidate === owner),
    };
  };

  const replacePreviewTracks = (
    kinds: readonly PrejoinMediaKind[],
    tracks: readonly MediaStreamTrack[],
  ) => {
    const accepted = tracks.filter((track) => {
      if (
        (track.kind === "audio" || track.kind === "video") &&
        kinds.includes(track.kind) &&
        track.readyState === "live"
      ) {
        if (track.kind === "video") applyPrejoinCameraContentHint(track);
        return true;
      }
      track.stop();
      return false;
    });
    if (kinds.length === 0) return;

    const preserved = (localStreamRef.current?.getTracks() ?? []).filter((track) => {
      if (
        (track.kind === "audio" || track.kind === "video") &&
        kinds.includes(track.kind)
      ) {
        if (!accepted.includes(track)) track.stop();
        return false;
      }
      return track.readyState === "live";
    });
    const nextTracks = [...preserved, ...accepted];
    const stream = nextTracks.length ? new MediaStream(nextTracks) : null;
    localStreamRef.current = stream;
    setLocalStream(stream);
    setIsMicOn(nextTracks.some((track) => track.kind === "audio"));
    setIsCameraOn(nextTracks.some((track) => track.kind === "video"));
    if (accepted.some((track) => track.kind === "video")) {
      prewarmLiveCameraEffects("prejoin-camera-live");
    }
  };

  const markUserMediaChoice = () => {
    cancelRejoinRestore();
    cancelCaptures((owner) => owner.source === "restore");
  };

  const requestMicrophoneAndCamera = async () => {
    markUserMediaChoice();
    const wantsVideo = !audioOnlyRef.current;
    const request = beginCapture("permissions", wantsVideo ? PREJOIN_MEDIA_KINDS : ["audio"]);
    const videoConstraints = wantsVideo
      ? getPrejoinVideoConstraints(shouldRunPreviewVideoEffects)
      : false;
    const permissionCapture = (constraints: MediaStreamConstraints, label: string) =>
      getUserMediaWithTimeout(constraints, {
        label,
        timeoutMs: MEDIA_CAPTURE_PERMISSION_TIMEOUT_MS,
      });

    setPermissionRequestError(null);
    try {
      const stream = await permissionCapture(
        { audio: DEFAULT_AUDIO_CONSTRAINTS, video: videoConstraints },
        "prejoin microphone and camera permission request",
      );
      replacePreviewTracks(request.currentKinds(), stream.getTracks());
    } catch (err) {
      const retryKinds = request.currentKinds();
      if (retryKinds.length === 0) return;
      warnJoinMedia("get_user_media_full_failed", {
        error: err instanceof Error ? { name: err.name, message: err.message } : err,
      });
      const results = await Promise.allSettled(retryKinds.map((kind) =>
        permissionCapture(
          kind === "audio" ? { audio: DEFAULT_AUDIO_CONSTRAINTS } : { video: videoConstraints },
          `prejoin ${kind} fallback permission request`,
        ),
      ));
      const tracks = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value.getTracks() : [],
      );
      const currentKinds = request.currentKinds();
      replacePreviewTracks(currentKinds, tracks);
      if (currentKinds.length === 0) return;
      const missing = currentKinds.filter(
        (kind) => !localStreamRef.current?.getTracks().some((track) => track.kind === kind),
      );
      setPermissionRequestError(
        missing.length === 2 ? "Permission needed"
          : missing[0] === "audio" ? "Microphone unavailable"
          : missing[0] === "video" ? "Camera unavailable"
          : null,
      );
    } finally {
      request.release();
    }
  };

  const [nextParam, setNextParam] = useState<string | null>(null);
  const hasPushedNextRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const candidate = toSafeNextPath(
      new URLSearchParams(window.location.search).get("next"),
    );
    if (!candidate) return;
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
      captureSlotsRef.current = {};
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

  const livePreviewTracks = () =>
    (localStreamRef.current?.getTracks() ?? []).filter(
      (track) => track.readyState === "live" &&
        (track.kind !== "video" || !audioOnlyRef.current),
    );

  const previewMedia = (tracks: readonly MediaStreamTrack[]): RejoinMedia => ({
    isMicOn: tracks.some((track) => track.kind === "audio"),
    isCameraOn: tracks.some((track) => track.kind === "video"),
    isAudioOnly: audioOnlyRef.current,
  });

  const commitPrejoinMedia = (skipMutedMicWarmup: boolean) => {
    if (!onPrejoinMediaCommit) return;
    const tracks = livePreviewTracks();
    handedOffTrackIdsRef.current = new Set(tracks.map((track) => track.id));
    const stream = tracks.length > 0 ? new MediaStream(tracks) : null;
    const media = previewMedia(tracks);
    logJoinMedia("commit_prejoin_media", {
      handoffStream: getJoinStreamDebugSnapshot(stream),
      ...media,
    });
    onPrejoinMediaCommit({ stream, ...media, skipMutedMicWarmup });
  };

  const setPreviewAudioOnly = (enabled: boolean) => {
    audioOnlyRef.current = enabled;
    setIsAudioOnly(enabled);
    if (!enabled) return;
    cancelCaptures((_, kind) => kind === "video");
    replacePreviewTracks(["video"], []);
  };

  const capturePreviewDevice = async (
    kind: PrejoinMediaKind,
    source: "choice" | "restore",
    deviceId?: string,
  ) => {
    if (kind === "video" && audioOnlyRef.current) return;
    const request = beginCapture(source, [kind]);
    const constraints = kind === "audio"
      ? DEFAULT_AUDIO_CONSTRAINTS
      : getPrejoinVideoConstraints(shouldRunPreviewVideoEffects);
    try {
      const stream = await getUserMediaWithTimeout(
        { [kind]: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints },
        {
          label: `prejoin ${kind} ${deviceId ? "device switch" : "toggle"}`,
          timeoutMs: MEDIA_CAPTURE_RECOVERY_TIMEOUT_MS,
        },
      );
      const tracks = stream.getTracks();
      const currentKinds = request.currentKinds();
      if (!tracks.some((track) => track.kind === kind && track.readyState === "live")) {
        replacePreviewTracks([], tracks);
        return;
      }
      replacePreviewTracks(currentKinds, tracks);
    } catch (err) {
      if (request.currentKinds().length !== 0) {
        warnJoinMedia("get_user_media_preview_failed", {
          kind, deviceId,
          error: err instanceof Error ? { name: err.name, message: err.message } : err,
        });
      }
    } finally {
      request.release();
    }
  };

  const togglePreviewDevice = (kind: PrejoinMediaKind, enabled: boolean) => {
    markUserMediaChoice();
    if (enabled) return capturePreviewDevice(kind, "choice");
    cancelCaptures((_, candidate) => candidate === kind);
    replacePreviewTracks([kind], []);
  };

  const toggleAudioOnly = () => {
    markUserMediaChoice();
    setPreviewAudioOnly(!audioOnlyRef.current);
  };
  const toggleCamera = () => togglePreviewDevice("video", !isCameraOn);
  const toggleMic = () => togglePreviewDevice("audio", !isMicOn);

  useEffect(() => {
    if (!pending || !hasIdentity) return;
    const wantAdmin = pending.mode === "new";
    if (Boolean(isAdmin) !== wantAdmin) return;
    const { destination } = pending;
    setPending(null);
    const targetPath = buildMeetingPath(destination);
    if (
      enableRoomRouting &&
      !forceJoinOnly &&
      typeof window !== "undefined" &&
      targetPath &&
      `${window.location.pathname}${window.location.search}` !== targetPath
    ) {
      window.history.pushState(null, "", targetPath);
    }
    onRoomIdChange(destination.roomCode);
    onJoinRoom(destination.roomCode);
  }, [pending, hasIdentity, isAdmin, enableRoomRouting, forceJoinOnly, onJoinRoom, onRoomIdChange]);

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

  const cancelRejoinRestore = useRejoinMediaRestore(initialMedia, (media, signal) => {
    hadCarriedMediaRef.current = true;
    onInitialMediaUsed?.();
    return applyRejoinMedia(media, {
      canRestore: () => !signal.aborted,
      isAudioOnly: () => audioOnlyRef.current,
      isMicOn: () => previewMedia(livePreviewTracks()).isMicOn,
      isCameraOn: () => previewMedia(livePreviewTracks()).isCameraOn,
      turnOnAudioOnly: () => setPreviewAudioOnly(true),
      turnOnMic: () => capturePreviewDevice("audio", "restore"),
      turnOnCamera: () => capturePreviewDevice("video", "restore"),
    });
  });
  const settlePreviewForEntry = () => {
    const skipMutedMicWarmup =
      Boolean(initialMedia) ||
      hadCarriedMediaRef.current ||
      PREJOIN_MEDIA_KINDS.some((kind) => captureSlotsRef.current[kind]);
    cancelRejoinRestore();
    cancelCaptures(() => true);
    return skipMutedMicWarmup;
  };
  const startMeeting = () => {
    if (!ensureGuest()) return;
    const skipMutedMicWarmup = settlePreviewForEntry();
    onEnterStart?.("new");
    commitPrejoinMedia(skipMutedMicWarmup);
    onIsAdminChange(true);
    setPending({ mode: "new", destination: { roomCode: generateRoomCode(), clientId: pageClientId } });
  };
  const joinMeeting = () => {
    const { destination, onThisPage } = codeField;
    if (!destination.roomCode || !ensureGuest()) return;
    if (!onThisPage) {
      const path = buildMeetingPath(destination);
      if (!path) return;
      settlePreviewForEntry();
      saveRejoinIntent(
        { roomId: destination.roomCode, clientId: destination.clientId },
        previewMedia(livePreviewTracks()),
      );
      window.location.assign(path);
      return;
    }
    const skipMutedMicWarmup = settlePreviewForEntry();
    onEnterStart?.("join");
    commitPrejoinMedia(skipMutedMicWarmup);
    onIsAdminChange(false);
    setPending({ mode: "join", destination });
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

  const normalizeCode = normalizeCodeField;
  const shapeCodeEdit = (
    event: { preventDefault(): void },
    input: HTMLInputElement,
    [start, end]: readonly [number, number],
    text: string,
    nativeTyping: boolean,
  ) => {
    const edit = planFieldEdit(input.value, start, end, text, normalizeCode);
    if (nativeTyping && edit.start === start && edit.end === end && edit.text === text) return;
    event.preventDefault();
    applyFieldEdit(input, edit);
  };
  const pasteIntoCode = (
    event: { preventDefault(): void },
    input: HTMLInputElement,
    text: string,
  ) => {
    const paste = parseCodeFieldPaste(text, getMeetingLinkOrigins());
    if (!paste) {
      event.preventDefault();
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (paste.kind === "replace") {
      const keepsTenant = resolveMeetingClientId(paste.clientId) !== pageClientId;
      const replacement = keepsTenant ? text.trim() : paste.code;
      shapeCodeEdit(event, input, [0, input.value.length], replacement, false);
    } else {
      shapeCodeEdit(event, input, [start, end], paste.text, false);
    }
    codeField.settle();
  };
  const shapeTypedCodeEdits = (input: HTMLInputElement | null) => {
    if (!input) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
      if (PASTED_INPUT.has(event.inputType)) {
        pasteIntoCode(event, input, text);
        return;
      }
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const range = inputEditRange(event.inputType, start, end, input.value);
      if (!range) return;
      const inserts = event.inputType.startsWith("insert");
      shapeCodeEdit(event, input, range, inserts ? text : "", event.inputType === "insertText");
    };
    const settleField = () => {
      if (input.value === normalizeCode(input.value)) return;
      const caret = input.selectionEnd ?? input.value.length;
      applyFieldEdit(input, planFieldEdit(input.value, caret, caret, "", normalizeCode));
    };
    const onInput = (event: Event) => {
      if (!(event instanceof InputEvent) || event.isComposing) return;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") return;
      settleField();
    };
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("compositionend", settleField);
    const stopTrackingHistory = trackFieldHistory(input);
    input.addEventListener("input", onInput);
    return () => {
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("compositionend", settleField);
      input.removeEventListener("input", onInput);
      stopTrackingHistory();
    };
  };

  const codeResolution = codeField.resolution;
  const joinCode = codeResolution.code;
  const canJoin = joinCode.length > 0;
  const nameReady = hasIdentity || liveDisplayName.length > 0;
  const canSubmit = canJoin && nameReady && !isLoading;

  const { lookup: presenceTarget, settledLookup } = codeField;
  useEffect(() => {
    if (!settledLookup && !isAdmin) return;
    const refresh = () => onRefreshRooms(isAdmin ? undefined : settledLookup);
    refresh();
    if (!settledLookup) return;
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [settledLookup, isAdmin, onRefreshRooms]);

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
  const presenceCount =
    presenceSettled && codeField.settled ? matchedRoom?.userCount ?? 0 : null;
  const presenceLoading = !presenceSettled || !codeField.settled;

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

  useEffect(() => {
    void refreshDevices();
    const videoId = localStream?.getVideoTracks()[0]?.getSettings().deviceId;
    if (videoId) setSelectedVideoId(videoId);
    const audioId = localStream?.getAudioTracks()[0]?.getSettings().deviceId;
    if (audioId) setSelectedAudioId(audioId);
  }, [localStream, refreshDevices]);

  const handleSelectVideoDevice = (deviceId: string) => {
    markUserMediaChoice();
    setSelectedVideoId(deviceId);
    if (isCameraOn) return capturePreviewDevice("video", "choice", deviceId);
  };

  const handleSelectAudioDevice = (deviceId: string) => {
    markUserMediaChoice();
    setSelectedAudioId(deviceId);
    if (isMicOn) return capturePreviewDevice("audio", "choice", deviceId);
  };

  const inviteLink =
    typeof window !== "undefined" && joinCode
      ? buildMeetingUrl(window.location.origin, codeField.destination)
      : "";
  const linkCopy = useClipboardCopy(inviteLink ?? "");
  const previewHint =
    permissionRequestError ?? (showPermissionHint ? "Permission needed" : null);
  const handleNameInputChange = (nextName: string) => {
    setGuestName(nextName);
    onDisplayNameInputChange(nextName);
  };

  return (
    <div className="relative min-h-screen w-full bg-[#0a0a0b] text-[#fafafa] [&_:is(a,button,input,select,textarea)]:scroll-mt-[calc(env(safe-area-inset-top,0px)+5rem)]">
      <main className="flex min-h-dvh w-full flex-col items-stretch px-0 pt-[calc(env(safe-area-inset-top,0px)+5rem)] sm:items-center sm:justify-center sm:px-4 sm:pb-10 short-screen:pb-4">
        <div className="flex w-full flex-1 flex-col overflow-hidden bg-[#0e0e10] sm:block sm:flex-none sm:max-w-4xl sm:rounded-2xl sm:border sm:border-white/10 md:grid md:min-h-[520px] md:grid-cols-2 short-screen:grid short-screen:min-h-0 short-screen:grid-cols-2">
          <div className="relative flex min-h-[calc(76px+9.25rem)] flex-1 flex-col bg-[#121214] sm:aspect-video sm:h-auto sm:flex-none md:aspect-auto md:min-h-[520px] short-screen:aspect-auto short-screen:min-h-[calc(76px+9.25rem)]">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${isCameraOn ? "" : "hidden"}`}
                />
                <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 flex-col gap-2 p-3 pb-4">
                  <div className="@container flex h-8 shrink-0 items-start justify-between gap-2">
                    {shouldShowPermissionCta ? (
                      <button
                        type="button"
                        onClick={requestMicrophoneAndCamera}
                        disabled={isRequestingPermissions}
                        className="pointer-events-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[#F95F4A] px-3 text-[12.5px] font-medium text-white transition-[background-color,opacity] duration-150 hover:bg-[#e8553f] disabled:cursor-wait disabled:opacity-75"
                      >
                        {isRequestingPermissions ? (
                          <Loader2 size={14} className="shrink-0 animate-spin" />
                        ) : (
                          <Video size={14} className="shrink-0" />
                        )}
                        <span className="whitespace-nowrap">Allow microphone and camera</span>
                      </button>
                    ) : null}
                    <div className="inline-flex h-8 min-w-0 items-center overflow-hidden rounded-full bg-black/55 px-3 text-[12.5px] font-medium backdrop-blur-sm">
                      <span className={`truncate ${tightAudioChip ? "[@container(width<380px)]:sr-only" : ""}`}>
                        {previewName}
                      </span>
                      {isAudioOnly ? (
                        <span
                          className={`ml-1.5 inline-flex shrink-0 items-center gap-1 border-l border-white/20 pl-1.5 text-white/85 ${
                            tightAudioChip
                              ? "[@container(width<380px)]:ml-0 [@container(width<380px)]:border-l-0 [@container(width<380px)]:pl-0"
                              : ""
                          }`}
                        >
                          <Headphones size={13} aria-hidden="true" className="shrink-0" />
                          <span className={tightAudioChip ? "[@container(width<380px)]:sr-only" : undefined}>
                            Audio only
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative min-h-[calc(76px+1.75rem)] flex-1">
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      {setupNotice ? (
                        <div
                          role="status"
                          className="pointer-events-auto flex max-h-full min-h-0 w-full items-start gap-2 overflow-y-auto rounded-xl border border-white/10 bg-[#18181b] px-3.5 py-3 text-left text-[13px] leading-snug text-[#fafafa]"
                        >
                          <Info
                            size={16}
                            className="mt-0.5 shrink-0 text-[#F95F4A]"
                            aria-hidden="true"
                          />
                          <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{setupNotice.message}</p>
                          {onDismissSetupNotice ? (
                            <button
                              type="button"
                              onClick={onDismissSetupNotice}
                              aria-label="Dismiss notice"
                              className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#fafafa]/55 transition-colors hover:bg-white/[0.08] hover:text-[#fafafa]"
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      ) : !isCameraOn ? (
                        <div className="flex flex-col items-center gap-2">
                          <Avatar id={user?.id || previewName} name={previewName} size={76} />
                          <span className="max-w-full truncate text-[13.5px] leading-5 text-[#fafafa]/45">
                            {previewHint ?? "Camera is off"}
                          </span>
                        </div>
                      ) : previewHint ? (
                        <div className="max-w-full truncate rounded-full bg-black/65 px-3 py-1.5 text-center text-[12.5px] font-medium text-white/80 backdrop-blur-sm">
                          {previewHint}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="pointer-events-auto flex shrink-0 items-center justify-center gap-2.5">
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
                      disabled={isAudioOnly}
                      aria-label={
                        isAudioOnly
                          ? "Camera is off in audio-only mode"
                          : isCameraOn
                            ? "Turn off camera"
                            : "Turn on camera"
                      }
                      title={isAudioOnly ? "Camera is off in audio-only mode" : undefined}
                      className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${
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
                    <button
                      type="button"
                      data-testid="prejoin-audio-only"
                      onClick={toggleAudioOnly}
                      aria-pressed={isAudioOnly}
                      aria-label="Audio only: join without video"
                      title="Audio only: join without video"
                      className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 ${
                        isAudioOnly
                          ? "bg-[#F95F4A] hover:bg-[#ff6d5a]"
                          : "bg-[#232327] hover:bg-[#2e2e33]"
                      }`}
                    >
                      <Headphones size={18} />
                    </button>
                  </div>
                </div>
              </div>

          <div className="flex min-h-0 shrink-0 flex-col justify-start gap-3 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:gap-4 sm:p-8 sm:pb-[calc(2rem+env(safe-area-inset-bottom,0px))] md:min-h-[520px] md:justify-center short-screen:min-h-0 short-screen:gap-2.5 short-screen:p-5 short-screen:pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]">
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
                  <label
                    htmlFor={nameInputId}
                    className="block text-[11.5px] font-semibold text-[#fafafa]/40"
                  >
                    Your name
                  </label>
                  <input
                    id={nameInputId}
                    type="text"
                    value={nameInputValue}
                    onChange={(e) => handleNameInputChange(e.target.value)}
                    placeholder="Enter your name"
                    className={FIELD}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <DeviceSelect
                  icon={isCameraOn ? Video : VideoOff}
                  ariaLabel="Camera"
                  value={selectedVideoId}
                  options={isCameraOn ? videoInputs : []}
                  placeholder={
                    isCameraOn
                      ? "Camera"
                      : deviceLabel(videoInputs, selectedVideoId) ?? "Camera off"
                  }
                  onChange={handleSelectVideoDevice}
                />
                <DeviceSelect
                  icon={isMicOn ? Mic : MicOff}
                  ariaLabel="Microphone"
                  value={selectedAudioId}
                  options={isMicOn ? audioInputs : []}
                  placeholder={
                    isMicOn
                      ? "Microphone"
                      : deviceLabel(audioInputs, selectedAudioId) ?? "Mic off"
                  }
                  onChange={handleSelectAudioDevice}
                />
              </div>

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


              <div className="space-y-1.5">
                <div className="flex min-h-[16px] items-center gap-2">
                  <label
                    htmlFor={codeInputId}
                    className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-[#fafafa]/40"
                  >
                    {isRoutedRoom ? "Room" : "Join with a code"}
                  </label>
                  {inviteLink === null ? (
                    <span id={noLinkReasonId} className="ml-auto shrink-0 text-[11.5px] leading-none text-[#fafafa]/55">
                      No shareable link
                    </span>
                  ) : null}
                  {showPresence ? (
                    <RoomPresenceBadge
                      className={inviteLink === null ? "min-w-0" : "ml-auto"}
                      count={presenceCount}
                      loading={presenceLoading}
                    />
                  ) : null}
                </div>
                <div className="relative">
                  <input
                    id={codeInputId}
                    type="text"
                    value={codeField.text}
                    ref={shapeTypedCodeEdits}
                    onChange={(e) => codeField.change(e.target.value)}
                    onBlur={codeField.settle}
                    onPaste={(e) => {
                      if (isRoutedRoom) return;
                      pasteIntoCode(e, e.currentTarget, e.clipboardData.getData("text"));
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || e.nativeEvent.isComposing || !canSubmit) return;
                      const input = e.currentTarget;
                      if (codeField.onThisPage && input.value !== joinCode) {
                        applyFieldEdit(input, { start: 0, end: input.value.length, text: joinCode });
                      }
                      joinMeeting();
                    }}
                    placeholder="Enter a code or link"
                    readOnly={isRoutedRoom}
                    autoFocus={isRoutedRoom}
                    aria-invalid={codeResolution.tooLong || undefined}
                    aria-describedby={
                      codeResolution.tooLong ? codeProblemId : inviteLink === null ? noLinkReasonId : undefined
                    }
                    className={`${FIELD} ${codeResolution.tooLong ? "pr-32" : "pr-12"}`}
                  />
                  {codeResolution.tooLong ? (
                    <span
                      id={codeProblemId}
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-[#141416] px-1.5 text-[12px] text-[#fafafa]/55"
                    >
                      Code too long
                    </span>
                  ) : null}
                  {inviteLink && linkCopy.status === "failed" ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute right-12 top-1/2 -translate-y-1/2 rounded-md bg-[#141416] px-1.5 text-[12px] text-[#fafafa]/55"
                    >
                      Couldn&apos;t copy
                    </span>
                  ) : null}
                  {inviteLink ? (
                    <button
                      type="button"
                      onClick={() => void linkCopy.copy()}
                      aria-label="Copy joining link"
                      title="Copy joining link"
                      className="absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#fafafa]/45 transition-colors duration-150 hover:bg-white/[0.06] hover:text-[#fafafa]/80"
                    >
                      {linkCopy.status === "copied" ? (
                        <Check size={16} aria-hidden="true" className="text-[#fafafa]/80" />
                      ) : (
                        <Link2 size={16} aria-hidden="true" />
                      )}
                    </button>
                  ) : inviteLink === null ? (
                    <button
                      type="button"
                      disabled
                      aria-label="Copy joining link"
                      aria-describedby={noLinkReasonId}
                      className="absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 cursor-not-allowed items-center justify-center rounded-lg text-[#fafafa]/25"
                    >
                      <Link2Off size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                  <span aria-live="polite" className="sr-only">
                    {linkCopy.status === "copied"
                      ? "Link copied"
                      : linkCopy.status === "failed"
                        ? "Couldn't copy link"
                        : ""}
                  </span>
                </div>
                <button
                  onClick={joinMeeting}
                  disabled={!canSubmit}
                  className={CTA_GHOST}
                >
                  Join
                </button>
              </div>

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
          onToggleCamera={isAudioOnly ? undefined : toggleCamera}
          onClose={() => setIsEffectsOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(JoinScreen);
