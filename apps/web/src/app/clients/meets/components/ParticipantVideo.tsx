"use client";

import { Ghost, Hand, Info, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export default function ParticipantVideo({
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

  return (
    <div
      onClick={handleClick}
      className={`relative bg-[#111] border rounded-lg overflow-hidden ${
        compact ? "h-36 shrink-0" : "w-full h-full"
      } ${
        isNew
          ? "animate-participant-join"
          : participant.isLeaving
          ? "animate-participant-leave"
          : ""
      } transition-all duration-200 ${getSpeakerHighlightClasses(
        isActiveSpeaker
      )} border-white/10 ${
        isAdmin && onAdminClick ? "cursor-pointer hover:border-white/20" : ""
      }`}
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
        <div className="absolute inset-0 flex items-center justify-center bg-[#252525]">
          <div
            className={`rounded-full bg-[#333] border border-white/10 flex items-center justify-center ${
              compact ? "w-10 h-10 text-lg" : "w-16 h-16 text-2xl"
            }`}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className={`flex flex-col items-center ${
              compact ? "gap-1" : "gap-2"
            }`}
          >
            <Ghost
              className={`${
                compact ? "w-10 h-10" : "w-16 h-16"
              } text-blue-300 drop-shadow-[0_0_20px_rgba(59,130,246,0.45)]`}
            />
            <span
              className={`${
                compact ? "text-[9px]" : "text-xs"
              } text-blue-200/90 bg-black/60 border border-blue-400/30 px-2 py-0.5 rounded-full`}
            >
              Ghost
            </span>
          </div>
        </div>
      )}
      <audio ref={setAudioRef} autoPlay />
      {participant.isHandRaised && (
        <div
          className={`absolute top-2 left-2 rounded-full bg-amber-500/20 border border-amber-400/30 text-amber-300 ${
            compact ? "p-1" : "p-1.5"
          }`}
          title="Hand raised"
        >
          <Hand className={compact ? "w-3 h-3" : "w-4 h-4"} />
        </div>
      )}
      <div
        className={`absolute bottom-2 left-2 bg-black/60 border border-white/5 rounded px-2 py-0.5 flex items-center gap-2 ${
          compact ? "text-[10px]" : "text-xs"
        }`}
      >
        <span style={{ fontWeight: 500 }}>{displayName}</span>
        {participant.isMuted && <MicOff className="w-3 h-3 text-red-500" />}
      </div>
      {isAdmin && onAdminClick && (
        <div className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-full transition-opacity">
          <Info className="w-4 h-4 text-white/70" />
        </div>
      )}
    </div>
  );
}
