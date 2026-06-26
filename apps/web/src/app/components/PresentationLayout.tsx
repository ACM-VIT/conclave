"use client";

import { Hand, Mic, MicOff, MonitorUp } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import { Avatar } from "@conclave/ui-tokens/web";
import { GhostParticipantOverlay } from "./GhostParticipantChrome";
import ParticipantVideo from "./ParticipantVideo";

interface PresentationLayoutProps {
  presentationStream: MediaStream;
  presenterName: string;
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

const FONT_SANS = "'PolySans Trial', system-ui, sans-serif";

function PresentationLayout({
  presentationStream,
  presenterName,
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
  getDisplayName,
}: PresentationLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const presentationVideoRef = useRef<HTMLVideoElement>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;
    if (localStream) {
      if (video.srcObject !== localStream) {
        video.srcObject = localStream;
      }
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Presentation local video play error:", err);
        }
      });
    } else if (video.srcObject) {
      video.srcObject = null;
    }
    return () => {
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [localStream]);

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
          console.error("[Meets] Presentation video play error:", err);
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

  const remoteParticipants = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        participant.userId !== currentUserId &&
        !isSystemUserId(participant.userId) &&
        isRemoteParticipantVisible(participant, isGhost, currentUserId),
    ),
    activeSpeakerId
  );

  const localDisplayName = getDisplayName(currentUserId);
  const localSpeakerHighlight = isLocalActiveSpeaker ? "speaking" : "";
  const localHandRaisedHighlight = isHandRaised ? "!border-amber-400/60" : "";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:flex-row"
      style={{ fontFamily: FONT_SANS }}
    >
      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-[#fafafa]/10 bg-[#131316]">
        <video
          ref={presentationVideoRef}
          autoPlay
          muted
          playsInline
          className="max-h-full max-w-full object-contain"
        />
        <div className="absolute left-3 top-3 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 px-3 py-1.5">
          <MonitorUp size={18} strokeWidth={1.75} className="shrink-0 text-[#F95F4A]" />
          <span className="truncate text-[13px] font-medium text-[#fafafa]">
            {presenterName} is presenting
          </span>
        </div>
      </div>

      <div className="flex h-36 w-full shrink-0 flex-row gap-3 overflow-x-auto overflow-y-visible pb-1 sm:h-auto sm:w-64 sm:flex-col sm:gap-3 sm:overflow-y-auto sm:overflow-x-visible sm:px-1 sm:pb-0">
        <div
          className={`acm-video-tile h-36 w-48 shrink-0 sm:w-auto ${localSpeakerHighlight} ${localHandRaisedHighlight}`}
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`h-full w-full object-cover ${
              isCameraOff ? "hidden" : ""
            } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
          />
          {isCameraOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#18181b]">
              <Avatar id={userEmail} name={localDisplayName || userEmail} size={48} />
            </div>
          )}
          {isGhost && <GhostParticipantOverlay compact label="Ghost mode" />}
          {isHandRaised && (
            <div
              className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300"
              title="Hand raised"
              aria-label="Hand raised"
            >
              <Hand size={18} strokeWidth={1.75} />
            </div>
          )}
          <div className="absolute bottom-3 left-3 flex max-w-[80%] items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 px-3 py-1.5">
            <span className="truncate text-[13px] font-medium text-[#fafafa]">
              {localDisplayName}
            </span>
            <span className="text-[11px] font-medium text-[#F95F4A]">You</span>
            {isLocalActiveSpeaker && !isMuted ? (
              <span className="acm-voice-activity" aria-label="Speaking">
                <span />
                <span />
                <span />
              </span>
            ) : null}
            {isMuted ? (
              <MicOff size={14} strokeWidth={1.75} className="shrink-0 text-[#F95F4A]" />
            ) : (
              <Mic size={14} strokeWidth={1.75} className="shrink-0 text-[#22c55e]" />
            )}
          </div>
        </div>

        {remoteParticipants.map((participant) => (
          <ParticipantVideo
            key={participant.userId}
            participant={participant}
            displayName={getDisplayName(participant.userId)}
            isActiveSpeaker={activeSpeakerId === participant.userId}
            compact
            // The grid stays mounted alongside this layout (opacity crossfade)
            // and owns remote audio via its hidden ParticipantAudio list, so the
            // filmstrip must NOT also play it — otherwise every remote doubles.
            disableAudio
            audioOutputDeviceId={audioOutputDeviceId}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(PresentationLayout);
