"use client";

import { errorName } from "../lib/utils";
import { Crop, Hand, Info, Maximize2, MicOff, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import {
  getRenderableParticipantVideoStream,
  isRenderingParticipantScreenShare,
} from "../lib/participant-media";
import type { Participant } from "../lib/types";
import { truncateDisplayName } from "../lib/utils";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantConnectionOverlay from "./ParticipantConnectionOverlay";
import { GhostParticipantOverlay } from "./GhostParticipantChrome";
import GameTileOverlay from "./games/GameTileOverlay";
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
  const videoStream = getRenderableParticipantVideoStream(participant);
  const isRenderingScreenShare = isRenderingParticipantScreenShare(
    participant,
    videoStream,
  );
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;
  const connectionStatus = participant.connectionStatus;
  const isReconnecting = connectionStatus?.state === "reconnecting";

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
        if (errorName(err) !== "AbortError") {
          if (errorName(err) === "NotAllowedError") {
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
  const ghostHighlight = participant.isGhost ? "!ring-1 !ring-inset !ring-[#F95F4A]/25" : "";
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
        compact ? "h-36 w-48 shrink-0 sm:w-auto" : "w-full h-full"
      } ${speakerHighlight} ${handRaisedHighlight} ${ghostHighlight} ${
        isAdmin && onAdminClick ? "cursor-pointer hover:border-[#F95F4A]/40" : ""
      }`}
      data-meet-video-adaptively-paused={
        participant.isVideoAdaptivelyPaused ? "true" : "false"
      }
      data-userid={participant.userId}
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-meet-tile-video="true"
        data-meet-video-stream-type={
          isRenderingScreenShare ? "screen" : "webcam"
        }
        data-video-object-fit={videoObjectFit}
        className={`w-full h-full ${
          videoObjectFit === "contain" ? "object-contain bg-black" : "object-cover"
        } ${
          showPlaceholder ? "hidden" : ""
        } ${isReconnecting ? "opacity-75 saturate-90" : ""}`}
      />
      {showPlaceholder && (
        <div
          className={`absolute inset-0 flex items-center justify-center bg-[#18181b] ${
            isReconnecting ? "opacity-90" : ""
          }`}
        >
          <Avatar
            className={compact ? "text-lg" : "text-3xl"}
            id={participant.userId}
            name={displayName}
            size={compact ? 48 : 80}
          />
        </div>
      )}
      <ParticipantConnectionOverlay
        status={connectionStatus}
        compact={compact}
      />
      {participant.isGhost && <GhostParticipantOverlay compact={compact} />}
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
        {isActiveSpeaker && !participant.isMuted && (
          <span className="acm-voice-activity" aria-label="Speaking">
            <span />
            <span />
            <span />
          </span>
        )}
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
      <GameTileOverlay userId={participant.userId} compact={compact} />
    </div>
  );
}

export default memo(ParticipantVideo);
