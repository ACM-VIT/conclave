"use client";

import { Crop, Ghost, Hand, Info, Maximize2, MicOff, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import type { Participant } from "../lib/types";
import { truncateDisplayName } from "../lib/utils";
import ParticipantAudio from "./ParticipantAudio";
import { Avatar } from "@conclave/ui-tokens/web";

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
  isDynamicCropEnabled?: boolean;
  isFullVideoShown?: boolean;
  onToggleFullVideo?: (userId: string) => void;
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
  isDynamicCropEnabled = false,
  isFullVideoShown = false,
  onToggleFullVideo,
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
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
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
  const showFullVideoToggle =
    isDynamicCropEnabled && Boolean(videoStream) && Boolean(onToggleFullVideo);
  const fullVideoToggleLabel = isFullVideoShown
    ? "Crop this video"
    : "Show the full video";
  const adminControlOffset =
    showFullVideoToggle && onTogglePin
      ? "right-[6.5rem]"
      : showFullVideoToggle || onTogglePin
        ? "right-14"
        : "right-3";

  return (
    <div
      onClick={handleClick}
      className={`acm-video-tile group ${
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
        data-meet-tile-video="true"
        data-video-object-fit={videoObjectFit}
        className={`w-full h-full ${
          videoObjectFit === "contain" ? "object-contain bg-black" : "object-cover"
        } ${
          showPlaceholder ? "hidden" : ""
        }`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#18181b]">
          <Avatar
            className={compact ? "text-lg" : "text-3xl"}
            id={participant.userId}
            name={displayName}
            size={compact ? 48 : 80}
          />
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
          className={`absolute top-3 right-3 p-2 bg-black/60 rounded-full border border-[#fafafa]/10 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
            isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
        >
          {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
        </button>
      )}
      {showFullVideoToggle && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFullVideo?.(participant.userId);
          }}
          data-meet-tile-crop-toggle={participant.userId}
          data-meet-tile-crop-state={isFullVideoShown ? "full" : "cropped"}
          className={`absolute top-3 ${onTogglePin ? "right-14" : "right-3"} rounded-full border border-[#fafafa]/10 bg-black/60 p-2 text-[#fafafa]/82 opacity-0 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] group-hover:opacity-100 focus-visible:opacity-100`}
          title={fullVideoToggleLabel}
          aria-label={fullVideoToggleLabel}
          aria-pressed={isFullVideoShown}
        >
          {isFullVideoShown ? (
            <Crop className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>
      )}
      {isAdmin && onAdminClick && (
        <div className={`absolute top-3 ${adminControlOffset} p-2 bg-black/60 rounded-full border border-[#fafafa]/10 opacity-0 transition-[border-color,opacity] duration-[120ms] group-hover:opacity-100 hover:border-[#F95F4A]/40`}>
          <Info className="w-4 h-4 text-[#fafafa]/82" />
        </div>
      )}
    </div>
  );
}

export default memo(ParticipantVideo);
