"use client";

import { Ghost, Hand, MicOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { Participant } from "../../types";

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
    if (video && participant.videoStream) {
      video.srcObject = participant.videoStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile video play error:", err);
        }
      });
    }
  }, [participant.videoStream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && participant.audioStream) {
      audio.srcObject = participant.audioStream;
      audio.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile audio play error:", err);
        }
      });

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
    }
  }, [participant.audioStream, audioOutputDeviceId]);

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

  const speakerRing = isActiveSpeaker
    ? "ring-2 ring-[#F95F4A] ring-offset-2 ring-offset-[#1a1a1a]"
    : "";

  return (
    <div
      className={`relative bg-[#252525] rounded-xl overflow-hidden ${sizeClasses[size]} ${speakerRing}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${showPlaceholder ? "hidden" : ""}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
          <div
            className={`rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold ${avatarSizes[size]}`}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
          <Ghost className="w-8 h-8 text-[#FF007A] drop-shadow-[0_0_15px_rgba(255,0,122,0.5)]" />
        </div>
      )}
      {participant.isHandRaised && (
        <div className="absolute top-1.5 left-1.5 p-1 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300">
          <Hand className="w-3 h-3" />
        </div>
      )}
      <audio ref={audioRef} autoPlay />
      {size !== "small" && (
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between">
          <div className="bg-black/70 backdrop-blur-sm rounded-full px-2 py-0.5 flex items-center gap-1.5 max-w-[80%]">
            <span className="text-[10px] text-[#FEFCD9] font-medium truncate uppercase tracking-wide">
              {displayName}
            </span>
            {participant.isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A] shrink-0" />}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(MobileParticipantVideo);
