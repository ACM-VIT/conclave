"use client";

import { Ghost, Hand, Info, MicOff } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Participant } from "../types";
import { getSpeakerHighlightClasses } from "../utils";

interface ParticipantVideoProps {
  participant: Participant;
  displayName: string;
  compact?: boolean;
  isActiveSpeaker?: boolean;
  audioOutputDeviceId?: string;
  isAdmin?: boolean;
  isSelected?: boolean;
  onAdminClick?: (userId: string) => void;
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
}: ParticipantVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isNew, setIsNew] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setIsNew(false), 800);
    return () => clearTimeout(timer);
  }, []);

  const setVideoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && participant.videoStream) {
        node.srcObject = participant.videoStream;
        node.play().catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[Meets] Video play error:", err);
          }
        });
      }
      videoRef.current = node;
    },
    [participant.videoStream]
  );

  const setAudioRef = useCallback(
    (node: HTMLAudioElement | null) => {
      if (node && participant.audioStream) {
        node.srcObject = participant.audioStream;
        node.play().catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[Meets] Audio play error:", err);
          }
        });

        if (audioOutputDeviceId) {
          const audioElement = node as HTMLAudioElement & {
            setSinkId?: (sinkId: string) => Promise<void>;
          };
          if (audioElement.setSinkId) {
            audioElement.setSinkId(audioOutputDeviceId).catch((err) => {
              console.error("[Meets] Failed to set audio output:", err);
            });
          }
        }
      }
      audioRef.current = node;
    },
    [participant.audioStream, audioOutputDeviceId]
  );

  useEffect(() => {
    if (audioRef.current && audioOutputDeviceId) {
      const audioElement = audioRef.current as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (audioElement.setSinkId) {
        audioElement.setSinkId(audioOutputDeviceId).catch((err) => {
          console.error("[Meets] Failed to update audio output:", err);
        });
      }
    }
  }, [audioOutputDeviceId]);

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
        ref={setVideoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${
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
      <audio ref={setAudioRef} autoPlay />
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
        className={`absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-[#FEFCD9]/10 rounded-full px-3 py-1.5 flex items-center gap-2 ${
          compact ? "text-[10px]" : "text-xs"
        }`}
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        <span className="font-medium text-[#FEFCD9] uppercase tracking-wide">{displayName}</span>
        {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A]" />}
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
