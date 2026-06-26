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
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  SetStateAction,
  PointerEvent as ReactPointerEvent,
} from "react";
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
import MeetsErrorBanner from "./MeetsErrorBanner";
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
  onDismissMeetError?: () => void;
  onRetryMedia?: () => void;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
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
  displayNameInput,
  onDisplayNameInputChange,
  isGhostMode,
  onGhostModeChange,
  onUserChange,
  onIsAdminChange,
  meetError,
  onDismissMeetError,
  onRetryMedia,
  videoEffects,
  onVideoEffectsChange,
  onPrejoinMediaCommit,
}: JoinScreenProps) {
  const normalizedRoomId =
    roomId === "undefined" || roomId === "null" ? "" : roomId;
  const isRoutedRoom = forceJoinOnly;
  const enforceShortCode = enableRoomRouting || forceJoinOnly;

  const videoRef = useRef<HTMLVideoElement>(null);
  const processedPreviewTrackRef = useRef<MediaStreamTrack | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const handedOffTrackIdsRef = useRef<Set<string>>(new Set());
  const toggleCameraInFlightRef = useRef(false);
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
  const [activeJoinAction, setActiveJoinAction] = useState<"new" | "join" | null>(null);
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

  const requestMicrophoneAndCamera = async () => {
    if (isRequestingPermissions) return;

    setIsRequestingPermissions(true);
    setPermissionRequestError(null);
    try {
      const videoConstraints = getPrejoinVideoConstraints();
      logJoinMedia("get_user_media_full_request", {
        audio: DEFAULT_AUDIO_CONSTRAINTS,
        video: videoConstraints,
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: DEFAULT_AUDIO_CONSTRAINTS,
        video: videoConstraints,
      });
      const liveTracks = stream
        .getTracks()
        .filter((track) => track.readyState === "live");
      const hasAudio = liveTracks.some((track) => track.kind === "audio");
      const hasVideo = liveTracks.some((track) => track.kind === "video");

      stream.getVideoTracks().forEach((track) => {
        if ("contentHint" in track) track.contentHint = "motion";
      });
      localStreamRef.current?.getTracks().forEach((track) => {
        if (!liveTracks.includes(track)) track.stop();
      });
      const nextStream =
        liveTracks.length > 0 ? new MediaStream(liveTracks) : null;
      setLocalStream(nextStream);
      cameraIntentRef.current = hasVideo;
      micIntentRef.current = hasAudio;
      setIsMicOn(hasAudio);
      setIsCameraOn(hasVideo);
      if (hasVideo) {
        prewarmLiveCameraEffects("prejoin-full-media-camera-live");
      }
      logJoinMedia("get_user_media_full_done", {
        stream: getJoinStreamDebugSnapshot(nextStream),
        hasAudio,
        hasVideo,
      });
    } catch (err) {
      warnJoinMedia("get_user_media_full_failed", {
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : err,
      });
      cameraIntentRef.current = false;
      micIntentRef.current = false;
      setPermissionRequestError("Permission needed");
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
      videoRef.current.play().catch((err) => {
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

    toggleCameraInFlightRef.current = true;
    try {
      logJoinMedia("toggle_camera_start", {
        isCameraOn,
        localStream: getJoinStreamDebugSnapshot(localStream),
        videoEffects,
      });
      if (isCameraOn && localStream) {
        cameraIntentRef.current = false;
        const track = localStream.getVideoTracks()[0];
        if (track) {
          logJoinMedia("camera_track_stop", {
            track: getJoinTrackDebugSnapshot(track),
          });
          track.stop();
        }
        const nextTracks = localStream
          .getTracks()
          .filter((candidate) => candidate !== track);
        setLocalStream(nextTracks.length > 0 ? new MediaStream(nextTracks) : null);
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
        });
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
          warnJoinMedia("get_user_media_video_missing_track", {
            stream: getJoinStreamDebugSnapshot(stream),
          });
          return;
        }
        if ("contentHint" in videoTrack) videoTrack.contentHint = "motion";
        if (localStream) {
          const nextStream = new MediaStream([...localStream.getTracks(), videoTrack]);
          logJoinMedia("camera_track_add_to_existing_stream", {
            receivedStream: getJoinStreamDebugSnapshot(stream),
            nextStream: getJoinStreamDebugSnapshot(nextStream),
          });
          setLocalStream(nextStream);
        } else {
          logJoinMedia("camera_stream_set", {
            stream: getJoinStreamDebugSnapshot(stream),
          });
          setLocalStream(stream);
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
    logJoinMedia("toggle_mic_start", {
      isMicOn,
      localStream: getJoinStreamDebugSnapshot(localStream),
    });
    if (isMicOn && localStream) {
      micIntentRef.current = false;
      const track = localStream.getAudioTracks()[0];
      if (track) {
        logJoinMedia("mic_track_stop", {
          track: getJoinTrackDebugSnapshot(track),
        });
        track.stop();
      }
      const nextTracks = localStream
        .getTracks()
        .filter((candidate) => candidate !== track);
      setLocalStream(nextTracks.length > 0 ? new MediaStream(nextTracks) : null);
      setIsMicOn(false);
      logJoinMedia("toggle_mic_off_done", {
        nextTrackCount: nextTracks.length,
      });
      return;
    }
    try {
      logJoinMedia("get_user_media_audio_request", {
        constraints: DEFAULT_AUDIO_CONSTRAINTS,
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: DEFAULT_AUDIO_CONSTRAINTS,
      });
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        warnJoinMedia("get_user_media_audio_missing_track", {
          stream: getJoinStreamDebugSnapshot(stream),
        });
        return;
      }
      if (localStream) {
        const nextStream = new MediaStream([...localStream.getTracks(), audioTrack]);
        logJoinMedia("mic_track_add_to_existing_stream", {
          receivedStream: getJoinStreamDebugSnapshot(stream),
          nextStream: getJoinStreamDebugSnapshot(nextStream),
        });
        setLocalStream(nextStream);
      } else {
        logJoinMedia("mic_stream_set", {
          stream: getJoinStreamDebugSnapshot(stream),
        });
        setLocalStream(stream);
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

  useEffect(() => {
    if (!pending && !isLoading) {
      setActiveJoinAction(null);
    }
  }, [pending, isLoading]);

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
    setActiveJoinAction("new");
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
    setActiveJoinAction("join");
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
  const isStartingMeeting =
    pending?.mode === "new" || (isLoading && activeJoinAction === "new");
  const isJoiningMeeting =
    pending?.mode === "join" || (isLoading && activeJoinAction === "join");
  const handleNameInputChange = (nextName: string) => {
    setGuestName(nextName);
    onDisplayNameInputChange(nextName);
  };

  return (
    <div className="relative min-h-screen w-full bg-[#0a0a0b] text-[#fafafa]">
      <main className="flex min-h-dvh w-full flex-col items-center justify-start px-0 pb-8 pt-32 sm:justify-center sm:px-4 sm:py-10">
        <div className="animate-fade-in w-full overflow-hidden bg-[#0e0e10] sm:max-w-4xl sm:rounded-2xl sm:border sm:border-white/10 md:grid md:min-h-[520px] md:grid-cols-2">
          <div className="relative aspect-[4/3] bg-[#121214] sm:aspect-video md:aspect-auto md:min-h-[520px]">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${isCameraOn ? "" : "hidden"}`}
                />
                {!isCameraOn && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <Avatar id={user?.id || previewName} name={previewName} size={88} />
                    <span className="text-[13.5px] text-[#fafafa]/45">Camera is off</span>
                  </div>
                )}
                {shouldShowPermissionCta ? (
                  <button
                    type="button"
                    onClick={requestMicrophoneAndCamera}
                    disabled={isRequestingPermissions}
                    className="absolute left-3 top-3 z-10 inline-flex min-h-9 max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-[#F95F4A] px-3.5 text-[13px] font-medium text-white transition-[background-color,opacity] duration-150 hover:bg-[#e8553f] disabled:cursor-wait disabled:opacity-75"
                  >
                    {isRequestingPermissions ? (
                      <Loader2 size={16} className="shrink-0 animate-spin" />
                    ) : (
                      <Video size={16} className="shrink-0" />
                    )}
                    <span className="truncate">Allow microphone and camera</span>
                  </button>
                ) : null}
                <div
                  className={`pointer-events-none absolute top-3 rounded-full bg-black/55 px-3 py-1 text-[12.5px] font-medium backdrop-blur-sm ${
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

          <div className="safe-area-pb flex min-h-0 flex-col justify-start gap-4 p-5 sm:p-8 md:min-h-[520px] md:justify-center">
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
              {meetError && (
                <MeetsErrorBanner
                  meetError={meetError}
                  onDismiss={onDismissMeetError ?? (() => {})}
                  variant="inline"
                  primaryActionLabel={
                    onRetryMedia &&
                    (meetError.code === "PERMISSION_DENIED" ||
                      meetError.code === "MEDIA_ERROR")
                      ? "Try again"
                      : undefined
                  }
                  onPrimaryAction={
                    meetError.code === "PERMISSION_DENIED" ||
                    meetError.code === "MEDIA_ERROR"
                      ? onRetryMedia
                      : undefined
                  }
                />
              )}
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

              {!isRoutedRoom && (
                <button
                  onClick={startMeeting}
                  disabled={isLoading || !nameReady}
                  className={CTA_PRIMARY}
                >
                  {isStartingMeeting ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Plus size={18} />
                  )}
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
                    style={{ color: isGhostMode ? "#F95F4A" : "rgba(250,250,250,0.6)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-[#fafafa]">
                      Join as ghost
                    </span>
                    <span className="block truncate text-[12.5px] text-white/60">
                      Others won&apos;t see you join
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-[120ms]"
                    style={{
                      backgroundColor: isGhostMode ? "#F95F4A" : "rgba(250,250,250,0.14)",
                    }}
                  >
                    <span
                      className="absolute h-[16px] w-[16px] rounded-full bg-white transition-transform duration-[120ms]"
                      style={{ transform: isGhostMode ? "translateX(19px)" : "translateX(3px)" }}
                    />
                  </span>
                </button>
              )}

              <div className="space-y-1.5">
                <label className="block text-[11.5px] font-semibold text-[#fafafa]/40">
                  {isRoutedRoom ? "Room" : "Join with a code"}
                </label>
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
                  {isJoiningMeeting ? <Loader2 size={18} className="animate-spin" /> : null}
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
          onToggleCamera={toggleCamera}
          onClose={() => setIsEffectsOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(JoinScreen);
