"use client";

import { Ghost, Hand } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import type { Participant } from "../types";
import { getSpeakerHighlightClasses } from "../utils";
import ParticipantVideo from "./ParticipantVideo";

interface PresentationLayoutProps {
  presentationStream: MediaStream;
  presenterName: string;
  localStream: MediaStream | null;
  isCameraOff: boolean;
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

function PresentationLayout({
  presentationStream,
  presenterName,
  localStream,
  isCameraOff,
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
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Presentation local video play error:", err);
        }
      });
    }
  }, [localStream]);

  return (
    <div className="flex flex-1 gap-4 overflow-hidden">
      <div className="flex-1 bg-[#252525] border border-white/5 rounded-lg overflow-hidden relative flex items-center justify-center">
        <video
          ref={(el) => {
            if (el && presentationStream) el.srcObject = presentationStream;
          }}
          autoPlay
          playsInline
          className="max-w-full max-h-full"
        />
        <div
          className="absolute top-2 left-2 bg-black/40 px-2 py-1 rounded text-white text-sm tracking-[0.5px]"
          style={{ fontWeight: 500 }}
        >
          {presenterName} is presenting
        </div>
      </div>

      <div className="w-64 flex flex-col gap-3 overflow-y-auto pr-1">
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
            <div className="absolute inset-0 flex items-center justify-center bg-[#252525]">
              <div className="w-10 h-10 rounded-full bg-[#333] border border-white/10 flex items-center justify-center text-lg">
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
              className="absolute top-2 left-2 p-1.5 rounded-full bg-amber-500/20 border border-amber-400/30 text-amber-300"
              title="Hand raised"
            >
              <Hand className="w-4 h-4" />
            </div>
          )}
          <div
            className="absolute bottom-1 left-1 px-1 py-0.5 bg-black/60 border border-white/5 rounded text-xs"
            style={{ fontWeight: 500 }}
          >
            You
          </div>
        </div>

        {Array.from(participants.values()).map((participant) => (
          <ParticipantVideo
            key={participant.userId}
            participant={participant}
            displayName={getDisplayName(participant.userId)}
            isActiveSpeaker={activeSpeakerId === participant.userId}
            compact
            audioOutputDeviceId={audioOutputDeviceId}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(PresentationLayout);
