"use client";

import { Ghost, MicOff } from "lucide-react";
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
    if (!video || !presentationStream) return;

    if (video.srcObject !== presentationStream) {
      video.srcObject = presentationStream;
    }

    let cancelled = false;
    const replayTimeouts: number[] = [];
    let replayRafId: number | null = null;

    const playVideo = () => {
      if (cancelled) return;
      video.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
          return;
        }
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile presentation video play error:", err);
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

    const videoTrack = presentationStream.getVideoTracks()[0];
    const handleTrackUnmuted = () => {
      scheduleReplay();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
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
      for (const timeoutId of replayTimeouts) {
        window.clearTimeout(timeoutId);
      }
      if (replayRafId !== null) {
        window.cancelAnimationFrame(replayRafId);
      }
    };
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
    <div className="flex flex-col w-full h-full p-2 gap-2">
      {/* Presentation video - takes most space */}
      <div className="flex-1 relative bg-black rounded-xl overflow-hidden min-h-0">
        <video
          ref={presentationVideoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-contain"
        />
        {/* Presenter badge */}
        <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-full text-[10px] text-[#FEFCD9] font-medium uppercase tracking-wide border border-[#FEFCD9]/10">
          {presenterName} is presenting
        </div>
      </div>

      {/* Participant thumbnails - fixed height strip */}
      <div className="h-24 shrink-0 flex gap-2 overflow-x-auto no-scrollbar touch-pan-x">
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
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                {userEmail[0]?.toUpperCase() || "?"}
              </div>
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
              <Ghost className="w-6 h-6 text-[#FF007A] drop-shadow-[0_0_15px_rgba(255,0,122,0.5)]" />
            </div>
          )}
          <div 
            className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            <span className="bg-black/70 border border-[#FEFCD9]/10 rounded-full px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium uppercase tracking-wide flex items-center gap-1">
              You
              {isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
            </span>
          </div>
        </div>

        {/* Other participants - thumbnails with audio */}
        {participantArray.map((participant) => (
          <div 
            key={participant.userId} 
            className={`relative w-24 h-24 shrink-0 bg-[#1a1a1a] rounded-xl overflow-hidden border ${
              participant.userId === activeSpeakerId
                ? "border-[#F95F4A]/70 ring-1 ring-[#F95F4A]/40"
                : "border-[#FEFCD9]/10"
            }`}
          >
            {participant.videoStream && !participant.isCameraOff ? (
              <VideoThumbnail
                participant={participant}
                isCameraOff={participant.isCameraOff}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                  {getDisplayName(participant.userId)[0]?.toUpperCase() || "?"}
                </div>
              </div>
            )}
            {participant.isGhost && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
                <Ghost className="w-6 h-6 text-[#FF007A] drop-shadow-[0_0_15px_rgba(255,0,122,0.5)]" />
              </div>
            )}
            <div 
              className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <span className="bg-black/70 border border-[#FEFCD9]/10 rounded-full px-1.5 py-0.5 text-[10px] text-[#FEFCD9] font-medium uppercase tracking-wide truncate max-w-full flex items-center gap-1">
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

// Separate video thumbnail component for participants
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
