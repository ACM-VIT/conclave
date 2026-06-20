"use client";

import { MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { Avatar } from "@conclave/ui-tokens/web";
import { useMeetVolume } from "../../hooks/useMeetVolume";
import { useSmartParticipantOrder } from "../../hooks/useSmartParticipantOrder";
import { getRenderableParticipantVideoStream } from "../../lib/participant-media";
import { createPlaybackRecoveryScheduler } from "../../lib/playback-recovery";
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
  currentUserId,
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

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;

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
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      playbackRecovery.clear();
      if (video.srcObject === presentationStream) {
        video.srcObject = null;
      }
    };
  }, [presentationStream]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;

    if (!localStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    video.srcObject = localStream;
    video.play().catch((err) => {
      if (err.name !== "AbortError") {
        console.error("[Meets] Mobile presentation local video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [localStream]);

  const participantArray = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        participant.userId !== currentUserId &&
        !isSystemUserId(participant.userId)
    ),
    activeSpeakerId
  );

  return (
    <div className="flex flex-col w-full h-full p-3 gap-3">
      <div className="flex-1 relative mobile-tile min-h-0 bg-[#0b0b0b]">
        <video
          ref={presentationVideoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-contain"
        />
        <div
          className="absolute top-2 left-2 mobile-name-pill px-3 py-1 text-[12px] text-[#fafafa] font-medium truncate max-w-[80%]"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          title={`${presenterName} is presenting`}
        >
          {presenterName} is presenting
        </div>
      </div>

      <div className="relative h-24 shrink-0">
        <div className="absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#0a0a0b] to-transparent z-10 pointer-events-none rounded-r-2xl" />
        <div className="h-full flex gap-3 overflow-x-scroll no-scrollbar snap-x snap-mandatory scroll-smooth pr-3">
        <div
          className={`relative w-24 h-24 shrink-0 mobile-tile snap-start ${
            activeSpeakerId === currentUserId ? "mobile-tile-active" : ""
          }`}
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
          />
          {isCameraOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
              <div className="absolute inset-0 bg-[rgba(249,95,74,0.15)]" />
              <Avatar className="relative mobile-avatar" id={userEmail} name={userEmail} size={40} />
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
              <div className="flex flex-col items-center gap-1">
                <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                <span
                  className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[10px] font-medium text-[#FF007A]"
                  style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                >
                  Ghost
                </span>
              </div>
            </div>
          )}
          <div 
            className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#fafafa] font-medium flex items-center gap-1">
              You
              {activeSpeakerId === currentUserId && !isMuted && (
                <span className="acm-voice-activity" aria-label="Speaking">
                  <span />
                  <span />
                  <span />
                </span>
              )}
              {isMuted && <MicOff className="w-2.5 h-2.5 text-[#F95F4A]" />}
            </span>
          </div>
        </div>

        {participantArray.map((participant) => (
          <div 
            key={participant.userId} 
            className={`relative w-24 h-24 shrink-0 mobile-tile snap-start ${
              participant.userId === activeSpeakerId
                ? "mobile-tile-active"
                : ""
            }`}
          >
            {getRenderableParticipantVideoStream(participant) ? (
              <VideoThumbnail participant={participant} />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[#131316]">
                <div className="absolute inset-0 bg-[rgba(249,95,74,0.15)]" />
                <Avatar
                  className="relative mobile-avatar"
                  id={participant.userId}
                  name={getDisplayName(participant.userId)}
                  size={40}
                />
              </div>
            )}
            {participant.isGhost && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
                <div className="flex flex-col items-center gap-1">
                  <VenetianMask className="w-6 h-6 text-[#FF007A]" />
                  <span
                    className="mobile-ghost-badge rounded-full px-2 py-0.5 text-[10px] font-medium text-[#FF007A]"
                    style={{ fontFamily: "'PolySans Trial', sans-serif" }}
                  >
                    Ghost
                  </span>
                </div>
              </div>
            )}
            <div 
              className="absolute bottom-1 left-1 right-1 flex items-center justify-center"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <span className="mobile-name-pill px-1.5 py-0.5 text-[10px] text-[#fafafa] font-medium truncate max-w-full flex items-center gap-1">
                {truncateDisplayName(getDisplayName(participant.userId), 10)}
                {participant.userId === activeSpeakerId && !participant.isMuted && (
                  <span className="acm-voice-activity" aria-label="Speaking">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
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
    </div>
  );
}

const VideoThumbnail = memo(function VideoThumbnail({
  participant,
}: {
  participant: Participant;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoStream = getRenderableParticipantVideoStream(participant);
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;
  
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!videoStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== videoStream) {
      video.srcObject = videoStream;
    }

    let cancelled = false;

    const playVideo = () => {
      if (cancelled) return;
      video.play().catch(() => {});
    };

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleWindowChange = () => {
      scheduleReplay();
    };

    scheduleReplay();

    if (videoTrack) {
      videoTrack.addEventListener("unmute", scheduleReplay);
    }
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("orientationchange", handleWindowChange);

    return () => {
      cancelled = true;
      if (videoTrack) {
        videoTrack.removeEventListener("unmute", scheduleReplay);
      }
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("orientationchange", handleWindowChange);
      playbackRecovery.clear();
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [videoStream, videoTrack]);
  
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

const AudioPlayer = memo(function AudioPlayer({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { meetVolume } = useMeetVolume();
  
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && stream) {
      audio.srcObject = stream;
      audio.play().catch(() => {});
    }
    return () => {
      if (audio?.srcObject === stream) {
        audio.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = meetVolume;
  }, [meetVolume]);
  
  return <audio ref={audioRef} autoPlay />;
});

export default memo(MobilePresentationLayout);
