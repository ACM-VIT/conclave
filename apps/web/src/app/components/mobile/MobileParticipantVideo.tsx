"use client";

import { Hand, MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { Participant } from "../../lib/types";
import { truncateDisplayName } from "../../lib/utils";

interface MobileParticipantVideoProps {
  participant: Participant;
  displayName: string;
  isActiveSpeaker?: boolean;
  audioOutputDeviceId?: string;
  size?: "small" | "medium" | "large" | "featured";
}

function MobileParticipantVideo({
  participant,
  displayName,
  isActiveSpeaker = false,
  audioOutputDeviceId,
  size = "medium",
}: MobileParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

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

    const playVideo = () => {
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile video play error:", err);
        }
      });
    };

    playVideo();

    const videoTrack = participant.videoStream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.addEventListener("unmute", playVideo);

    return () => {
      videoTrack.removeEventListener("unmute", playVideo);
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

    const playAudio = () => {
      audio.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile audio play error:", err);
        }
      });
    };

    playAudio();

    if (audioOutputDeviceId) {
      const audioElement = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioElement.setSinkId) {
        audioElement.setSinkId(audioOutputDeviceId).catch((err) => {
          console.error("[Meets] Failed to set audio output:", err);
        });
      }
    }

    const audioTrack = participant.audioStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.addEventListener("unmute", playAudio);

    return () => {
      audioTrack.removeEventListener("unmute", playAudio);
    };
  }, [
    participant.audioStream,
    participant.audioProducerId,
    participant.isMuted,
    audioOutputDeviceId,
  ]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;

  const sizeClasses = {
    small: "w-20 h-20",
    medium: "w-full aspect-video",
    large: "w-full h-full",
    featured: "w-full h-full min-h-[200px]",
  };

  const avatarSizes = {
    small: "w-8 h-8 text-sm",
    medium: "w-12 h-12 text-lg",
    large: "w-16 h-16 text-2xl",
    featured: "w-20 h-20 text-3xl",
  };

  const speakerRing = isActiveSpeaker ? "mobile-tile-active" : "";
  const displayLabel = truncateDisplayName(
    displayName,
    size === "featured" ? 16 : size === "large" ? 14 : 12
  );

  return (
    <div
      className={`mobile-tile ${sizeClasses[size]} ${speakerRing}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${showPlaceholder ? "hidden" : ""}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
          <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
          <div
            className={`relative rounded-full mobile-avatar flex items-center justify-center text-[#FEFCD9] font-bold ${avatarSizes[size]}`}
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
          <div className="flex flex-col items-center gap-2">
            <VenetianMask className="w-10 h-10 text-[#FF007A]" />
            <span
              className="mobile-ghost-badge rounded-full px-3 py-1 text-[10px] tracking-[0.25em] text-[#FF007A]"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              GHOST
            </span>
          </div>
        </div>
      )}
      {participant.isHandRaised && (
        <div className="absolute top-2 left-2 p-2 rounded-full mobile-hand-badge text-amber-200">
          <Hand className="w-3.5 h-3.5" />
        </div>
      )}
      <audio ref={audioRef} autoPlay />
      {size !== "small" && (
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between">
          <div
            className="mobile-name-pill px-2.5 py-1 flex items-center gap-2 max-w-[85%] backdrop-blur-md"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            <span
              className="text-[10px] text-[#FEFCD9] font-medium truncate uppercase tracking-[0.18em]"
              title={displayName}
            >
              {displayLabel}
            </span>
            {participant.isMuted && (
              <MicOff className="w-2.5 h-2.5 text-[#F95F4A] shrink-0" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(MobileParticipantVideo);
