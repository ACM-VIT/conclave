"use client";

import { Ghost, Hand, Info, MicOff } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "../lib/types";
import { truncateDisplayName } from "../lib/utils";

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
}: ParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isNew, setIsNew] = useState(true);
  const labelWidthClass = compact ? "max-w-[65%]" : "max-w-[75%]";
  const displayLabel = truncateDisplayName(displayName, compact ? 12 : 18);

  useEffect(() => {
    const timer = setTimeout(() => setIsNew(false), 800);
    return () => clearTimeout(timer);
  }, []);

  const attemptAudioPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !participant.audioStream) return;
    audio.play()
      .then(() => {
        onAudioPlaybackStarted?.();
      })
      .catch((err) => {
        if (err.name === "NotAllowedError") {
          onAudioAutoplayBlocked?.();
          return;
        }
        if (err.name !== "AbortError") {
          console.error("[Meets] Audio play error:", err);
        }
      });
  }, [onAudioAutoplayBlocked, onAudioPlaybackStarted, participant.audioStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!participant.videoStream || participant.isCameraOff) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== participant.videoStream) {
      video.srcObject = participant.videoStream;
    }

    let cancelled = false;
    const replayTimeouts: number[] = [];
    let replayRafId: number | null = null;

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

    const scheduleReplay = () => {
      playVideo();
      if (typeof window !== "undefined") {
        for (const delay of [80, 220, 480, 900, 1500]) {
          replayTimeouts.push(window.setTimeout(playVideo, delay));
        }
        let frameAttempts = 0;
        const replayOnFrame = () => {
          if (cancelled) return;
          if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            playVideo();
          }
          frameAttempts += 1;
          if (frameAttempts < 24) {
            replayRafId = window.requestAnimationFrame(replayOnFrame);
          }
        };
        replayRafId = window.requestAnimationFrame(replayOnFrame);
      }
    };

    scheduleReplay();

    const videoTrack = participant.videoStream.getVideoTracks()[0];
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
      for (const timeoutId of replayTimeouts) {
        window.clearTimeout(timeoutId);
      }
      if (replayRafId !== null) {
        window.cancelAnimationFrame(replayRafId);
      }
    };
  }, [participant.videoStream, participant.videoProducerId, participant.isCameraOff]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!participant.audioStream) {
      if (audio.srcObject) {
        audio.srcObject = null;
      }
      return;
    }

    if (audio.srcObject !== participant.audioStream) {
      audio.srcObject = participant.audioStream;
    }

    attemptAudioPlayback();

    if (audioOutputDeviceId) {
      const audioElement = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioElement.setSinkId) {
        audioElement.setSinkId(audioOutputDeviceId).catch((err) => {
          console.error("[Meets] Failed to update audio output:", err);
        });
      }
    }

    const audioTrack = participant.audioStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.addEventListener("unmute", attemptAudioPlayback);

    return () => {
      audioTrack.removeEventListener("unmute", attemptAudioPlayback);
    };
  }, [
    participant.audioStream,
    participant.audioProducerId,
    participant.isMuted,
    audioOutputDeviceId,
    attemptAudioPlayback,
  ]);

  useEffect(() => {
    if (audioPlaybackAttemptToken == null || audioPlaybackAttemptToken < 1) return;
    attemptAudioPlayback();
  }, [audioPlaybackAttemptToken, attemptAudioPlayback]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;

  const handleClick = () => {
    if (isAdmin && onAdminClick) {
      onAdminClick(participant.userId);
    }
  };

  const speakerHighlight = isActiveSpeaker 
    ? "speaking" 
    : "";

  return (
    <div
      onClick={handleClick}
      className={`acm-video-tile ${
        compact ? "h-36 shrink-0" : "w-full h-full"
      } ${
        isNew
          ? "animate-participant-join"
          : participant.isLeaving
          ? "animate-participant-leave"
          : ""
      } ${speakerHighlight} ${
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
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
          <div
            className={`rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold ${
              compact ? "w-12 h-12 text-lg" : "w-20 h-20 text-3xl"
            }`}
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
              } text-[#FF007A] drop-shadow-[0_0_20px_rgba(255,0,122,0.5)]`}
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
      <audio ref={audioRef} autoPlay />
      {participant.isHandRaised && (
        <div
          className={`absolute top-3 left-3 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)] ${
            compact ? "p-1.5" : "p-2"
          }`}
          title="Hand raised"
        >
          <Hand className={compact ? "w-3 h-3" : "w-4 h-4"} />
        </div>
      )}
      <div
        className={`absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-[#FEFCD9]/10 rounded-full px-3 py-1.5 flex items-center gap-2 ${labelWidthClass} ${
          compact ? "text-[10px]" : "text-xs"
        }`}
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        <span
          className="font-medium text-[#FEFCD9] uppercase tracking-wide truncate"
          title={displayName}
        >
          {displayLabel}
        </span>
        {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
      </div>
      {isAdmin && onAdminClick && (
        <div className="absolute top-3 right-3 p-2 bg-black/60 backdrop-blur-sm rounded-full border border-[#FEFCD9]/10 transition-all hover:border-[#F95F4A]/40">
          <Info className="w-4 h-4 text-[#FEFCD9]/70" />
        </div>
      )}
    </div>
  );
}

export default memo(ParticipantVideo);
