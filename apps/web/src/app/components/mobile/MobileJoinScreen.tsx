"use client";

import {
  AlertCircle,
  ArrowRight,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Video,
  VideoOff,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "@/lib/auth-client";
import type { ConnectionState, MeetError } from "../../lib/types";
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
}: MobileJoinScreenProps) {
  const normalizedRoomId =
    roomId === "undefined" || roomId === "null" ? "" : roomId;
  const canJoin = normalizedRoomId.trim().length > 0;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
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

  const { data: session } = useSession();
  const canSignOut = Boolean(session?.user || user?.id || user?.email);
  const lastAppliedSessionUserIdRef = useRef<string | null>(null);

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
    if (phase !== "join" && localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      setLocalStream(null);
    }

    return () => {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [localStream, phase]);

  useEffect(() => {
    if (!user?.id?.startsWith("guest-")) return;
    if (guestName.trim().length > 0) return;
    const nextName = normalizeGuestName(user.name || "");
    if (!nextName) return;
    setGuestName(nextName);
  }, [guestName, user]);

  useEffect(() => {
    if (videoRef.current && localStream) videoRef.current.srcObject = localStream;
  }, [localStream]);

  const toggleCamera = async () => {
    if (isCameraOn && localStream) {
      const track = localStream.getVideoTracks()[0];
      if (track) {
        track.stop();
        localStream.removeTrack(track);
      }
      setIsCameraOn(false);
    } else {
      await navigator.mediaDevices
        .getUserMedia({
          video: STANDARD_QUALITY_CONSTRAINTS,
        })
        .then((stream) => {
          const videoTrack = stream.getVideoTracks()[0];
          if (!videoTrack) return;
          if ("contentHint" in videoTrack) {
            videoTrack.contentHint = "motion";
          }
          if (localStream) {
            localStream.addTrack(videoTrack);
          } else {
            setLocalStream(stream);
          }
          if (videoRef.current) {
            videoRef.current.srcObject = localStream || stream;
          }
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
        localStream.removeTrack(track);
      }
      setIsMicOn(false);
    } else {
      await navigator.mediaDevices
        .getUserMedia({
          audio: DEFAULT_AUDIO_CONSTRAINTS,
        })
        .then((stream) => {
          const audioTrack = stream.getAudioTracks()[0];
          if (!audioTrack) return;
          if (localStream) {
            localStream.addTrack(audioTrack);
          } else {
            setLocalStream(stream);
          }
          setIsMicOn(true);
        })
        .catch(() => {
          console.log("[MobileJoinScreen] Microphone access denied");
        });
    }
  };

  const handleCreateRoom = () => {
    onIsAdminChange(true);
    const id = generateRoomCode();
    if (enableRoomRouting && typeof window !== "undefined") {
      window.history.pushState(null, "", `/${id}`);
    }
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

  // Welcome phase
  if (phase === "welcome") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 bg-[#060606] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <div className="relative z-10 text-center mb-8">
          <div
            className="text-[11px] text-[#FEFCD9]/40 uppercase tracking-[0.4em] mb-4"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            welcome to
          </div>
          <div className="flex items-center justify-center gap-2">
            <span
              className="text-3xl text-[#F95F4A]/70"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              [
            </span>
            <h1
              className="text-5xl text-[#FEFCD9] tracking-tight"
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              c0nclav3
            </h1>
            <span
              className="text-3xl text-[#F95F4A]/70"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              ]
            </span>
          </div>
        </div>
        <p
          className="relative z-10 text-sm text-[#FEFCD9]/40 mb-10 text-center max-w-[320px]"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          ACM-VIT's in-house video conferencing platform
        </p>

        <button
          onClick={() => setManualPhase("auth")}
          className="relative z-10 flex items-center gap-3 px-8 py-3 bg-[#F95F4A] text-white text-[11px] uppercase tracking-[0.3em] rounded-full active:scale-95 transition-all hover:bg-[#e8553f]"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <span>LET'S GO</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Auth phase
  if (phase === "auth") {
    return (
      <div className="flex-1 flex flex-col px-6 py-8 bg-[#060606] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <button
          onClick={() => setManualPhase("welcome")}
          className="relative z-10 text-[10px] text-[#FEFCD9]/60 uppercase tracking-[0.3em] mb-8 mobile-glass-soft mobile-pill px-3 py-1 self-start"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          ← back
        </button>

        <div className="relative z-10 flex-1 flex flex-col justify-center">
          <h2
            className="text-2xl text-[#FEFCD9] mb-2 text-center"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            Join
          </h2>
          <p
            className="text-xs text-[#FEFCD9]/40 uppercase tracking-widest text-center mb-8"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            choose how to continue
          </p>

          <div className="grid gap-3 mb-4">
            <button
              onClick={() => handleSocialSignIn("google")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#FEFCD9] hover:border-[#FEFCD9]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "google" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#FEFCD9]" />
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
              <span className="text-[13px] leading-none whitespace-nowrap tracking-tight" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Google
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("apple")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#FEFCD9] hover:border-[#FEFCD9]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "apple" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#FEFCD9]" />
              ) : (
                <img
                  src="/assets/apple-50.png"
                  alt=""
                  aria-hidden="true"
                  className="w-5 h-5 shrink-0 object-contain"
                />
              )}
              <span className="text-[13px] leading-none whitespace-nowrap tracking-tight" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Apple
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("roblox")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#FEFCD9] hover:border-[#FEFCD9]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "roblox" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#FEFCD9]" />
              ) : (
                <img
                  src="/roblox-logo.png"
                  alt=""
                  aria-hidden="true"
                  className="w-5 h-5 shrink-0 object-contain invert"
                />
              )}
              <span className="text-[13px] leading-none whitespace-nowrap tracking-tight" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Roblox
              </span>
            </button>
            <button
              onClick={() => handleSocialSignIn("vercel")}
              disabled={isSigningIn}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 mobile-glass mobile-pill text-[#FEFCD9] hover:border-[#FEFCD9]/25 hover:bg-black/40 transition-all disabled:opacity-50"
            >
              {signInProvider === "vercel" ? (
                <Loader2 className="w-5 h-5 animate-spin text-[#FEFCD9]" />
              ) : (
                <svg
                  className="w-5 h-5 shrink-0"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path fill="#fff" d="M12 4l8 14H4z" />
                </svg>
              )}
              <span className="text-[13px] leading-none whitespace-nowrap tracking-tight" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>
                Continue with Vercel
              </span>
            </button>
          </div>

          <div className="flex items-center gap-4 my-6">
            <div className="flex-1 h-px bg-[#FEFCD9]/10" />
            <span
              className="text-[10px] text-[#FEFCD9]/30 uppercase tracking-widest"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              or
            </span>
            <div className="flex-1 h-px bg-[#FEFCD9]/10" />
          </div>

          <input
            type="text"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Enter your name"
            className="w-full px-4 py-2.5 mobile-glass mobile-pill text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/25 focus:border-[#F95F4A]/50 focus:outline-none mb-3"
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

  // Join phase
  return (
    <div className="flex-1 flex flex-col bg-[#060606] safe-area-pt overflow-hidden relative">
      <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      {/* Video preview */}
      <div className="relative flex-1 px-4 pt-3 pb-36 flex flex-col min-h-0">
        <div className="relative flex-1 rounded-[28px] border border-[#FEFCD9]/10 bg-[#0d0e0d] overflow-hidden">
          {isCameraOn && localStream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover scale-x-[-1]"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
              <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
              <div className="relative w-20 h-20 rounded-full mobile-avatar flex items-center justify-center">
                <span
                  className="text-4xl text-[#FEFCD9] font-bold"
                  style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                >
                  {userEmail[0]?.toUpperCase() || "?"}
                </span>
              </div>
            </div>
          )}

          {/* Camera/mic controls */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 mobile-glass mobile-pill px-2.5 py-2 flex items-center gap-2">
            <button
              onClick={toggleMic}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isMicOn
                  ? "text-white"
                  : "bg-[#ef4444] text-white shadow-[0_0_12px_rgba(239,68,68,0.35)]"
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
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                isCameraOn
                  ? "text-white"
                  : "bg-[#ef4444] text-white shadow-[0_0_12px_rgba(239,68,68,0.35)]"
              }`}
            >
              {isCameraOn ? (
                <Video className="w-[18px] h-[18px]" />
              ) : (
                <VideoOff className="w-[18px] h-[18px]" />
              )}
            </button>
          </div>

          {/* User email */}
          <div className="absolute top-4 left-4 flex items-center gap-2 max-w-[70%]">
            <div
              className="min-w-0 px-3 py-1.5 mobile-glass mobile-pill text-xs text-[#FEFCD9]/70 truncate"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              {userEmail}
            </div>
            {canSignOut && (
              <button
                onClick={handleSignOut}
                disabled={isSigningOut}
                className="shrink-0 px-2.5 py-1 mobile-glass-soft mobile-pill text-[9px] uppercase tracking-[0.2em] text-[#FEFCD9]/70 disabled:opacity-50"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                {isSigningOut ? "Signing out..." : "Sign out"}
              </button>
            )}
          </div>

          {showPermissionHint && (
            <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 mobile-glass-soft rounded-full text-xs text-[#FEFCD9]/70">
              <AlertCircle className="w-3.5 h-3.5 text-[#F95F4A]" />
              Allow access
            </div>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-4 pb-[calc(12px+env(safe-area-inset-bottom))]">
        <div className="flex flex-col gap-3">
        {!isRoutedRoom && (
          <div className="flex mobile-glass mobile-pill p-1">
            <button
              onClick={() => {
                setActiveTab("new");
                onIsAdminChange(true);
              }}
              className={`flex-1 py-2.5 text-xs uppercase tracking-[0.25em] rounded-full transition-all ${activeTab === "new"
                ? "bg-[#F95F4A] text-white"
                : "text-[#FEFCD9]/50"
                }`}
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              New Meeting
            </button>
            <button
              onClick={() => {
                setActiveTab("join");
                onIsAdminChange(false);
              }}
              className={`flex-1 py-2.5 text-xs uppercase tracking-[0.25em] rounded-full transition-all ${activeTab === "join"
                ? "bg-[#F95F4A] text-white"
                : "text-[#FEFCD9]/50"
                }`}
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Join
            </button>
          </div>
        )}

        <div className="mobile-glass-soft mobile-pill p-1 h-[52px]">
          {activeTab === "join" || isRoutedRoom ? (
            <div className="flex items-center gap-2 h-full px-2">
              <div className="relative flex-1 h-full">
                {suggestionSuffix && (
                  <div
                    className="pointer-events-none absolute inset-0 px-2 flex items-center text-sm text-[#FEFCD9]/30 truncate"
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
                  className="relative w-full h-full bg-transparent px-2 text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:outline-none"
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
            <button
              onClick={handleCreateRoom}
              disabled={isLoading}
              className="w-full h-full flex items-center justify-center gap-2 px-4 bg-[#F95F4A] text-white rounded-full hover:bg-[#e8553f] transition-colors disabled:opacity-50"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Plus className="w-5 h-5" />
              )}
              <span className="text-sm font-medium" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>Start Meeting</span>
            </button>
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

      {isLoading && (
        <div className="absolute inset-0 bg-[#0d0e0d]/80 flex items-center justify-center z-50">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-[#F95F4A] animate-spin" />
            <span className="text-sm text-[#FEFCD9]/60">
              {connectionState === "reconnecting" ? "Reconnecting..." : "Joining..."}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(MobileJoinScreen);
