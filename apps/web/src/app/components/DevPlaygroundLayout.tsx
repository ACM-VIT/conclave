"use client";

import { errorName } from "../lib/utils";
import { Hand } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { DevPlaygroundWebApp } from "@conclave/apps-sdk/dev-playground/web";
import { Avatar } from "@conclave/ui-tokens/web";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { getSpeakerHighlightClasses, isSystemUserId } from "../lib/utils";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import ParticipantVideo from "./ParticipantVideo";

interface DevPlaygroundLayoutProps {
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

function DevPlaygroundLayout({
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
}: DevPlaygroundLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

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
      if (errorName(err) !== "AbortError") {
        console.error("[Meets] Dev playground local video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [localStream]);

  const participantsList = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        !isSystemUserId(participant.userId) &&
        participant.userId !== currentUserId &&
        isRemoteParticipantVisible(participant, isGhost, currentUserId),
    ),
    activeSpeakerId
  );

  return (
    <div className="mt-5 flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <DevPlaygroundWebApp />
      </div>
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
        {!isGhost && (
          <div
            className={`relative bg-[#232327] border border-white/5 rounded-lg overflow-hidden h-36 shrink-0 transition-all duration-200 ${getSpeakerHighlightClasses(
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
              <div className="absolute inset-0 flex items-center justify-center bg-[#18181b]">
                <Avatar id={userEmail} name={userEmail} size={48} />
              </div>
            )}
            {isHandRaised && (
              <div
                className="absolute top-3 left-3 p-1.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300"
                title="Hand raised"
              >
                <Hand className="w-3 h-3" />
              </div>
            )}
            <div
              className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-[#fafafa]/10 rounded-full px-3 py-1.5 flex items-center gap-2 text-[10px]"
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <span className="font-medium text-[#fafafa] uppercase tracking-wide">
                You
              </span>
              {isMuted ? <span className="text-[#F95F4A]">Muted</span> : null}
            </div>
          </div>
        )}

        {participantsList.map((participant) => (
          <ParticipantVideo
            key={participant.userId}
            participant={participant}
            displayName={getDisplayName(participant.userId)}
            isActiveSpeaker={activeSpeakerId === participant.userId}
            compact
            audioOutputDeviceId={audioOutputDeviceId}
          />
        ))}
      </aside>
    </div>
  );
}

export default memo(DevPlaygroundLayout);
