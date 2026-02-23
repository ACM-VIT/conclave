"use client";

import { MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useSmartParticipantOrder } from "../../hooks/useSmartParticipantOrder";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";

interface MobilePresentationLayoutProps {
  presentationStream: MediaStream;
  presenterName: string;
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isGhost: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  getDisplayName: (userId: string) => string;
}

function MobilePresentationLayout({
  presentationStream,
  presenterName,
  localStream,
  isCameraOff,
  isMuted,
  isGhost,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  getDisplayName,
}: MobilePresentationLayoutProps) {
  const presentationVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = presentationVideoRef.current;
    if (video && presentationStream) {
      if (video.srcObject !== presentationStream) {
        video.srcObject = presentationStream;
        video.play().catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[Meets] Mobile presentation video play error:", err);
          }
        });
      }
    }
  }, [presentationStream]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile presentation local video play error:", err);
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

  return (
    <div className="flex flex-col w-full h-full p-3 gap-3">
      {/* Presentation video - takes most space */}
      <div className="flex-1 relative mobile-tile min-h-0 bg-[#0b0b0b]">
        <video
          ref={presentationVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-contain"
        />
        {/* Presenter badge */}
        <div
          className="absolute top-2 left-2 mobile-name-pill px-3 py-1 text-[10px] text-[#FEFCD9] font-medium uppercase tracking-[0.18em] backdrop-blur-md truncate max-w-[80%]"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
          title={`${presenterName} is presenting`}
        >
          {presenterName} is presenting
        </div>
      </div>

      {/* Participant thumbnails - fixed height strip */}
      <div className="h-24 shrink-0 flex gap-3 overflow-x-auto no-scrollbar touch-pan-x">
        {/* Local video thumbnail */}
        <div className="relative w-24 h-24 shrink-0 mobile-tile">
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
                className="relative w-10 h-10 rounded-full mobile-avatar flex items-center justify-center text-lg text-[#FEFCD9] font-bold"
                style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
              >
                {userEmail[0]?.toUpperCase() || "?"}
              </div>
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
              <div className="flex flex-col items-center gap-1">
                <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                <span
                  className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[8px] tracking-[0.2em] text-[#FF007A]"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  GHOST
                </span>
              </div>
            </div>
          )}
          <div 
            className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium uppercase tracking-[0.18em] flex items-center gap-1 backdrop-blur-md">
              YOU
              {isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
            </span>
          </div>
        </div>

        {/* Other participants - thumbnails with audio */}
        {participantArray.map((participant) => (
          <div 
            key={participant.userId} 
            className={`relative w-24 h-24 shrink-0 mobile-tile ${
              participant.userId === activeSpeakerId
                ? "mobile-tile-active"
                : ""
            }`}
          >
            {participant.videoStream && !participant.isCameraOff ? (
              <VideoThumbnail
                participant={participant}
                isCameraOff={participant.isCameraOff}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
                <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
                <div
                  className="relative w-10 h-10 rounded-full mobile-avatar flex items-center justify-center text-lg text-[#FEFCD9] font-bold"
                  style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
                >
                  {getDisplayName(participant.userId)[0]?.toUpperCase() || "?"}
                </div>
              </div>
            )}
            {participant.isGhost && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
                <div className="flex flex-col items-center gap-1">
                  <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                  <span
                    className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[8px] tracking-[0.2em] text-[#FF007A]"
                    style={{ fontFamily: "'PolySans Mono', monospace" }}
                  >
                    GHOST
                  </span>
                </div>
              </div>
            )}
            <div 
              className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium uppercase tracking-[0.18em] truncate max-w-full flex items-center gap-1 backdrop-blur-md">
                {truncateDisplayName(getDisplayName(participant.userId), 10)}
                {participant.isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
              </span>
            </div>
            {/* Audio element for participant */}
            {participant.audioStream && (
              <AudioPlayer stream={participant.audioStream} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const VideoThumbnail = memo(function VideoThumbnail({
  participant,
  isCameraOff,
}: {
  participant: Participant;
  isCameraOff: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!participant.videoStream || isCameraOff) {
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
  }, [participant.videoStream, participant.videoProducerId, isCameraOff]);
  
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="w-full h-full object-cover"
    />
  );
});

// Separate audio player component
const AudioPlayer = memo(function AudioPlayer({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && stream) {
      audio.srcObject = stream;
      audio.play().catch(() => {});
    }
  }, [stream]);
  
  return <audio ref={audioRef} autoPlay />;
});

export default memo(MobilePresentationLayout);
