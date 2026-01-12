"use client";

import { Ghost, MicOff } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { Participant } from "../../types";

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

  const participantArray = Array.from(participants.values());

  return (
    <div className="flex flex-col w-full h-full p-2 gap-2">
      {/* Presentation video - takes most space */}
      <div className="flex-1 relative bg-black rounded-xl overflow-hidden min-h-0">
        <video
          ref={presentationVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-contain"
        />
        {/* Presenter badge */}
        <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-full text-[10px] text-[#FEFCD9] font-medium uppercase tracking-wide border border-[#FEFCD9]/10">
          {presenterName} is presenting
        </div>
      </div>

      {/* Participant thumbnails - fixed height strip */}
      <div className="h-24 shrink-0 flex gap-2 overflow-x-auto no-scrollbar">
        {/* Local video thumbnail */}
        <div className="relative w-24 h-24 shrink-0 bg-[#1a1a1a] rounded-xl overflow-hidden border border-[#FEFCD9]/10">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
          />
          {isCameraOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#252525] to-[#1a1a1a]">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/30 to-[#FF007A]/30 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                {userEmail[0]?.toUpperCase() || "?"}
              </div>
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
              <Ghost className="w-6 h-6 text-[#FF007A]" />
            </div>
          )}
          <div className="absolute bottom-1 left-1 right-1 flex items-center justify-center">
            <span className="bg-black/80 rounded-lg px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium flex items-center gap-1">
              You
              {isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
            </span>
          </div>
        </div>

        {/* Other participants - thumbnails with audio */}
        {participantArray.map((participant) => (
          <div 
            key={participant.userId} 
            className="relative w-24 h-24 shrink-0 bg-[#1a1a1a] rounded-xl overflow-hidden border border-[#FEFCD9]/10"
          >
            {participant.videoStream && !participant.isCameraOff ? (
              <VideoThumbnail participant={participant} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#252525] to-[#1a1a1a]">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/30 to-[#FF007A]/30 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                  {getDisplayName(participant.userId)[0]?.toUpperCase() || "?"}
                </div>
              </div>
            )}
            {participant.isGhost && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/50">
                <Ghost className="w-6 h-6 text-[#FF007A]" />
              </div>
            )}
            <div className="absolute bottom-1 left-1 right-1 flex items-center justify-center">
              <span className="bg-black/80 rounded-lg px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium truncate max-w-full flex items-center gap-1">
                {getDisplayName(participant.userId).split(" ")[0]}
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

// Separate video thumbnail component for participants
const VideoThumbnail = memo(function VideoThumbnail({ participant }: { participant: Participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useEffect(() => {
    const video = videoRef.current;
    if (video && participant.videoStream) {
      video.srcObject = participant.videoStream;
      video.play().catch(() => {});
    }
  }, [participant.videoStream]);
  
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
