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
import { memo, useEffect, useRef, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";
import type { ConnectionState } from "../../types";

interface MobileJoinScreenProps {
  roomId: string;
  onRoomIdChange: (id: string) => void;
  onJoin: () => void;
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
}

function MobileJoinScreen({
  roomId,
  onRoomIdChange,
  onJoin,
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
  const [isSigningIn, setIsSigningIn] = useState(false);

  const generateMeetingCode = () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  };

  const { data: session, isPending: isSessionLoading } = useSession();

  useEffect(() => {
    if (session?.user && !user) {
      const sessionUser = {
        id: session.user.id,
        email: session.user.email || "",
        name: session.user.name || session.user.email || "User",
      };
      onUserChange(sessionUser);
      setPhase("join");
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
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

  const sanitizeRoomCode = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);

  const handleCreateRoom = () => {
    onIsAdminChange(true);
    const id = generateMeetingCode();
    if (enableRoomRouting && typeof window !== "undefined") {
      window.history.pushState(null, "", `/${id}`);
    }
    onRoomIdChange(id);
    onJoinRoom(id);
  };

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    try {
      await signIn.social({
        provider: "google",
        callbackURL: window.location.href,
      });
    } catch (error) {
      console.error("Sign in error:", error);
    } finally {
      setIsSigningIn(false);
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

  if (isSessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0d0e0d]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-6 h-6 text-[#F95F4A] animate-spin" />
          <span className="text-xs text-[#FEFCD9]/40 uppercase tracking-widest">
            Checking session...
          </span>
        </div>
      </div>
    );
  }

  // Welcome phase
  if (phase === "welcome") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 bg-[#0d0e0d] safe-area-pt safe-area-pb">
        <div className="text-center mb-8">
          <h1 className="text-4xl text-[#FEFCD9] tracking-tight mb-2">
            c0nclav3
          </h1>
          <p className="text-sm text-[#FEFCD9]/30">
            Video conferencing by ACM-VIT
          </p>
        </div>

        <button
          onClick={() => setPhase("auth")}
          className="flex items-center gap-3 px-8 py-4 bg-[#F95F4A] text-white text-sm uppercase tracking-widest rounded-xl active:scale-95 transition-transform"
        >
          <span>Get Started</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // Auth phase
  if (phase === "auth") {
    return (
      <div className="flex-1 flex flex-col px-6 py-8 bg-[#0d0e0d] safe-area-pt safe-area-pb">
        <button
          onClick={() => setPhase("welcome")}
          className="text-[11px] text-[#FEFCD9]/30 uppercase tracking-widest mb-8"
        >
          ← back
        </button>

        <div className="flex-1 flex flex-col justify-center">
          <h2 className="text-2xl text-[#FEFCD9] mb-2 text-center">Join</h2>
          <p className="text-xs text-[#FEFCD9]/40 uppercase tracking-widest text-center mb-8">
            choose how to continue
          </p>

          <button
            onClick={handleGoogleSignIn}
            disabled={isSigningIn}
            className="w-full flex items-center justify-center gap-3 px-4 py-4 bg-[#1a1a1a] border border-[#FEFCD9]/10 text-[#FEFCD9] rounded-xl active:bg-[#252525] transition-colors disabled:opacity-50 mb-4"
          >
            {isSigningIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
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
            <span className="text-sm">Continue with Google</span>
          </button>

          <div className="flex items-center gap-4 my-6">
            <div className="flex-1 h-px bg-[#FEFCD9]/10" />
            <span className="text-[10px] text-[#FEFCD9]/30 uppercase tracking-widest">
              or
            </span>
            <div className="flex-1 h-px bg-[#FEFCD9]/10" />
          </div>

          <input
            type="text"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Enter your name"
            className="w-full px-4 py-4 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-xl text-base text-[#FEFCD9] placeholder:text-[#FEFCD9]/25 focus:border-[#F95F4A]/50 focus:outline-none mb-3"
            onKeyDown={(e) => {
              if (e.key === "Enter" && guestName.trim()) handleGuest();
            }}
          />
          <button
            onClick={handleGuest}
            disabled={!guestName.trim()}
            className="w-full px-4 py-4 bg-[#F95F4A] text-white text-sm rounded-xl active:bg-[#e8553f] transition-colors disabled:opacity-30"
          >
            Continue as Guest
          </button>
        </div>
      </div>
    );
  }

  // Join phase
  return (
    <div className="flex-1 flex flex-col bg-[#0d0e0d] safe-area-pt safe-area-pb overflow-hidden">
      {/* Video preview */}
      <div className="relative flex-1 bg-[#1a1a1a] overflow-hidden">
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
            <div className="w-24 h-24 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center">
              <span className="text-4xl text-[#FEFCD9] font-bold">
                {userEmail[0]?.toUpperCase() || "?"}
              </span>
            </div>
          </div>
        )}

        {/* Camera/mic controls */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/50 backdrop-blur-sm rounded-full px-3 py-2">
          <button
            onClick={toggleMic}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 ${
              isMicOn ? "text-[#FEFCD9] bg-white/10" : "bg-red-500 text-white"
            }`}
          >
            {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>
          <button
            onClick={toggleCamera}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 ${
              isCameraOn ? "text-[#FEFCD9] bg-white/10" : "bg-red-500 text-white"
            }`}
          >
            {isCameraOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>
        </div>

        {/* User email */}
        <div className="absolute top-4 left-4 px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-[#FEFCD9]/70 max-w-[60%] truncate">
          {userEmail}
        </div>

        {showPermissionHint && (
          <div className="absolute top-4 right-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#F95F4A]/10 border border-[#F95F4A]/20 text-xs text-[#FEFCD9]/70">
            <AlertCircle className="w-3.5 h-3.5 text-[#F95F4A]" />
            Allow access
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="bg-[#0d0e0d] px-4 py-4 space-y-4">
        {!isRoutedRoom && (
          <div className="flex bg-[#1a1a1a] rounded-xl p-1">
            <button
              onClick={() => {
                setActiveTab("new");
                onIsAdminChange(true);
              }}
              className={`flex-1 py-3 text-xs uppercase tracking-wider rounded-lg transition-all ${
                activeTab === "new"
                  ? "bg-[#F95F4A] text-white"
                  : "text-[#FEFCD9]/50"
              }`}
            >
              New Meeting
            </button>
            <button
              onClick={() => {
                setActiveTab("join");
                onIsAdminChange(false);
              }}
              className={`flex-1 py-3 text-xs uppercase tracking-wider rounded-lg transition-all ${
                activeTab === "join"
                  ? "bg-[#F95F4A] text-white"
                  : "text-[#FEFCD9]/50"
              }`}
            >
              Join
            </button>
          </div>
        )}

        {activeTab === "new" && !isRoutedRoom ? (
          <button
            onClick={handleCreateRoom}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 px-4 py-4 bg-[#F95F4A] text-white rounded-xl active:bg-[#e8553f] transition-colors disabled:opacity-50"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Plus className="w-5 h-5" />
            )}
            <span className="text-base font-medium">Start Meeting</span>
          </button>
        ) : (
          <div className="space-y-3">
            <input
              type="text"
              value={normalizedRoomId}
              onChange={(e) =>
                onRoomIdChange(
                  enforceShortCode
                    ? sanitizeRoomCode(e.target.value)
                    : e.target.value
                )
              }
              placeholder="Enter meeting code"
              maxLength={enforceShortCode ? 4 : undefined}
              disabled={isLoading}
              readOnly={isRoutedRoom}
              className="w-full px-4 py-4 bg-[#1a1a1a] border border-[#FEFCD9]/10 rounded-xl text-base text-[#FEFCD9] placeholder:text-[#FEFCD9]/30 focus:border-[#F95F4A]/50 focus:outline-none text-center uppercase tracking-widest"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canJoin) onJoin();
              }}
            />
            <button
              onClick={onJoin}
              disabled={!canJoin || isLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-4 bg-[#F95F4A] text-white rounded-xl active:bg-[#e8553f] transition-colors disabled:opacity-30"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <ArrowRight className="w-5 h-5" />
              )}
              <span className="text-base font-medium">Join Meeting</span>
            </button>
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
