"use client";

import { Ghost, Hand, MicOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { Participant } from "../../types";

interface MobileGridLayoutProps {
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
  getDisplayName: (userId: string) => string;
}

function MobileGridLayout({
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
  getDisplayName,
}: MobileGridLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile grid local video play error:", err);
        }
      });
    }
  }, [localStream]);

  const participantArray = Array.from(participants.values());
  const totalCount = participantArray.length + 1;

  // Determine grid layout based on participant count
  const getGridClass = () => {
    if (totalCount === 1) return "grid-cols-1 grid-rows-1";
    if (totalCount === 2) return "grid-cols-1 grid-rows-2";
    if (totalCount <= 4) return "grid-cols-2 grid-rows-2";
    if (totalCount <= 6) return "grid-cols-2 grid-rows-3";
    if (totalCount <= 9) return "grid-cols-3 grid-rows-3";
    return "grid-cols-3 auto-rows-fr"; // 10+ participants
  };

  const speakerRing = (isActive: boolean) =>
    isActive ? "ring-2 ring-[#F95F4A]" : "";

  return (
    <div className={`w-full h-full grid ${getGridClass()} gap-1.5 p-2 auto-rows-fr`}>
      {/* Local video tile */}
      <div
        className={`relative bg-[#1a1a1a] rounded-xl overflow-hidden ${speakerRing(isLocalActiveSpeaker)}`}
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
        />
        {isCameraOff && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#252525] to-[#1a1a1a]">
            <div className={`rounded-full bg-gradient-to-br from-[#F95F4A]/30 to-[#FF007A]/30 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}>
              {userEmail[0]?.toUpperCase() || "?"}
            </div>
          </div>
        )}
        {isGhost && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
            <Ghost className={`text-[#FF007A] drop-shadow-[0_0_15px_rgba(255,0,122,0.5)] ${totalCount <= 2 ? "w-12 h-12" : "w-8 h-8"}`} />
          </div>
        )}
        {isHandRaised && (
          <div className="absolute top-2 left-2 p-1.5 rounded-full bg-amber-500/30 border border-amber-400/50 text-amber-300">
            <Hand className="w-4 h-4" />
          </div>
        )}
        {/* Name label */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
          <div className="bg-black/80 backdrop-blur-sm rounded-lg px-2 py-1 flex items-center gap-1.5">
            <span className={`text-[#FEFCD9] font-medium truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
              You
            </span>
            {isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
          </div>
        </div>
      </div>

      {/* Participant tiles */}
      {participantArray.map((participant) => (
        <ParticipantTile
          key={participant.userId}
          participant={participant}
          displayName={getDisplayName(participant.userId)}
          isActiveSpeaker={activeSpeakerId === participant.userId}
          totalCount={totalCount}
        />
      ))}
    </div>
  );
}

// Separate component for participant tiles
const ParticipantTile = memo(function ParticipantTile({
  participant,
  displayName,
  isActiveSpeaker,
  totalCount,
}: {
  participant: Participant;
  displayName: string;
  isActiveSpeaker: boolean;
  totalCount: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video && participant.videoStream) {
      video.srcObject = participant.videoStream;
      video.play().catch(() => {});
    }
  }, [participant.videoStream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio && participant.audioStream) {
      audio.srcObject = participant.audioStream;
      audio.play().catch(() => {});
    }
  }, [participant.audioStream]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;
  const speakerRing = isActiveSpeaker ? "ring-2 ring-[#F95F4A]" : "";

  return (
    <div
      className={`relative bg-[#1a1a1a] rounded-xl overflow-hidden ${speakerRing}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${showPlaceholder ? "hidden" : ""}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#252525] to-[#1a1a1a]">
          <div className={`rounded-full bg-gradient-to-br from-[#F95F4A]/30 to-[#FF007A]/30 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}>
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
          <Ghost className={`text-[#FF007A] drop-shadow-[0_0_15px_rgba(255,0,122,0.5)] ${totalCount <= 2 ? "w-12 h-12" : "w-8 h-8"}`} />
        </div>
      )}
      {participant.isHandRaised && (
        <div className="absolute top-2 left-2 p-1.5 rounded-full bg-amber-500/30 border border-amber-400/50 text-amber-300">
          <Hand className="w-4 h-4" />
        </div>
      )}
      <audio ref={audioRef} autoPlay />
      {/* Name label */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
        <div className="bg-black/80 backdrop-blur-sm rounded-lg px-2 py-1 flex items-center gap-1.5 max-w-full">
          <span className={`text-[#FEFCD9] font-medium truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
            {displayName}
          </span>
          {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
        </div>
      </div>
    </div>
  );
});

export default memo(MobileGridLayout);
