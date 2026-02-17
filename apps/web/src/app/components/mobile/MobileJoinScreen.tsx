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
  const [phase, setPhase] = useState<"welcome" | "auth" | "join">(() => {
    if (user && user.id && !user.id.startsWith("guest-")) {
      return "join";
    }
    return "welcome";
  });
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
  const canSignOut = Boolean(
    session?.user || (user?.id && !user?.id?.startsWith("guest-"))
  );
  const lastAppliedSessionUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!session?.user) {
      lastAppliedSessionUserIdRef.current = null;
      return;
    }

    if (user && !lastAppliedSessionUserIdRef.current) {
      lastAppliedSessionUserIdRef.current = session.user.id;
      return;
    }

    if (!user && lastAppliedSessionUserIdRef.current !== session.user.id) {
      const sessionUser = {
        id: session.user.id,
        email: session.user.email || "",
        name: session.user.name || session.user.email || "User",
      };
      onUserChange(sessionUser);
      setPhase("join");
      lastAppliedSessionUserIdRef.current = session.user.id;
    }
  }, [session, user, onUserChange]);

  const prevUserRef = useRef(user);
  useEffect(() => {
    const prevUser = prevUserRef.current;
    prevUserRef.current = user;

    if (!prevUser && user && user.id && !user.id.startsWith("guest-")) {
      setPhase("join");
    }
    if (prevUser && !user) {
      setPhase("welcome");
    }
  }, [user]);

  useEffect(() => {
    if (phase !== "join") {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        setLocalStream(null);
      }
      return;
    }

    return () => {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [phase]);

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
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: STANDARD_QUALITY_CONSTRAINTS,
        });
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
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
        }
      } catch (err) {
        console.log("[MobileJoinScreen] Camera access denied");
      }
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
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: DEFAULT_AUDIO_CONSTRAINTS,
        });
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          if (localStream) {
            localStream.addTrack(audioTrack);
          } else {
            setLocalStream(stream);
          }
          setIsMicOn(true);
        }
      } catch (err) {
        console.log("[MobileJoinScreen] Microphone access denied");
      }
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
    try {
      await signIn.social({
        provider,
        callbackURL: window.location.href,
      });
    } catch (error) {
      console.error("Sign in error:", error);
    } finally {
      setSignInProvider(null);
    }
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
      onUserChange(null);
      onIsAdminChange(false);
      setPhase("welcome");
    } catch (error) {
      console.error("Sign out error:", error);
    } finally {
      setIsSigningOut(false);
    }
  };

  const handleGuest = () => {
    const guestUser = {
      id: `guest-${Date.now()}`,
      email: `guest-${guestName}@guest.com`,
      name: guestName,
    };
    onUserChange(guestUser);
    onIsAdminChange(false);
    setPhase("join");
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
    if (activeTab !== "join") {
      setActiveTab("join");
    }
    onIsAdminChange(false);
  }, [activeTab, isRoutedRoom, onIsAdminChange]);

  // Welcome phase
  if (phase === "welcome") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 bg-gradient-to-b from-[#101010] via-[#0d0e0d] to-[#0b0c0c] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <div className="relative z-10 text-center mb-8">
          <div
            className="text-xs text-[#FEFCD9]/40 uppercase tracking-widest mb-3"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            welcome to
          </div>
          <h1
            className="text-4xl text-[#FEFCD9] tracking-tight"
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            c0nclav3
          </h1>
        </div>
        <p
          className="relative z-10 text-sm text-[#FEFCD9]/30 mb-10 text-center"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          ACM-VIT's in-house video conferencing platform
        </p>

        <button
          onClick={() => setPhase("auth")}
          className="relative z-10 flex items-center gap-3 px-8 py-3 bg-[#F95F4A] text-white text-xs uppercase tracking-widest rounded-lg active:scale-95 transition-all hover:bg-[#e8553f]"
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
      <div className="flex-1 flex flex-col px-6 py-8 bg-gradient-to-b from-[#101010] via-[#0d0e0d] to-[#0b0c0c] safe-area-pt relative overflow-hidden">
        <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
        <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
        <button
          onClick={() => setPhase("welcome")}
          className="relative z-10 text-[11px] text-[#FEFCD9]/30 uppercase tracking-widest mb-8"
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
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#1a1a1a] border border-[#FEFCD9]/10 text-[#FEFCD9] rounded-lg hover:border-[#FEFCD9]/25 hover:bg-[#1a1a1a]/80 transition-all disabled:opacity-50"
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
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#1a1a1a] border border-[#FEFCD9]/10 text-[#FEFCD9] rounded-lg hover:border-[#FEFCD9]/25 hover:bg-[#1a1a1a]/80 transition-all disabled:opacity-50"
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
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#1a1a1a] border border-[#FEFCD9]/10 text-[#FEFCD9] rounded-lg hover:border-[#FEFCD9]/25 hover:bg-[#1a1a1a]/80 transition-all disabled:opacity-50"
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
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#1a1a1a] border border-[#FEFCD9]/10 text-[#FEFCD9] rounded-lg hover:border-[#FEFCD9]/25 hover:bg-[#1a1a1a]/80 transition-all disabled:opacity-50"
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
            className="w-full px-3 py-2.5 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-lg text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/25 focus:border-[#F95F4A]/50 focus:outline-none mb-3"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && guestName.trim()) handleGuest();
            }}
          />
          <button
            onClick={handleGuest}
            disabled={!guestName.trim()}
            className="w-full px-4 py-3 bg-[#F95F4A] text-white text-sm rounded-lg hover:bg-[#e8553f] transition-colors disabled:opacity-30"
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
    <div className="flex-1 flex flex-col bg-gradient-to-b from-[#101010] via-[#0d0e0d] to-[#0b0c0c] safe-area-pt overflow-hidden relative">
      <div className="absolute inset-0 acm-bg-radial pointer-events-none" />
      <div className="absolute inset-0 acm-bg-dot-grid pointer-events-none" />
      {/* Video preview */}
      <div className="relative flex-1 bg-[#0d0e0d] overflow-hidden border border-[#FEFCD9]/10 rounded-xl mx-3 mt-3 shadow-2xl">
        {isCameraOn && localStream ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover scale-x-[-1]"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center">
              <span className="text-4xl text-[#FEFCD9] font-bold">
                {userEmail[0]?.toUpperCase() || "?"}
              </span>
            </div>
          </div>
        )}

        {/* Camera/mic controls */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-2.5 py-2">
          <button
            onClick={toggleMic}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-95 ${isMicOn ? "text-[#FEFCD9] hover:bg-white/10" : "bg-red-500 text-white"
              }`}
          >
            {isMicOn ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
          </button>
          <button
            onClick={toggleCamera}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-95 ${isCameraOn ? "text-[#FEFCD9] hover:bg-white/10" : "bg-red-500 text-white"
              }`}
          >
            {isCameraOn ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
          </button>
        </div>

        {/* User email */}
        <div className="absolute top-4 left-4 flex items-center gap-2 max-w-[70%]">
          <div
            className="min-w-0 px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-[#FEFCD9]/70 truncate"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            {userEmail}
          </div>
          {canSignOut && (
            <button
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="shrink-0 px-2.5 py-1 bg-black/50 backdrop-blur-sm rounded-full text-[9px] uppercase tracking-widest text-[#FEFCD9]/70 active:bg-black/70 disabled:opacity-50"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              {isSigningOut ? "Signing out..." : "Sign out"}
            </button>
          )}
        </div>

        {showPermissionHint && (
          <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F95F4A]/10 border border-[#F95F4A]/20 text-xs text-[#FEFCD9]/70">
            <AlertCircle className="w-3.5 h-3.5 text-[#F95F4A]" />
            Allow access
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="relative z-10 bg-[#0f0f0f]/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] space-y-4 backdrop-blur-sm">
        <div
          className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <span className="text-[#FEFCD9]/40">Preflight</span>
          <div className="flex items-center gap-2 bg-black/40 border border-[#FEFCD9]/10 rounded-full px-3 py-1 text-[#FEFCD9]/70">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isMicOn ? "bg-emerald-400" : "bg-[#F95F4A]"
                }`}
            />
            Mic {isMicOn ? "On" : "Off"}
          </div>
          <div className="flex items-center gap-2 bg-black/40 border border-[#FEFCD9]/10 rounded-full px-3 py-1 text-[#FEFCD9]/70">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isCameraOn ? "bg-emerald-400" : "bg-[#F95F4A]"
                }`}
            />
            Camera {isCameraOn ? "On" : "Off"}
          </div>
          {onTestSpeaker && (
            <button
              type="button"
              onClick={onTestSpeaker}
              className="ml-auto flex items-center gap-2 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-full px-3 py-1 text-[#FEFCD9]/70 hover:text-[#FEFCD9] hover:border-[#FEFCD9]/30 transition-colors"
            >
              Test speaker
            </button>
          )}
        </div>
        {!isRoutedRoom && (
          <div className="flex bg-[#1a1a1a] rounded-lg p-1">
            <button
              onClick={() => {
                setActiveTab("new");
                onIsAdminChange(true);
              }}
              className={`flex-1 py-2.5 text-xs uppercase tracking-wider rounded-md transition-all ${activeTab === "new"
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
              className={`flex-1 py-2.5 text-xs uppercase tracking-wider rounded-md transition-all ${activeTab === "join"
                ? "bg-[#F95F4A] text-white"
                : "text-[#FEFCD9]/50"
                }`}
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              Join
            </button>
          </div>
        )}

        {activeTab === "new" && !isRoutedRoom ? (
          <button
            onClick={handleCreateRoom}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#F95F4A] text-white rounded-lg hover:bg-[#e8553f] transition-colors disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Plus className="w-5 h-5" />
            )}
            <span className="text-sm font-medium" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>Start Meeting</span>
          </button>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              {suggestionSuffix && (
                <div
                  className="pointer-events-none absolute inset-0 px-3 py-2.5 text-sm text-[#FEFCD9]/30 truncate"
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
                className="relative w-full px-3 py-2.5 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-lg text-sm text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:border-[#F95F4A]/50 focus:outline-none"
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
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-[#F95F4A] text-white rounded-lg hover:bg-[#e8553f] transition-colors disabled:opacity-30"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ArrowRight className="w-5 h-5" />
              )}
              <span className="text-sm font-medium" style={{ fontFamily: "'PolySans Trial', sans-serif" }}>Join Meeting</span>
            </button>
          </div>
        )}

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
