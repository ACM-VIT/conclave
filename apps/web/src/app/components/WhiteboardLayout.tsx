"use client";

import { Ghost, Hand } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { WhiteboardWebApp } from "@conclave/apps-sdk/whiteboard/web";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { getSpeakerHighlightClasses, isSystemUserId } from "../lib/utils";
import ParticipantVideo from "./ParticipantVideo";

interface WhiteboardLayoutProps {
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

function WhiteboardLayout({
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
}: WhiteboardLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Whiteboard local video play error:", err);
        }
      });
    }
  }, [localStream]);

  const participantsList = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        !isSystemUserId(participant.userId) &&
        participant.userId !== currentUserId
    ),
    activeSpeakerId
  );

  return (
    <div className="flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden mt-5">
      <div className="flex-1 min-h-0 min-w-0 rounded-2xl border border-white/10 bg-[#0b0b0b] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.4)] overflow-hidden">
        <WhiteboardWebApp />
      </div>
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
        <div
          className={`relative bg-[#252525] border border-white/5 rounded-lg overflow-hidden h-36 shrink-0 transition-all duration-200 ${getSpeakerHighlightClasses(
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
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-lg text-[#FEFCD9] font-bold">
                {userEmail[0]?.toUpperCase() || "?"}
              </div>
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-1.5">
                <Ghost className="w-12 h-12 text-blue-300 drop-shadow-[0_0_18px_rgba(59,130,246,0.45)]" />
                <span className="text-[10px] text-blue-200/90 bg-black/60 border border-blue-400/30 px-2 py-0.5 rounded-full">
                  Ghost
                </span>
              </div>
            </div>
          )}
          {isHandRaised && (
            <div
              className="absolute top-3 left-3 p-1.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
              title="Hand raised"
            >
              <Hand className="w-3 h-3" />
            </div>
          )}
          <div
            className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-sm border border-[#FEFCD9]/10 rounded-full px-3 py-1.5 flex items-center gap-2 text-[10px]"
            style={{ fontFamily: "'PolySans Mono', monospace" }}
          >
            <span className="font-medium text-[#FEFCD9] uppercase tracking-wide">
              You
            </span>
            {isMuted ? <span className="text-[#F95F4A]">Muted</span> : null}
          </div>
        </div>

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

export default memo(WhiteboardLayout);
