"use client";

import { Hand, MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useSmartParticipantOrder } from "../../hooks/useSmartParticipantOrder";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";

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

  const participantArray = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) => !isSystemUserId(participant.userId)
    ),
    activeSpeakerId
  );
  const totalCount = participantArray.length + 1;
  const localDisplayName = truncateDisplayName(
    getDisplayName(currentUserId) || userEmail || "You",
    totalCount <= 2 ? 16 : totalCount <= 4 ? 12 : 10
  );

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
    isActive ? "mobile-tile-active" : "";
  const maxLabelLength = totalCount <= 2 ? 16 : totalCount <= 4 ? 12 : 10;

  return (
    <div className={`w-full h-full grid ${getGridClass()} gap-3 p-3 auto-rows-fr`}>
      {/* Local video tile */}
      <div
        className={`mobile-tile ${speakerRing(isLocalActiveSpeaker)}`}
      >
        <video
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
        />
        {isCameraOff && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
            <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
            <div
              className={`relative rounded-full mobile-avatar flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}
              style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
            >
              {userEmail[0]?.toUpperCase() || "?"}
            </div>
          </div>
        )}
        {isGhost && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
            <div className="flex flex-col items-center gap-2">
              <VenetianMask
                className={`text-[#FF007A] ${totalCount <= 2 ? "w-10 h-10" : "w-8 h-8"}`}
              />
              <span
                className="mobile-ghost-badge rounded-full px-3 py-1 text-[10px] tracking-[0.25em] text-[#FF007A]"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                GHOST
              </span>
            </div>
          </div>
        )}
        {isHandRaised && (
          <div className="absolute top-2 left-2 p-2 rounded-full mobile-hand-badge text-amber-200">
            <Hand className="w-3.5 h-3.5" />
          </div>
        )}
        {/* Name label */}
        <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
          <div 
            className="mobile-name-pill px-2.5 py-1 flex items-center gap-2 backdrop-blur-md"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            <span className={`text-[#FEFCD9] font-medium uppercase tracking-[0.18em] truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
              {localDisplayName}
            </span>
            <span className="text-[9px] uppercase tracking-[0.25em] text-[#F95F4A]/70">
              YOU
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
          displayName={truncateDisplayName(
            getDisplayName(participant.userId),
            maxLabelLength
          )}
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
      video.play().catch(() => {});
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
      audio.play().catch(() => {});
    };

    playAudio();

    const audioTrack = participant.audioStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.addEventListener("unmute", playAudio);

    return () => {
      audioTrack.removeEventListener("unmute", playAudio);
    };
  }, [participant.audioStream, participant.audioProducerId, participant.isMuted]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;
  const speakerRing = isActiveSpeaker ? "mobile-tile-active" : "";

  return (
    <div
      className={`mobile-tile ${speakerRing}`}
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
            className={`relative rounded-full mobile-avatar flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
          <div className="flex flex-col items-center gap-2">
            <VenetianMask
              className={`text-[#FF007A] ${totalCount <= 2 ? "w-10 h-10" : "w-8 h-8"}`}
            />
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
      {/* Name label */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
        <div 
          className="mobile-name-pill px-2.5 py-1 flex items-center gap-2 max-w-full backdrop-blur-md"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <span className={`text-[#FEFCD9] font-medium uppercase tracking-[0.18em] truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
            {displayName}
          </span>
          {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
        </div>
      </div>
    </div>
  );
});

export default memo(MobileGridLayout);
