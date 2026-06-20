"use client";

import { Globe, Loader2, MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { useMeetVolume } from "../../hooks/useMeetVolume";
import { useSmartParticipantOrder } from "../../hooks/useSmartParticipantOrder";
import { getRenderableParticipantVideoStream } from "../../lib/participant-media";
import { createPlaybackRecoveryScheduler } from "../../lib/playback-recovery";
import type { Participant } from "../../lib/types";
import {
  isSystemUserId,
  normalizeBrowserUrl,
  resolveNoVncUrl,
} from "../../lib/utils";

interface MobileBrowserLayoutProps {
  browserUrl: string;
  noVncUrl: string;
  controllerName: string;
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isGhost: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  getDisplayName: (userId: string) => string;
  isAdmin?: boolean;
  isBrowserLaunching?: boolean;
  onNavigateBrowser?: (url: string) => Promise<boolean>;
}

function MobileBrowserLayout({
  browserUrl,
  noVncUrl,
  controllerName,
  localStream,
  isCameraOff,
  isMuted,
  isGhost,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  currentUserId,
  getDisplayName,
  isAdmin,
  isBrowserLaunching = false,
  onNavigateBrowser,
}: MobileBrowserLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [navInput, setNavInput] = useState(browserUrl);
  const [navError, setNavError] = useState<string | null>(null);

  // Reveal on the iframe's own `load` event; the timer is only a fallback so a
  // frame that never loads still resolves instead of spinning forever.
  useEffect(() => {
    setIsReady(false);
    if (!noVncUrl) return;
    const timer = setTimeout(() => setIsReady(true), 8000);
    return () => clearTimeout(timer);
  }, [noVncUrl]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;

    if (!localStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    video.srcObject = localStream;
    video.play().catch((err) => {
      if (err.name !== "AbortError") {
        console.error("[Meets] Mobile browser local video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [localStream]);

  useEffect(() => {
    setNavInput(browserUrl);
  }, [browserUrl]);

  const participantArray = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        participant.userId !== currentUserId &&
        !isSystemUserId(participant.userId)
    ),
    activeSpeakerId
  );

  const displayUrl = (() => {
    try {
      return new URL(browserUrl).hostname;
    } catch {
      return browserUrl;
    }
  })();

  const resolvedNoVncUrl = resolveNoVncUrl(noVncUrl);

  return (
    <div className="flex flex-col w-full h-full p-3 gap-3">
      <div className="flex-1 min-h-0 flex flex-col mobile-tile bg-[#0b0b0b]">
        {isAdmin && onNavigateBrowser && (
          <div className="px-3 py-2 mobile-glass-soft border-b border-[#fafafa]/10">
            <form
              onSubmit={async (event: FormEvent) => {
                event.preventDefault();
                const normalized = normalizeBrowserUrl(navInput);
                if (!normalized.url) {
                  setNavError(normalized.error ?? "Enter a valid URL.");
                  return;
                }
                setNavError(null);
                await onNavigateBrowser(normalized.url);
              }}
              className="flex items-center gap-2"
            >
              <Globe className="w-3.5 h-3.5 text-[#fafafa]/66 shrink-0" />
              <input
                type="text"
                value={navInput}
                onChange={(event) => {
                  setNavInput(event.target.value);
                  if (navError) setNavError(null);
                }}
                placeholder="Navigate to a URL"
                className="flex-1 bg-black/40 border border-[#fafafa]/10 rounded-full px-3 py-1.5 text-xs text-[#fafafa] placeholder:text-[#fafafa]/30 focus:outline-none focus:border-[#fafafa]/25"
              />
              <button
                type="submit"
                disabled={!navInput.trim() || isBrowserLaunching}
                className="px-3 py-1.5 rounded-full bg-[#F95F4A] text-white text-xs font-medium hover:bg-[#F95F4A]/90 disabled:opacity-40 disabled:hover:bg-[#F95F4A]"
              >
                {isBrowserLaunching ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  "Go"
                )}
              </button>
            </form>
            {navError && (
              <p className="mt-1 text-[10px] text-[#F95F4A]">{navError}</p>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 relative bg-black">
          <iframe
            src={resolvedNoVncUrl}
            onLoad={() => setIsReady(true)}
            className="absolute inset-0 w-full h-full border-0 transition-opacity duration-200"
            style={{ opacity: isReady ? 1 : 0 }}
            allow="clipboard-read; clipboard-write"
            title="Shared Browser"
          />
          {!isReady && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#131316]">
              <div className="w-14 h-14 rounded-full bg-[#F95F4A]/10 flex items-center justify-center">
                <Globe className="w-7 h-7 text-[#F95F4A] animate-pulse" />
              </div>
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-[#fafafa]/66" />
                <span className="text-sm text-[#fafafa]/56">Starting browser…</span>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-3 py-2 mobile-glass-soft border-t border-[#fafafa]/10">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-full bg-[#F95F4A]/20 flex items-center justify-center">
              <Globe className="w-2.5 h-2.5 text-[#F95F4A]" />
            </div>
            <span
              className="text-[11px] text-[#fafafa]/82 font-medium truncate max-w-[160px]"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              {displayUrl}
            </span>
          </div>
          <div
            className="flex items-center gap-2 text-[10px] text-[#fafafa]/56"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80]" />
            {controllerName} is sharing
          </div>
        </div>
      </div>

      <div className="h-24 shrink-0 flex gap-3 overflow-x-scroll no-scrollbar snap-x snap-mandatory scroll-smooth pr-3">
        <div
          className={`relative w-24 h-24 shrink-0 mobile-tile snap-start ${
            activeSpeakerId === currentUserId ? "mobile-tile-active" : ""
          }`}
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
          />
          {isCameraOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
              <div className="absolute inset-0 bg-[rgba(249,95,74,0.15)]" />
              <Avatar className="relative mobile-avatar" id={userEmail} name={userEmail} size={40} />
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
              <div className="flex flex-col items-center gap-1">
                <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                <span
                  className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[10px] font-medium text-[#FF007A]"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                >
                  Ghost
                </span>
              </div>
            </div>
          )}
          <div
            className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#fafafa] font-medium flex items-center gap-1">
              You
              {activeSpeakerId === currentUserId && !isMuted && (
                <span className="acm-voice-activity" aria-label="Speaking">
                  <span />
                  <span />
                  <span />
                </span>
              )}
              {isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
            </span>
          </div>
        </div>

        {participantArray.map((participant) => (
          <div
            key={participant.userId}
            className={`relative w-24 h-24 shrink-0 mobile-tile snap-start ${
              participant.userId === activeSpeakerId
                ? "mobile-tile-active"
                : ""
            }`}
          >
            {getRenderableParticipantVideoStream(participant) ? (
              <VideoThumbnail participant={participant} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
                <div className="absolute inset-0 bg-[rgba(249,95,74,0.15)]" />
                <Avatar
                  className="relative mobile-avatar"
                  id={participant.userId}
                  name={getDisplayName(participant.userId)}
                  size={40}
                />
              </div>
            )}
            {participant.isGhost && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
                <div className="flex flex-col items-center gap-1">
                  <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                  <span
                    className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[10px] font-medium text-[#FF007A]"
                    style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                  >
                    Ghost
                  </span>
                </div>
              </div>
            )}
            <div
              className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#fafafa] font-medium truncate max-w-full flex items-center gap-1">
                {getDisplayName(participant.userId).split(" ")[0]}
                {participant.userId === activeSpeakerId && !participant.isMuted && (
                  <span className="acm-voice-activity" aria-label="Speaking">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
                {participant.isMuted && (
                  <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />
                )}
              </span>
            </div>
            {participant.audioStream && <AudioPlayer stream={participant.audioStream} />}
          </div>
        ))}
      </div>
    </div>
  );
}

const VideoThumbnail = memo(function VideoThumbnail({
  participant,
}: {
  participant: Participant;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoStream = getRenderableParticipantVideoStream(participant);
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!videoStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== videoStream) {
      video.srcObject = videoStream;
    }

    let cancelled = false;

    const playVideo = () => {
      if (cancelled) return;
      video.play().catch(() => {});
    };

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleWindowChange = () => {
      scheduleReplay();
    };

    scheduleReplay();

    if (videoTrack) {
      videoTrack.addEventListener("unmute", scheduleReplay);
    }
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("orientationchange", handleWindowChange);

    return () => {
      cancelled = true;
      if (videoTrack) {
        videoTrack.removeEventListener("unmute", scheduleReplay);
      }
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("orientationchange", handleWindowChange);
      playbackRecovery.clear();
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [videoStream, videoTrack]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="w-full h-full object-cover"
    />
  );
});

const AudioPlayer = memo(function AudioPlayer({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { meetVolume } = useMeetVolume();

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && stream) {
      audio.srcObject = stream;
      audio.play().catch(() => {});
    }
    return () => {
      if (audio?.srcObject === stream) {
        audio.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = meetVolume;
  }, [meetVolume]);

  return <audio ref={audioRef} autoPlay />;
});

export default memo(MobileBrowserLayout);
