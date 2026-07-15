"use client";

import { errorName } from "../lib/utils";
import { Crop, Hand, Info, Maximize2, MicOff, Pin, PinOff } from "lucide-react";
import { memo, useLayoutEffect, useRef } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import {
  getRenderableParticipantVideoStream,
  isRenderingParticipantScreenShare,
} from "../lib/participant-media";
import type { Participant } from "../lib/types";
import { truncateDisplayName } from "../lib/utils";
import { isVoiceAgentUserId } from "../lib/voice-agent";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantConnectionOverlay from "./ParticipantConnectionOverlay";
import GameTileOverlay from "./games/GameTileOverlay";
import VoiceAgentOrb from "./VoiceAgentOrb";
import { Avatar } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";
import { useElementSize } from "../hooks/useElementSize";
import { computeTileChrome } from "../lib/tile-chrome";
import { observeRemoteVideoPresentation } from "../lib/remote-video-presentation";

interface ParticipantVideoProps {
  participant: Participant;
  displayName: string;
  compact?: boolean;
  isActiveSpeaker?: boolean;
  audioOutputDeviceId?: string;
  isAdmin?: boolean;
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
  // The grid packer shrinks tiles well below the fixed chrome sizes in big
  // calls — measure the tile and scale the face/pill/badges to fit.
  const tileRef = useRef<HTMLDivElement>(null);
  const tileSize = useElementSize(tileRef);
  const { dense, avatarSize, avatarLift } = computeTileChrome(tileSize, {
    maxAvatar: compact ? 48 : 80,
  });
  // Dense tiles dedicate the bottom strip to the name pill (the face is
  // lifted clear of it), so the pill may run wider before truncating.
  const labelWidthClass = dense
    ? "max-w-[82%]"
    : compact
      ? "max-w-[65%]"
      : "max-w-[75%]";
  const labelPillClass = dense
    ? "bottom-1.5 left-1.5 gap-1 px-2 py-0.5 text-[10px]"
    : `bottom-3 left-3 gap-2 px-3 py-1.5 ${compact ? "text-[10px]" : "text-xs"}`;
  const displayLabel = truncateDisplayName(
    displayName,
    dense ? 16 : compact ? 12 : 18,
  );
  const isAgent = isVoiceAgentUserId(participant.userId);
  const videoStream = getRenderableParticipantVideoStream(participant);
  const isRenderingScreenShare = isRenderingParticipantScreenShare(
    participant,
    videoStream,
  );
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;
  const connectionStatus = participant.connectionStatus;
  const isReconnecting = connectionStatus?.state === "reconnecting";

  useLayoutEffect(() => {
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
    const stopPresentationObservation = observeRemoteVideoPresentation(
      video,
      videoStream,
    );

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
      stopPresentationObservation();
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

  // The AI voice agent has no camera and is not a person. It keeps the native
  // tile frame, label, and active-speaker ring so it sits naturally in the
  // grid, but swaps the avatar for a waveform mark and tags the label "AI".
  if (isAgent) {
    return (
      <div
        ref={tileRef}
        className={`acm-video-tile group ${
          compact ? "h-36 w-48 shrink-0 sm:w-auto" : "w-full h-full"
        } ${isActiveSpeaker ? "speaking" : ""}`}
        data-userid={participant.userId}
        data-meet-voice-agent-tile="true"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        {!disableAudio && (
          <ParticipantAudio
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
            onAudioAutoplayBlocked={onAudioAutoplayBlocked}
            onAudioPlaybackStarted={onAudioPlaybackStarted}
            audioPlaybackAttemptToken={audioPlaybackAttemptToken}
          />
        )}
        <ParticipantConnectionOverlay
          status={connectionStatus}
          compact={compact}
        />
        <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
          <VoiceAgentOrb
            state={isActiveSpeaker ? "speaking" : "idle"}
            compact={compact}
            audioStream={participant.audioStream ?? null}
          />
        </div>
        <div
          className={`absolute bg-black/70 border border-[#fafafa]/10 rounded-full flex items-center ${labelPillClass}`}
        >
          <span className="font-medium text-[#fafafa] truncate" title={displayName}>
            {displayLabel}
          </span>
          <span
            className="rounded-md px-1.5 py-px text-[9px] font-semibold tracking-wide"
            style={{ backgroundColor: color.accent, color: "#fff" }}
          >
            AI
          </span>
          {isActiveSpeaker && (
            <span className="acm-voice-activity" aria-label="Speaking">
              <span />
              <span />
              <span />
            </span>
          )}
        </div>
        <GameTileOverlay userId={participant.userId} compact={compact} />
      </div>
    );
  }

  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = participant.isHandRaised ? "!border-amber-400/60" : "";
  const showFullVideoToggle =
    isDynamicCropEnabled && Boolean(videoStream) && Boolean(onToggleFullVideo);
  const fullVideoToggleLabel = isFullVideoShown
    ? "Crop this video"
    : "Show the full video";
  // Hover controls stack right-to-left in fixed slots; dense tiles use
  // smaller buttons, so the slots sit closer together.
  const controlTopClass = dense ? "top-1.5" : "top-3";
  const controlPadClass = dense ? "p-1.5" : "p-2";
  const controlIconClass = dense ? "w-3.5 h-3.5" : "w-4 h-4";
  const controlRightClasses = dense
    ? ["right-1.5", "right-[2.375rem]", "right-[4.375rem]"]
    : ["right-3", "right-14", "right-[6.5rem]"];
  const adminControlOffset =
    controlRightClasses[(onTogglePin ? 1 : 0) + (showFullVideoToggle ? 1 : 0)];

  return (
    <div
      ref={tileRef}
      onClick={handleClick}
      className={`acm-video-tile group ${
        compact ? "h-36 w-48 shrink-0 sm:w-auto" : "w-full h-full"
      } ${speakerHighlight} ${handRaisedHighlight} ${
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
          <div
            style={
              avatarLift > 0
                ? { transform: `translateY(-${avatarLift}px)` }
                : undefined
            }
          >
            <Avatar
              className={compact ? "text-lg" : "text-3xl"}
              id={participant.userId}
              name={displayName}
              size={avatarSize}
            />
          </div>
        </div>
      )}
      <ParticipantConnectionOverlay
        status={connectionStatus}
        compact={compact}
      />
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
          className={`absolute rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 ${
            dense ? "top-1.5 left-1.5" : "top-3 left-3"
          } ${compact || dense ? "p-1.5" : "p-2"}`}
          title="Hand raised"
        >
          <Hand className={compact || dense ? "w-3 h-3" : "w-4 h-4"} />
        </div>
      )}
      <div
        className={`absolute bg-black/70 border border-[#fafafa]/10 rounded-full flex items-center ${labelWidthClass} ${labelPillClass}`}
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
        {participant.isMuted && (
          <MicOff
            className={`text-[#F95F4A] shrink-0 ${dense ? "w-2.5 h-2.5" : "w-3 h-3"}`}
          />
        )}
      </div>
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(participant.userId);
          }}
          className={`absolute ${controlTopClass} ${controlRightClasses[0]} ${controlPadClass} bg-black/60 rounded-full border border-[#fafafa]/10 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
            isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
        >
          {isPinned ? (
            <PinOff className={controlIconClass} />
          ) : (
            <Pin className={controlIconClass} />
          )}
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
          className={`absolute ${controlTopClass} ${
            controlRightClasses[onTogglePin ? 1 : 0]
          } rounded-full border border-[#fafafa]/10 bg-black/60 ${controlPadClass} text-[#fafafa]/82 opacity-0 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] group-hover:opacity-100 focus-visible:opacity-100`}
          title={fullVideoToggleLabel}
          aria-label={fullVideoToggleLabel}
          aria-pressed={isFullVideoShown}
        >
          {isFullVideoShown ? (
            <Crop className={controlIconClass} />
          ) : (
            <Maximize2 className={controlIconClass} />
          )}
        </button>
      )}
      {isAdmin && onAdminClick && (
        <div className={`absolute ${controlTopClass} ${adminControlOffset} ${controlPadClass} bg-black/60 rounded-full border border-[#fafafa]/10 opacity-0 transition-[border-color,opacity] duration-[120ms] group-hover:opacity-100 hover:border-[#F95F4A]/40`}>
          <Info className={`${controlIconClass} text-[#fafafa]/82`} />
        </div>
      )}
      <GameTileOverlay userId={participant.userId} compact={compact} />
    </div>
  );
}

export default memo(ParticipantVideo);
