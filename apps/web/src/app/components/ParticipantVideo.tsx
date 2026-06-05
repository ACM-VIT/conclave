"use client";

import { Ghost, Hand, Info, MicOff, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import type { Participant } from "../lib/types";
import { truncateDisplayName } from "../lib/utils";
import ParticipantAudio from "./ParticipantAudio";
import { avatarColor } from "@conclave/ui-tokens";

interface ParticipantVideoProps {
  participant: Participant;
  displayName: string;
  compact?: boolean;
  isActiveSpeaker?: boolean;
  audioOutputDeviceId?: string;
  isAdmin?: boolean;
  isSelected?: boolean;
  onAdminClick?: (userId: string) => void;
  videoObjectFit?: "cover" | "contain";
  onAudioAutoplayBlocked?: () => void;
  onAudioPlaybackStarted?: () => void;
  audioPlaybackAttemptToken?: number;
  disableAudio?: boolean;
  isPinned?: boolean;
  onTogglePin?: (userId: string) => void;
}

function ParticipantVideo({
  participant,
  displayName,
  compact = false,
  isActiveSpeaker = false,
  audioOutputDeviceId,
  isAdmin = false,
  isSelected = false,
  onAdminClick,
  videoObjectFit = "cover",
  onAudioAutoplayBlocked,
  onAudioPlaybackStarted,
  audioPlaybackAttemptToken,
  disableAudio = false,
  isPinned = false,
  onTogglePin,
}: ParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const labelWidthClass = compact ? "max-w-[65%]" : "max-w-[75%]";
  const displayLabel = truncateDisplayName(displayName, compact ? 12 : 18);
  const videoStream = participant.isCameraOff ? null : participant.videoStream;
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
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          if (err.name === "NotAllowedError") {
            video.muted = true;
            video.play().catch(() => {});
            return;
          }
          console.error("[Meets] Video play error:", err);
        }
      });
    };

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;

    scheduleReplay();

    const handleTrackUnmuted = () => {
      scheduleReplay();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleResize = () => {
      scheduleReplay();
    };
    const handleOrientationChange = () => {
      scheduleReplay();
    };

    if (videoTrack) {
      videoTrack.addEventListener("unmute", handleTrackUnmuted);
    }
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    video.addEventListener("suspend", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);

    return () => {
      cancelled = true;
      if (videoTrack) {
        videoTrack.removeEventListener("unmute", handleTrackUnmuted);
      }
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      video.removeEventListener("suspend", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      playbackRecovery.clear();
    };
  }, [videoStream, videoTrack]);

  const showPlaceholder = !videoStream;

  const handleClick = () => {
    if (isAdmin && onAdminClick) {
      onAdminClick(participant.userId);
    }
  };

  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = participant.isHandRaised ? "!border-amber-400/60" : "";

  return (
    <div
      onClick={handleClick}
      className={`acm-video-tile ${
        compact ? "h-36 shrink-0" : "w-full h-full"
      } ${speakerHighlight} ${handRaisedHighlight} ${
        isAdmin && onAdminClick ? "cursor-pointer hover:border-[#F95F4A]/40" : ""
      }`}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`w-full h-full ${
          videoObjectFit === "contain" ? "object-contain bg-black" : "object-cover"
        } ${
          showPlaceholder ? "hidden" : ""
        }`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#18181b]">
          <div
            className={`rounded-full flex items-center justify-center text-white font-bold ${
              compact ? "w-12 h-12 text-lg" : "w-20 h-20 text-3xl"
            }`}
            style={{ backgroundColor: avatarColor(participant.userId) }}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
          <div
            className={`flex flex-col items-center ${
              compact ? "gap-1" : "gap-2"
            }`}
          >
            <Ghost
              className={`${
                compact ? "w-10 h-10" : "w-16 h-16"
              } text-[#FF007A]`}
            />
            <span
              className={`${
                compact ? "text-[9px]" : "text-xs"
              } text-[#FF007A] bg-black/60 border border-[#FF007A]/30 px-3 py-1 rounded-full uppercase tracking-wider font-medium`}
            >
              Ghost
            </span>
          </div>
        </div>
      )}
      {!disableAudio && (
        <ParticipantAudio
          participant={participant}
          audioOutputDeviceId={audioOutputDeviceId}
          onAudioAutoplayBlocked={onAudioAutoplayBlocked}
          onAudioPlaybackStarted={onAudioPlaybackStarted}
          audioPlaybackAttemptToken={audioPlaybackAttemptToken}
        />
      )}
      {participant.isHandRaised && (
        <div
          className={`absolute top-3 left-3 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 ${
            compact ? "p-1.5" : "p-2"
          }`}
          title="Hand raised"
        >
          <Hand className={compact ? "w-3 h-3" : "w-4 h-4"} />
        </div>
      )}
      <div
        className={`absolute bottom-3 left-3 bg-black/70 border border-[#fafafa]/10 rounded-full px-3 py-1.5 flex items-center gap-2 ${labelWidthClass} ${
          compact ? "text-[10px]" : "text-xs"
        }`}
      >
        <span
          className="font-medium text-[#fafafa] truncate"
          title={displayName}
        >
          {displayLabel}
        </span>
        {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
      </div>
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(participant.userId);
          }}
          className="absolute top-3 right-3 p-2 bg-black/60 rounded-full border border-[#fafafa]/10 text-[#fafafa]/82 transition-[border-color,color] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa]"
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
        >
          {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
        </button>
      )}
      {isAdmin && onAdminClick && (
        <div className={`absolute top-3 ${onTogglePin ? "right-14" : "right-3"} p-2 bg-black/60 rounded-full border border-[#fafafa]/10 transition-all hover:border-[#F95F4A]/40`}>
          <Info className="w-4 h-4 text-[#fafafa]/82" />
        </div>
      )}
    </div>
  );
}

export default memo(ParticipantVideo);
