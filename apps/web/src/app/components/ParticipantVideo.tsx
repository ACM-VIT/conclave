"use client";

import { errorName } from "../lib/utils";
import { Crop, Hand, Info, Maximize2, Pin, PinOff } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import {
  getRenderableParticipantVideoStream,
  isRenderingParticipantScreenShare,
} from "../lib/participant-media";
import type { Participant } from "../lib/types";
import { isVoiceAgentUserId } from "../lib/voice-agent";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantConnectionOverlay from "./ParticipantConnectionOverlay";
import GameTileOverlay from "./games/GameTileOverlay";
import TileNameplate from "./TileNameplate";
import VoiceAgentOrb from "./VoiceAgentOrb";
import { Avatar } from "@conclave/ui-tokens/web";
import { color } from "@conclave/ui-tokens";
import { useElementSize } from "../hooks/useElementSize";
import { computeTileChrome } from "../lib/tile-chrome";
import { observeRemoteVideoPresentation } from "../lib/remote-video-presentation";
import {
  PORTRAIT_BACKDROP_STYLE,
  PORTRAIT_FULL_STYLE,
  PORTRAIT_ZOOM_STYLE,
  isPortraitAspect,
  isPortraitFraming,
  readVideoAspect,
  resolveTileVideoFraming,
} from "../lib/tile-video-framing";

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
  hideLabel?: boolean;
  isPinned?: boolean;
  onTogglePin?: (userId: string) => void;
  isDynamicCropEnabled?: boolean;
  isFullVideoShown?: boolean;
  onToggleFullVideo?: (userId: string) => void;
  // The grid gave this tile the video's own shape, so portrait video needs no
  // zoom or blurred fill.
  isTileShapedToVideo?: boolean;
  onVideoAspectChange?: (aspect: number | null) => void;
  tileWidth?: number;
  tileHeight?: number;
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
  hideLabel = false,
  isPinned = false,
  onTogglePin,
  isDynamicCropEnabled = false,
  isFullVideoShown = false,
  onToggleFullVideo,
  isTileShapedToVideo = false,
  onVideoAspectChange,
  tileWidth,
  tileHeight,
}: ParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const backdropRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const hasKnownTileSize =
    typeof tileWidth === "number" &&
    tileWidth > 0 &&
    typeof tileHeight === "number" &&
    tileHeight > 0;
  const measuredTileSize = useElementSize(tileRef, !hasKnownTileSize);
  const tileSize = hasKnownTileSize
    ? { width: tileWidth, height: tileHeight }
    : measuredTileSize;
  const { dense, avatarSize, avatarLift } = computeTileChrome(tileSize, {
    maxAvatar: compact ? 48 : 80,
  });
  const isAgent = isVoiceAgentUserId(participant.userId);
  const videoStream = getRenderableParticipantVideoStream(participant);
  const isRenderingScreenShare = isRenderingParticipantScreenShare(
    participant,
    videoStream,
  );
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;
  const connectionStatus = participant.connectionStatus;
  const isReconnecting = connectionStatus?.state === "reconnecting";
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const isPortraitVideo = isPortraitAspect(videoAspect);
  const videoFraming = resolveTileVideoFraming({
    objectFit: videoObjectFit,
    isPortrait: isPortraitVideo,
    isFullVideoShown,
    isScreenShare: isRenderingScreenShare,
    isTileShapedToVideo,
  });
  const showsPortraitBackdrop = isPortraitFraming(videoFraming);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoStream) {
      setVideoAspect(null);
      return;
    }
    const readShape = () =>
      setVideoAspect((previous) =>
        readVideoAspect(video.videoWidth, video.videoHeight, previous),
      );
    readShape();
    video.addEventListener("loadedmetadata", readShape);
    video.addEventListener("resize", readShape);
    return () => {
      video.removeEventListener("loadedmetadata", readShape);
      video.removeEventListener("resize", readShape);
    };
  }, [videoStream]);

  useEffect(() => {
    onVideoAspectChange?.(isRenderingScreenShare ? null : videoAspect);
  }, [isRenderingScreenShare, videoAspect, onVideoAspectChange]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop || !videoStream) return;
    backdrop.srcObject = videoStream;
    backdrop.play().catch(() => {});
    return () => {
      backdrop.srcObject = null;
    };
  }, [videoStream, showsPortraitBackdrop]);

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
        <TileNameplate
          name={displayName}
          dense={dense}
          isMuted={false}
          isSpeaking={isActiveSpeaker}
          badge={
            <span
              className="shrink-0 rounded-md px-1.5 py-px text-[9px] font-semibold tracking-wide"
              style={{ backgroundColor: color.accent, color: "#fff" }}
            >
              AI
            </span>
          }
        />
        <GameTileOverlay userId={participant.userId} compact={compact} />
      </div>
    );
  }

  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = participant.isHandRaised ? "!border-amber-400/60" : "";
  // A viewer who chose the full video keeps the way back after the camera
  // turns landscape.
  const showFullVideoToggle =
    (isDynamicCropEnabled ||
      ((isPortraitVideo || isFullVideoShown) && !isRenderingScreenShare)) &&
    Boolean(videoStream) &&
    Boolean(onToggleFullVideo);
  const fullVideoToggleLabel = isFullVideoShown
    ? "Crop this video"
    : "Show the full video";
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
        data-meet-tile-video-framing={videoFraming}
        style={
          videoFraming === "portrait-zoom"
            ? PORTRAIT_ZOOM_STYLE
            : videoFraming === "portrait-full"
              ? PORTRAIT_FULL_STYLE
              : undefined
        }
        className={`w-full h-full ${
          videoFraming === "cover"
            ? "object-cover"
            : videoFraming === "contain"
              ? "object-contain bg-black"
              : "object-contain"
        } ${
          showPlaceholder ? "hidden" : ""
        } ${isReconnecting ? "opacity-75 saturate-90" : ""}`}
      />
      {showsPortraitBackdrop && !showPlaceholder && (
        <video
          ref={backdropRef}
          autoPlay
          muted
          playsInline
          aria-hidden
          tabIndex={-1}
          data-meet-tile-video-backdrop="true"
          style={PORTRAIT_BACKDROP_STYLE}
        />
      )}
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
      {!hideLabel && (
        <TileNameplate
          name={displayName}
          dense={dense}
          isMuted={participant.isMuted}
          isSpeaking={isActiveSpeaker && !participant.isMuted}
        />
      )}
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
