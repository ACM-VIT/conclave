"use client";

import { Ghost, Hand, MicOff } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Participant } from "../types";
import { getSpeakerHighlightClasses } from "../utils";
import ParticipantVideo from "./ParticipantVideo";

interface GridLayoutProps {
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isGhost: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  isAdmin?: boolean;
  selectedParticipantId?: string | null;
  onParticipantClick?: (userId: string) => void;
  getDisplayName: (userId: string) => string;
}

export default function GridLayout({
  localStream,
  isCameraOff,
  isMuted,
  isHandRaised,
  isGhost,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  currentUserId,
  audioOutputDeviceId,
  isAdmin = false,
  selectedParticipantId,
  onParticipantClick,
  getDisplayName,
}: GridLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Grid local video play error:", err);
        }
      });
    }
  }, [localStream]);

  const totalParticipants = participants.size + 1;

  const getGridLayout = (count: number) => {
    if (count === 1) return "grid-cols-1 grid-rows-1";
    if (count === 2) return "grid-cols-2 grid-rows-1";
    if (count === 3) return "grid-cols-3 grid-rows-1";
    if (count === 4) return "grid-cols-2 grid-rows-2";
    if (count <= 6) return "grid-cols-3 grid-rows-2";
    if (count <= 9) return "grid-cols-3 grid-rows-3";
    if (count <= 12) return "grid-cols-4 grid-rows-3";
    if (count <= 16) return "grid-cols-4 grid-rows-4";
    return "grid-cols-5 grid-rows-4";
  };

  const gridClass = getGridLayout(totalParticipants);

  return (
    <div className={`flex-1 grid ${gridClass} gap-3 overflow-auto p-2`}>
      <div
        className={`relative bg-[#111] border border-white/10 rounded-lg overflow-hidden transition-all duration-200 ${getSpeakerHighlightClasses(
          isLocalActiveSpeaker
        )}`}
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className={`w-full h-full object-cover ${
            isCameraOff ? "hidden" : ""
          } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
        />
        {isCameraOff && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#252525]">
            <div className="w-16 h-16 rounded-full bg-[#333] border border-white/10 flex items-center justify-center text-xl">
              {userEmail[0]?.toUpperCase() || "?"}
            </div>
          </div>
        )}
        {isGhost && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-2">
              <Ghost className="w-16 h-16 text-blue-300 drop-shadow-[0_0_22px_rgba(59,130,246,0.5)]" />
              <span className="text-xs text-blue-200/90 bg-black/60 border border-blue-400/30 px-2 py-0.5 rounded-full">
                Ghost
              </span>
            </div>
          </div>
        )}
        {isHandRaised && (
          <div
            className="absolute top-2 left-2 p-1.5 rounded-full bg-amber-500/20 border border-amber-400/30 text-amber-300"
            title="Hand raised"
          >
            <Hand className="w-4 h-4" />
          </div>
        )}
        <div
          className="absolute bottom-2 left-2 px-2 py-0.5 bg-black/60 border border-white/5 rounded text-sm flex items-center gap-2"
          style={{ fontWeight: 500 }}
        >
          You {isMuted && <MicOff className="w-3 h-3 text-red-500" />}
        </div>
      </div>

      {Array.from(participants.values()).map((participant) => (
        <ParticipantVideo
          key={participant.userId}
          participant={participant}
          displayName={getDisplayName(participant.userId)}
          isActiveSpeaker={activeSpeakerId === participant.userId}
          audioOutputDeviceId={audioOutputDeviceId}
          isAdmin={isAdmin}
          isSelected={selectedParticipantId === participant.userId}
          onAdminClick={onParticipantClick}
        />
      ))}
    </div>
  );
}
