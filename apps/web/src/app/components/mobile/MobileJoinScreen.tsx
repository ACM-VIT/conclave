"use client";

import {
  AlertCircle,
  ArrowRight,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Trash2,
  Video,
  VideoOff,
  WandSparkles,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { signIn, signOut, useSession } from "@/lib/auth-client";
import type {
  ConnectionState,
  MeetError,
  PrejoinMediaHandoff,
} from "../../lib/types";
import {
  DEFAULT_AUDIO_CONSTRAINTS,
  STANDARD_QUALITY_CONSTRAINTS,
} from "../../lib/constants";
import {
  generateRoomCode,
  ROOM_CODE_MAX_LENGTH,
  extractRoomCode,
  getRoomWordSuggestions,
  sanitizeRoomCodeInput,
  sanitizeRoomCode,
} from "../../lib/utils";
import MeetsErrorBanner from "../MeetsErrorBanner";
import VideoEffectsPanel from "../VideoEffectsPanel";
import AndroidUpsellSheet from "./AndroidUpsellSheet";
import {
  prewarmVideoEffectsAssets,
  useVideoEffects,
} from "../../hooks/useVideoEffects";
import { useCameraPermissionState } from "../../hooks/useCameraPermissionState";
import {
  countActiveVideoEffects,
  type VideoEffectsState,
} from "../../lib/video-effects";

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
  return {
    id,
    email,
    name,
  };
};

interface MobileJoinScreenProps {
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
  onPrejoinMediaCommit?: (handoff: PrejoinMediaHandoff) => void;
  videoEffects: VideoEffectsState;
  onVideoEffectsChange: Dispatch<SetStateAction<VideoEffectsState>>;
}

function MobileJoinScreen({
  roomId,
  onRoomIdChange,
  onJoinRoom,
  isLoading,
  user,
  userEmail,
  connectionState,
  isAdmin,
  enableRoomRouting,
  forceJoinOnly,
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
  onTestSpeaker,
  onPrejoinMediaCommit,
  videoEffects,
  onVideoEffectsChange,
}: MobileJoinScreenProps) {
  const normalizedRoomId =
    roomId === "undefined" || roomId === "null" ? "" : roomId;
  const canJoin = normalizedRoomId.trim().length > 0;
  const videoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const processedPreviewTrackRef = useRef<MediaStreamTrack | null>(null);
  const handedOffTrackIdsRef = useRef<Set<string>>(new Set());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isEffectsOpen, setIsEffectsOpen] = useState(false);
  const isRoutedRoom = forceJoinOnly;
  const enforceShortCode = enableRoomRouting || forceJoinOnly;
  const [activeTab, setActiveTab] = useState<"new" | "join">(() =>
    isRoutedRoom ? "join" : "new"
  );
  const [manualPhase, setManualPhase] = useState<"welcome" | "auth" | "join" | null>(
    null
  );
  const hasUserIdentity = Boolean(user?.id || user?.email);
  const phase = hasUserIdentity ? "join" : (manualPhase ?? "welcome");
  const [guestName, setGuestName] = useState("");
  const [customRoomCode, setCustomRoomCode] = useState("");
  const normalizedSegments = useMemo(
    () => normalizedRoomId.split("-"),
    [normalizedRoomId]
  );
  const currentSegment =
    normalizedSegments[normalizedSegments.length - 1] ?? "";
  const usedSegments = normalizedSegments.slice(0, -1).filter(Boolean);
  const roomSuggestions = useMemo(() => {
    if (!enforceShortCode) return [];
    return getRoomWordSuggestions(currentSegment, usedSegments, 4);
  }, [currentSegment, enforceShortCode, usedSegments]);
  const inlineSuggestion = roomSuggestions[0] ?? "";
  const suggestionSuffix =
    inlineSuggestion &&
      currentSegment &&
      inlineSuggestion.startsWith(currentSegment)
      ? inlineSuggestion.slice(currentSegment.length)
      : "";
  const [signInProvider, setSignInProvider] = useState<
    "google" | "apple" | "roblox" | "vercel" | null
  >(
    null
  );
  const isSigningIn = signInProvider !== null;
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showAndroidUpsell, setShowAndroidUpsell] = useState(false);
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

  const prewarmLiveCameraEffects = useCallback((reason: string) => {
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: true,
      reason,
    });
  }, []);

  const openEffectsPanel = useCallback(() => {
    if (isCameraPermissionBlocked) return;
    void prewarmVideoEffectsAssets({
      segmentation: true,
      face: true,
      reason: "mobile-prejoin-effects-panel-open",
    });
    setIsEffectsOpen(true);
  }, [isCameraPermissionBlocked]);

  const { data: session } = useSession();
  const canSignOut = Boolean(session?.user || user?.id || user?.email);
  const isSignedInUser = Boolean((session?.user || user) && !user?.id?.startsWith("guest-"));
  const lastAppliedSessionUserIdRef = useRef<string | null>(null);

  const [nextParam, setNextParam] = useState<string | null>(null);
  const hasPushedNextRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get("next");
    if (!candidate) return;
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return;
    setNextParam(candidate);
  }, []);
  useEffect(() => {
    if (!nextParam) return;
    if (!session?.user) return;
    if (hasPushedNextRef.current) return;
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
      const sessionUser = {
        id: session.user.id,
        email: session.user.email || "",
        name: session.user.name || session.user.email || "User",
      };
      onUserChange(sessionUser);
      lastAppliedSessionUserIdRef.current = session.user.id;
      return;
    }

    if (user && !isGuestIdentity && !lastAppliedSessionUserIdRef.current) {
      lastAppliedSessionUserIdRef.current = session.user.id;
    }
  }, [session, user, onUserChange]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  const stopUnhandedOffTracks = useCallback((stream: MediaStream | null) => {
    const handedOffTrackIds = handedOffTrackIdsRef.current;
    stream?.getTracks().forEach((track) => {
      if (handedOffTrackIds.has(track.id)) return;
      track.stop();
    });
  }, []);

  useEffect(() => {
    if (phase !== "join" && localStream) {
      stopUnhandedOffTracks(localStream);
      setLocalStream(null);
    }

    return () => {
      stopUnhandedOffTracks(localStream);
    };
  }, [localStream, phase, stopUnhandedOffTracks]);

  useEffect(() => {
    if (!user?.id?.startsWith("guest-")) return;
    if (guestName.trim().length > 0) return;
    const nextName = normalizeGuestName(user.name || "");
    if (!nextName) return;
    setGuestName(nextName);
  }, [guestName, user]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!previewStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== previewStream) {
      video.srcObject = previewStream;
    }
    video.play().catch(() => {});

    return () => {
      if (video.srcObject === previewStream) {
        video.srcObject = null;
      }
    };
  }, [previewStream]);

  const toggleCamera = async () => {
    if (isCameraOn && localStream) {
      const track = localStream.getVideoTracks()[0];
      if (track) {
        track.stop();
      }
      const nextTracks = localStream
        .getTracks()
        .filter((candidate) => candidate !== track);
      setLocalStream(nextTracks.length > 0 ? new MediaStream(nextTracks) : null);
      setIsCameraOn(false);
    } else {
      await navigator.mediaDevices
        .getUserMedia({
          video: STANDARD_QUALITY_CONSTRAINTS,
        })
        .then((stream) => {
          const videoTrack = stream.getVideoTracks()[0];
          if (!videoTrack) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          if ("contentHint" in videoTrack) {
            videoTrack.contentHint = "motion";
          }
          const currentTracks = localStream?.getTracks() ?? [];
          const nextStream =
            currentTracks.length > 0
              ? new MediaStream([...currentTracks, videoTrack])
              : stream;
          setLocalStream(nextStream);
          prewarmLiveCameraEffects("mobile-prejoin-camera-toggle-live");
          setIsCameraOn(true);
        })
        .catch(() => {
          console.log("[MobileJoinScreen] Camera access denied");
        });
    }
  };

  const toggleMic = async () => {
    if (isMicOn && localStream) {
      const track = localStream.getAudioTracks()[0];
      if (track) {
        track.stop();
      }
      const nextTracks = localStream
        .getTracks()
        .filter((candidate) => candidate !== track);
      setLocalStream(nextTracks.length > 0 ? new MediaStream(nextTracks) : null);
      setIsMicOn(false);
    } else {
      await navigator.mediaDevices
        .getUserMedia({
          audio: DEFAULT_AUDIO_CONSTRAINTS,
        })
        .then((stream) => {
          const audioTrack = stream.getAudioTracks()[0];
          if (!audioTrack) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          const currentTracks = localStream?.getTracks() ?? [];
          const nextStream =
            currentTracks.length > 0
              ? new MediaStream([...currentTracks, audioTrack])
              : stream;
          setLocalStream(nextStream);
          setIsMicOn(true);
        })
        .catch(() => {
          console.log("[MobileJoinScreen] Microphone access denied");
        });
    }
  };

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
    onPrejoinMediaCommit({
      stream: handoffStream,
      isCameraOn: isCameraOn && hasLiveVideo,
      isMicOn: isMicOn && hasLiveAudio,
    });
  };

  const handleCreateRoom = () => {
    onIsAdminChange(true);
    const sanitizedCustomCode = sanitizeRoomCode(customRoomCode);
    const id =
      sanitizedCustomCode.length >= 3 ? sanitizedCustomCode : generateRoomCode();
    if (enableRoomRouting && typeof window !== "undefined") {
      window.history.pushState(null, "", `/${id}`);
    }
    commitPrejoinMedia();
    onRoomIdChange(id);
    onJoinRoom(id);
  };

  const handleSocialSignIn = async (
    provider: "google" | "apple" | "roblox" | "vercel"
  ) => {
    setSignInProvider(provider);
    await signIn
      .social({
        provider,
        callbackURL: window.location.href,
      })
      .catch((error) => {
        console.error("Sign in error:", error);
      });
    setSignInProvider(null);
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    const clearGuestStorage = () => {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(GUEST_USER_STORAGE_KEY);
    };

    if (!session?.user) {
      clearGuestStorage();
      onUserChange(null);
      onIsAdminChange(false);
      setManualPhase("welcome");
      setIsSigningOut(false);
      return;
    }

    await signOut()
      .then(() => {
        clearGuestStorage();
        onUserChange(null);
        onIsAdminChange(false);
        setManualPhase("welcome");
      })
      .catch((error) => {
        console.error("Sign out error:", error);
      });
    setIsSigningOut(false);
  };

  const handleOpenDeleteAccount = () => {
    if (typeof window === "undefined") return;
    window.open("/delete-account", "_blank", "noopener,noreferrer");
  };

  const handleGuest = () => {
    const normalizedGuestName = normalizeGuestName(guestName);
    if (!normalizedGuestName) return;
    const guestUser = buildGuestUser(normalizedGuestName, user);
    onUserChange(guestUser);
    onIsAdminChange(false);
    setGuestName(normalizedGuestName);
    setManualPhase("join");
  };

  const handleJoin = () => {
    const candidate = enforceShortCode
      ? sanitizeRoomCode(normalizedRoomId)
      : normalizedRoomId.trim();
    if (!candidate) return;
    if (candidate !== normalizedRoomId) {
      onRoomIdChange(candidate);
    }
    commitPrejoinMedia();
    onJoinRoom(candidate);
  };

  const applySuggestion = (word: string) => {
    const nextSegments = [...normalizedSegments];
    nextSegments[nextSegments.length - 1] = word;
    onRoomIdChange(nextSegments.join("-"));
  };

  useEffect(() => {
    if (phase !== "join") return;
    onIsAdminChange(activeTab === "new");
  }, [activeTab, onIsAdminChange, phase]);

  useEffect(() => {
    if (!isRoutedRoom) return;
    onIsAdminChange(false);
  }, [isRoutedRoom, onIsAdminChange]);

  useEffect(() => {
    if (typeof navigator === "undefined" || typeof window === "undefined") return;
    const isAndroid = /android/i.test(navigator.userAgent);
    const dismissed = window.localStorage.getItem("conclave_android_upsell_dismissed");
    if (isAndroid && !dismissed) {
      setShowAndroidUpsell(true);
    }
  }, []);

  const dismissAndroidUpsell = () => {
    setShowAndroidUpsell(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("conclave_android_upsell_dismissed", "1");
    }
  };

  if (phase === "welcome") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 bg-[#0a0a0b] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <div className="relative z-10 text-center mb-8">
          <div
            className="text-xl text-[#fafafa]/56 mb-2"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            welcome to
          </div>
          <div className="relative inline-block">
            <span
              className="absolute -left-8 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-3xl"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              [
            </span>
            <h1
              className="text-5xl text-[#fafafa]"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              c0nclav3
            </h1>
            <span
              className="absolute -right-8 top-1/2 -translate-y-1/2 text-[#F95F4A]/40 text-3xl"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              ]
            </span>
          </div>
        </div>
        <p
          className="relative z-10 text-sm text-[#fafafa]/30 mb-10 text-center max-w-[320px]"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          Video conferencing for meetings, webinars, and collaboration
        </p>

        <button
          onClick={() => setManualPhase("auth")}
          className="relative z-10 group flex items-center gap-3 rounded-full bg-[#F95F4A] px-8 py-3 text-sm font-medium text-white transition-colors active:scale-95 hover:bg-[#e8553f]"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          <span>Let's go</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (phase === "auth") {
    return (
      <div className="flex-1 flex flex-col px-6 py-8 bg-[#0a0a0b] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <button
          onClick={() => setManualPhase("welcome")}
          className="relative z-10 mb-8 self-start mobile-glass-soft mobile-pill px-3 py-1 text-[12px] font-medium text-[#fafafa]/75"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          Back
        </button>

        <div className="relative z-10 flex-1 flex flex-col justify-center">
          <h2
            className="text-2xl text-[#fafafa] mb-2 text-center"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            Join
          </h2>
          <p
            className="text-sm text-[#fafafa]/56 text-center mb-8"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            Choose how to continue
          </p>

          <div className="grid gap-3 mb-4">
            <button
              onClick={() => handleSocialSignIn("google")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#fafafa] hover:border-[#fafafa]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "google" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#fafafa]" />
              ) : (
                <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
              )}
              <span className="text-[13px] leading-none whitespace-nowrap" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Google
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("apple")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#fafafa] hover:border-[#fafafa]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "apple" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#fafafa]" />
              ) : (
                <img
                  src="/assets/apple-50.png"
                  alt=""
                  aria-hidden="true"
                  className="w-5 h-5 shrink-0 object-contain"
                />
              )}
              <span className="text-[13px] leading-none whitespace-nowrap" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Apple
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("roblox")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#fafafa] hover:border-[#fafafa]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "roblox" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#fafafa]" />
              ) : (
                <img
                  src="/roblox-logo.png"
                  alt=""
                  aria-hidden="true"
                  className="w-5 h-5 shrink-0 object-contain invert"
                />
              )}
              <span className="text-[13px] leading-none whitespace-nowrap" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Roblox
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("vercel")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#fafafa] hover:border-[#fafafa]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "vercel" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#fafafa]" />
              ) : (
                <svg
                  className="w-5 h-5 shrink-0"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path fill="#fff" d="M12 4l8 14H4z" />
                </svg>
              )}
              <span className="text-[13px] leading-none whitespace-nowrap" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Vercel
              </span>
            </button>
          </div>

          <div className="flex items-center gap-4 my-6">
            <div className="flex-1 h-px bg-[#fafafa]/10" />
            <span
              className="text-[12px] font-medium text-[#fafafa]/40"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              or
            </span>
            <div className="flex-1 h-px bg-[#fafafa]/10" />
          </div>

          <input
            type="text"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Enter your name"
            className="w-full px-4 py-2.5 mobile-glass mobile-pill text-sm text-[#fafafa] placeholder:text-[#fafafa]/25 focus:border-[#F95F4A]/50 focus:outline-none mb-3"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && guestName.trim()) handleGuest();
            }}
          />
          <button
            onClick={handleGuest}
            disabled={!guestName.trim()}
            className="w-full px-4 py-3 bg-[#F95F4A] text-white text-sm rounded-full hover:bg-[#e8553f] transition-colors disabled:opacity-30"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            Continue as Guest
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#0a0a0b] safe-area-pt overflow-hidden relative">
      <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      <div className="relative flex-1 px-4 pt-3 pb-36 flex flex-col min-h-0">
        <div className="relative flex-1 rounded-[28px] border border-[#fafafa]/10 bg-[#131316] overflow-hidden">
          {isCameraOn && previewStream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover scale-x-[-1]"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
              <div className="absolute inset-0 bg-[rgba(249,95,74,0.15)]" />
              <div className="relative w-20 h-20 rounded-full mobile-avatar flex items-center justify-center">
                <span
                  className="text-4xl text-[#fafafa] font-bold"
                  style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                >
                  {userEmail[0]?.toUpperCase() || "?"}
                </span>
              </div>
            </div>
          )}

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 mobile-glass mobile-pill px-2.5 py-2 flex items-center gap-2">
            <button
              onClick={toggleMic}
              aria-label={isMicOn ? "Turn off microphone" : "Turn on microphone"}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isMicOn
                  ? "text-white"
                  : "bg-[#ea4335] text-white"
              }`}
            >
              {isMicOn ? (
                <Mic className="w-[18px] h-[18px]" />
              ) : (
                <MicOff className="w-[18px] h-[18px]" />
              )}
            </button>
            <button
              onClick={toggleCamera}
              aria-label={isCameraOn ? "Turn off camera" : "Turn on camera"}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isCameraOn
                  ? "text-white"
                  : "bg-[#ea4335] text-white"
              }`}
            >
              {isCameraOn ? (
                <Video className="w-[18px] h-[18px]" />
              ) : (
                <VideoOff className="w-[18px] h-[18px]" />
              )}
            </button>
            <button
              onClick={openEffectsPanel}
              disabled={isCameraPermissionBlocked}
              aria-label={
                isCameraPermissionBlocked
                  ? "Backgrounds and effects: Permission needed"
                  : "Backgrounds and effects"
              }
              aria-pressed={
                !isCameraPermissionBlocked &&
                (activeVideoEffectsCount > 0 || isEffectsOpen)
              }
              title={
                isCameraPermissionBlocked
                  ? "Permission needed"
                  : "Backgrounds and effects"
              }
              className={`relative w-9 h-9 rounded-full flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                !isCameraPermissionBlocked &&
                (activeVideoEffectsCount > 0 || isEffectsOpen)
                  ? "bg-[#F95F4A] text-white"
                  : "text-white"
              }`}
            >
              <WandSparkles className="w-[18px] h-[18px]" />
              {!isCameraPermissionBlocked && activeVideoEffectsCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-semibold text-[#F95F4A]">
                  {activeVideoEffectsCount}
                </span>
              ) : null}
            </button>
          </div>

          <div className="absolute top-4 left-4 right-4 flex items-start justify-between gap-3">
            <div
              className="min-w-0 max-w-[65%] h-8 px-3 flex items-center mobile-glass mobile-pill text-xs text-[#fafafa]/80 truncate"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              {userEmail}
            </div>
            <div className="flex items-center gap-2">
              {isSignedInUser && (
                <button
                  type="button"
                  onClick={handleOpenDeleteAccount}
                  className="shrink-0 h-8 w-8 flex items-center justify-center mobile-glass mobile-pill text-[#F95F4A]"
                  aria-label="Delete account"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              {canSignOut && (
                <button
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                  className="shrink-0 h-8 px-3 flex items-center mobile-glass mobile-pill text-xs text-[#fafafa]/80 disabled:opacity-50"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                >
                  {isSigningOut ? "Signing out..." : "Sign out"}
                </button>
              )}
            </div>
          </div>

          {showPermissionHint && (
            <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 mobile-glass-soft rounded-full text-xs text-[#fafafa]/82">
              <AlertCircle className="w-3.5 h-3.5 text-[#F95F4A]" />
              Allow access
            </div>
          )}
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 pb-[calc(12px+env(safe-area-inset-bottom))]">
        <div className="flex flex-col gap-3">
          <div className="flex mobile-glass mobile-pill p-1">
            <button
              onClick={() => {
                setActiveTab("new");
                onIsAdminChange(true);
              }}
              className={`flex-1 rounded-full py-2.5 text-sm font-medium transition-colors ${
                activeTab === "new"
                  ? "bg-[#F95F4A] text-white"
                  : "text-[#fafafa]/66"
              }`}
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
              disabled={isRoutedRoom}
              aria-disabled={isRoutedRoom}
            >
              New Meeting
            </button>
            <button
              onClick={() => {
                setActiveTab("join");
                onIsAdminChange(false);
              }}
              className={`flex-1 rounded-full py-2.5 text-sm font-medium transition-colors ${
                activeTab === "join"
                  ? "bg-[#F95F4A] text-white"
                  : "text-[#fafafa]/66"
              } ${isRoutedRoom ? "opacity-60" : ""}`}
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              Join
            </button>
          </div>

          <div className="mobile-glass-soft mobile-pill p-1 h-[52px]">
            {activeTab === "join" || isRoutedRoom ? (
              <div className="flex items-center gap-2 h-full px-2">
                <div className="relative flex-1 h-full">
                  {suggestionSuffix && (
                    <div
                      className="pointer-events-none absolute inset-0 px-2 flex items-center text-sm text-[#fafafa]/30 truncate"
                      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                    >
                      <span className="text-transparent">{normalizedRoomId}</span>
                      <span>{suggestionSuffix}</span>
                    </div>
                  )}
                  <input
                    type="text"
                    value={normalizedRoomId}
                    onChange={(e) =>
                      onRoomIdChange(
                        enforceShortCode
                          ? sanitizeRoomCodeInput(e.target.value)
                          : e.target.value
                      )
                    }
                    placeholder="Paste room link or code"
                    maxLength={enforceShortCode ? ROOM_CODE_MAX_LENGTH : undefined}
                    disabled={isLoading}
                    readOnly={isRoutedRoom}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="relative w-full h-full bg-transparent px-2 text-sm text-[#fafafa] placeholder:text-[#fafafa]/30 focus:outline-none"
                    style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canJoin) handleJoin();
                      if (e.key === "Tab" && suggestionSuffix) {
                        e.preventDefault();
                        applySuggestion(inlineSuggestion);
                      }
                    }}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData("text");
                      if (!text) return;
                      const extracted = extractRoomCode(text);
                      if (extracted) {
                        event.preventDefault();
                        onRoomIdChange(extracted);
                      }
                    }}
                  />
                </div>
                <button
                  onClick={handleJoin}
                  disabled={!canJoin || isLoading}
                  className="w-9 h-9 rounded-full bg-[#F95F4A] text-white flex items-center justify-center disabled:opacity-40 transition-colors"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ArrowRight className="w-4 h-4" />
                  )}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 h-full px-2">
                <input
                  type="text"
                  value={customRoomCode}
                  onChange={(e) =>
                    setCustomRoomCode(sanitizeRoomCodeInput(e.target.value))
                  }
                  placeholder="custom code or leave blank"
                  maxLength={ROOM_CODE_MAX_LENGTH}
                  disabled={isLoading}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="relative flex-1 h-full bg-transparent px-2 text-sm text-[#fafafa] placeholder:text-[#fafafa]/30 focus:outline-none"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isLoading) handleCreateRoom();
                  }}
                />
                <button
                  onClick={handleCreateRoom}
                  disabled={isLoading}
                  className="h-9 px-4 rounded-full bg-[#F95F4A] text-white flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  <span
                    className="text-sm font-medium"
                    style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                  >
                    Start
                  </span>
                </button>
              </div>
            )}
          </div>

        {meetError && onDismissMeetError && (
          <div className="mt-4">
            <MeetsErrorBanner
              meetError={meetError}
              onDismiss={onDismissMeetError}
              primaryActionLabel={
                meetError.code === "PERMISSION_DENIED"
                  ? "Retry Permissions"
                  : meetError.code === "MEDIA_ERROR"
                    ? "Retry Devices"
                    : undefined
              }
              onPrimaryAction={
                meetError.code === "PERMISSION_DENIED" ||
                  meetError.code === "MEDIA_ERROR"
                  ? onRetryMedia
                  : undefined
              }
            />
          </div>
        )}
        </div>
      </div>

      <AndroidUpsellSheet
        isOpen={showAndroidUpsell}
        onClose={dismissAndroidUpsell}
      />

      {isLoading && (
        <div className="absolute inset-0 bg-[#131316]/80 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-[#F95F4A] animate-spin" />
            <span className="text-sm text-[#fafafa]/75">
              {connectionState === "reconnecting" ? "Reconnecting..." : "Joining..."}
            </span>
          </div>
        </div>
      )}

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

export default memo(MobileJoinScreen);
