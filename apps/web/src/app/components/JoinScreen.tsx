"use client";

import {
  CircleHelp,
  Loader2,
  MessageSquareWarning,
  MoreVertical,
  Settings,
  Sparkles,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Plus,
  ArrowRight,
  Volume2,
  Ghost,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { signIn, signOut, useSession } from "@/lib/auth-client";
import type { RoomInfo } from "@/lib/sfu-types";
import type {
  ConnectionState,
  MeetError,
  PrejoinMediaHandoff,
} from "../lib/types";
import {
  DEFAULT_AUDIO_CONSTRAINTS,
  STANDARD_QUALITY_CONSTRAINTS,
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
import VideoEffectsPanel from "./VideoEffectsPanel";
import {
  prewarmVideoEffectsAssets,
  useVideoEffects,
} from "../hooks/useVideoEffects";
import { useCameraPermissionState } from "../hooks/useCameraPermissionState";
import {
  countActiveVideoEffects,
  type VideoEffectsState,
} from "../lib/video-effects";

const normalizeGuestName = (value: string): string =>
  value.trim().replace(/\s+/g, " ");
const GUEST_USER_STORAGE_KEY = "conclave:guest-user";

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
  onTestSpeaker?: () => void;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
}

// Flat, Google-Meet-style lobby (dark Carbon, no gradients/marketing): a single
// screen with the mic/cam self-preview on the left and the join actions on the
// right. The whole 3-phase welcome/auth/join flow was ripped out for this.
const FIELD =
  "w-full rounded-xl border border-white/12 bg-[#131316] px-4 h-12 text-[15px] text-[#fafafa] placeholder:text-[#fafafa]/35 transition-[border-color] duration-150 focus:border-[#F95F4A] focus:outline-none disabled:opacity-50";
const CTA_PRIMARY =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#F95F4A] text-[15px] font-medium text-white transition-[filter] duration-150 hover:brightness-105 disabled:bg-[#232327] disabled:text-[#fafafa]/40 disabled:cursor-not-allowed";
const CTA_GHOST =
  "inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-[#18181b] text-[15px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-[#232327] disabled:opacity-50";
const PROVIDER_BTN =
  "inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-white/10 bg-[#18181b] text-[14px] font-medium text-[#fafafa] transition-colors duration-150 hover:bg-[#232327] disabled:opacity-50";

const isGoogleSignInEnabled =
  process.env.NEXT_PUBLIC_GOOGLE_SIGN_IN_ENABLED === "true";
const DEBUG_VIDEO_EFFECTS_STORAGE_KEY = "conclave:debug-video-effects";

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
  isGhostMode,
  onGhostModeChange,
  onUserChange,
  onIsAdminChange,
  meetError,
  onDismissMeetError,
  onRetryMedia,
  onTestSpeaker,
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
  const moreOptionsRef = useRef<HTMLDivElement>(null);
  const toggleCameraInFlightRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isRequestingPermissions, setIsRequestingPermissions] = useState(false);
  const [permissionRequestError, setPermissionRequestError] = useState<
    string | null
  >(null);
  const [isEffectsOpen, setIsEffectsOpen] = useState(false);
  const [isMoreOptionsOpen, setIsMoreOptionsOpen] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [signInProvider, setSignInProvider] = useState<
    "google" | "apple" | null
  >(null);
  const isSigningIn = signInProvider !== null;
  const [isSigningOut, setIsSigningOut] = useState(false);
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

  const previewName =
    normalizeGuestName(user?.name || "") ||
    normalizeGuestName(guestName || "") ||
    (userEmail ? userEmail.split("@")[0] : "") ||
    "You";
  const {
    effectiveStream: processedPreviewStream,
    status: videoEffectsStatus,
    error: videoEffectsError,
    debugStats: videoEffectsDebugStats,
  } = useVideoEffects({
    sourceStream: localStream,
    effects: videoEffects,
    processedVideoTrackRef: processedPreviewTrackRef,
  });
  const previewStream = processedPreviewStream ?? localStream;
  const activeVideoEffectsCount = countActiveVideoEffects(videoEffects);
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
  const isBackgroundBlurActive =
    videoEffects.background === "blur-light" ||
    videoEffects.background === "blur-strong";
  const prewarmBackgroundBlur = () => {
    if (isCameraPermissionBlocked) return;
    void prewarmVideoEffectsAssets({
      segmentation: true,
      reason: "prejoin-quick-blur",
    });
  };
  const prewarmLiveCameraEffects = (reason: string) => {
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: true,
      reason,
    });
  };
  const toggleBackgroundBlur = () => {
    if (isCameraPermissionBlocked) return;
    const nextBackground = isBackgroundBlurActive ? "none" : "blur-strong";
    if (nextBackground !== "none") {
      void prewarmVideoEffectsAssets({
        segmentation: true,
        reason: "prejoin-quick-blur:select",
      });
    }
    onVideoEffectsChange((current) => ({
      ...current,
      background: nextBackground,
    }));
  };
  const openEffectsPanel = () => {
    setIsMoreOptionsOpen(false);
    setIsEffectsOpen(true);
  };

  const requestMicrophoneAndCamera = async () => {
    if (isRequestingPermissions) return;

    setIsRequestingPermissions(true);
    setPermissionRequestError(null);
    try {
      logJoinMedia("get_user_media_full_request", {
        audio: DEFAULT_AUDIO_CONSTRAINTS,
        video: STANDARD_QUALITY_CONSTRAINTS,
      });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: DEFAULT_AUDIO_CONSTRAINTS,
        video: STANDARD_QUALITY_CONSTRAINTS,
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
    if (nextName) setGuestName(nextName);
  }, [guestName, user]);

  useEffect(() => {
    localStreamRef.current = localStream;
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
    if (!isMoreOptionsOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (
        moreOptionsRef.current &&
        !moreOptionsRef.current.contains(event.target as Node)
      ) {
        setIsMoreOptionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isMoreOptionsOpen]);
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
    const liveTracks =
      stream
        ?.getTracks()
        .filter((track) => {
          if (track.readyState !== "live") return false;
          if (track.kind === "video") return isCameraOn;
          if (track.kind === "audio") return isMicOn;
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
      isCameraOn,
      isMicOn,
    });
    onPrejoinMediaCommit({
      stream: handoffStream,
      isCameraOn: isCameraOn && hasLiveVideo,
      isMicOn: isMicOn && hasLiveAudio,
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
        logJoinMedia("get_user_media_video_request", {
          constraints: STANDARD_QUALITY_CONSTRAINTS,
        });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: STANDARD_QUALITY_CONSTRAINTS,
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
    if (hasIdentity) return true;
    const name = normalizeGuestName(guestName);
    if (!name) return false;
    onUserChange(buildGuestUser(name, user));
    return true;
  };

  const startMeeting = () => {
    if (!ensureGuest()) return;
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
    commitPrejoinMedia();
    onIsAdminChange(false);
    setPending({ mode: "join", roomId: candidate });
  };

  const handleSocialSignIn = async (provider: "google" | "apple") => {
    setSignInProvider(provider);
    try {
      await signIn.social({ provider, callbackURL: window.location.href });
    } catch (error) {
      console.error("Sign in error:", error);
    } finally {
      setSignInProvider(null);
    }
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
  const nameReady = hasIdentity || normalizeGuestName(guestName).length > 0;

  return (
    <div className="relative min-h-screen w-full bg-[#0a0a0b] text-[#fafafa] flex flex-col">
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="grid w-full max-w-5xl items-stretch gap-6 md:grid-cols-[1.5fr_1fr]">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-[#121214]">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className={`h-full w-full -scale-x-100 object-cover ${isCameraOn ? "" : "hidden"}`}
            />
            {!isCameraOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Avatar id={user?.id || previewName} name={previewName} size={88} />
                <span className="text-[14px] text-[#fafafa]/50">Camera is off</span>
              </div>
            )}
            {shouldShowPermissionCta ? (
              <button
                type="button"
                onClick={requestMicrophoneAndCamera}
                disabled={isRequestingPermissions}
                className="absolute left-3 top-3 z-10 inline-flex min-h-9 max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-[#1a73e8] px-3.5 text-[13px] font-medium text-white shadow-lg shadow-black/20 transition-[background-color,opacity] duration-150 hover:bg-[#1967d2] disabled:cursor-wait disabled:opacity-75"
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
              className={`pointer-events-none absolute top-3 rounded-md bg-black/55 px-2.5 py-1 text-[13px] font-medium ${
                shouldShowPermissionCta ? "right-3" : "left-3"
              }`}
            >
              {previewName}
            </div>
            {(showPermissionHint || permissionRequestError) && (
              <div className="pointer-events-none absolute bottom-[72px] left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full bg-black/65 px-3 py-1.5 text-center text-[12.5px] font-medium text-white/80">
                {permissionRequestError ?? "Permission needed"}
              </div>
            )}
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3">
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
                onClick={toggleBackgroundBlur}
                onFocus={prewarmBackgroundBlur}
                onPointerEnter={prewarmBackgroundBlur}
                onTouchStart={prewarmBackgroundBlur}
                disabled={isCameraPermissionBlocked}
                aria-label={
                  isBackgroundBlurActive
                    ? "Turn off background blur"
                    : "Turn on background blur"
                }
                aria-pressed={isBackgroundBlurActive}
                className={`inline-flex h-11 w-11 items-center justify-center rounded-full text-white transition-colors duration-150 hover:bg-[#2e2e33] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#232327] ${
                  isBackgroundBlurActive ? "bg-[#1a73e8]" : "bg-[#232327]"
                }`}
              >
                <Sparkles size={18} />
              </button>
              <div ref={moreOptionsRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsMoreOptionsOpen((current) => !current)}
                  aria-label="More options"
                  aria-expanded={isMoreOptionsOpen}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[#232327] text-white transition-colors duration-150 hover:bg-[#2e2e33]"
                >
                  <MoreVertical size={18} />
                </button>
                {isMoreOptionsOpen ? (
                  <div
                    data-testid="prejoin-more-options-menu"
                    className="absolute bottom-full right-0 z-30 mb-3 w-[260px] overflow-hidden rounded-xl border border-white/10 bg-[#242428] py-2 text-left shadow-2xl shadow-black/35"
                  >
                    <button
                      type="button"
                      data-testid="prejoin-more-backgrounds-effects"
                      onClick={openEffectsPanel}
                      aria-label="Backgrounds and effects"
                      className="flex w-full items-center gap-3 px-4 py-3 text-left text-[14px] text-[#f1f3f4] transition-colors duration-150 hover:bg-white/10 disabled:cursor-not-allowed disabled:text-[#f1f3f4]/45 disabled:hover:bg-transparent"
                    >
                      <Sparkles
                        size={18}
                        className="shrink-0 text-[#bdc1c6]"
                      />
                      <span className="min-w-0">
                        <span className="block truncate">
                          Backgrounds and effects
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsMoreOptionsOpen(false)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-[14px] text-[#f1f3f4] transition-colors duration-150 hover:bg-white/10"
                    >
                      <MessageSquareWarning size={18} className="shrink-0 text-[#bdc1c6]" />
                      <span className="truncate">Report a problem</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsMoreOptionsOpen(false)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-[14px] text-[#f1f3f4] transition-colors duration-150 hover:bg-white/10"
                    >
                      <CircleHelp size={18} className="shrink-0 text-[#bdc1c6]" />
                      <span className="truncate">Troubleshooting &amp; help</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsMoreOptionsOpen(false)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-[14px] text-[#f1f3f4] transition-colors duration-150 hover:bg-white/10"
                    >
                      <Settings size={18} className="shrink-0 text-[#bdc1c6]" />
                      <span className="truncate">Settings</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {onTestSpeaker && (
              <button
                onClick={onTestSpeaker}
                className="absolute bottom-4 right-4 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-[12px] text-[#fafafa]/70 hover:text-[#fafafa] transition-colors"
              >
                <Volume2 size={14} /> Test speaker
              </button>
            )}
          </div>

          <div className="flex flex-col justify-center gap-4">
            {meetError && (
              <MeetsErrorBanner
                meetError={meetError}
                onDismiss={onDismissMeetError ?? (() => {})}
              />
            )}

            {isSignedInUser ? (
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#18181b] px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{previewName}</p>
                  {userEmail && (
                    <p className="truncate text-[12px] text-[#fafafa]/45">{userEmail}</p>
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
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-[#fafafa]/55">Your name</label>
                <input
                  type="text"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
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
                {isLoading ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                New meeting
              </button>
            )}

            {allowGhostMode && (
              <button
                type="button"
                onClick={() => onGhostModeChange(!isGhostMode)}
                aria-pressed={isGhostMode}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-[#18181b] px-4 py-3 text-left transition-colors duration-150 hover:bg-[#232327]"
              >
                <Ghost
                  size={18}
                  style={{ color: isGhostMode ? "#F95F4A" : "rgba(250,250,250,0.6)" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-[#fafafa]">
                    Join as ghost
                  </span>
                  <span className="block truncate text-[12.5px] text-white/45">
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

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-[#fafafa]/55">
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
                {isLoading ? <Loader2 size={18} className="animate-spin" /> : null}
                Join
                <ArrowRight size={18} />
              </button>
            </div>

            {!isSignedInUser && isGoogleSignInEnabled && (
              <>
                <div className="flex items-center gap-3 py-1">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-[12px] text-[#fafafa]/40">or</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
                <button
                  onClick={() => handleSocialSignIn("google")}
                  disabled={isSigningIn}
                  className={PROVIDER_BTN}
                >
                  {signInProvider === "google" ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null}
                  Continue with Google
                </button>
              </>
            )}
          </div>
        </div>
      </main>
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
          cameraPermissionBlocked={isCameraPermissionBlocked}
          showFilters={!isCameraPermissionBlocked}
          onClose={() => setIsEffectsOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(JoinScreen);
