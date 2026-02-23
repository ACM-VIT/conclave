"use client";

import { Ghost, Hand, Mic, MicOff } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import {
  getSpeakerHighlightClasses,
  isSystemUserId,
  reorderOverflowActiveSpeakers,
} from "../lib/utils";
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
  const overflowSpeakerHistoryRef = useRef<string[]>([]);
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

  useEffect(() => {
    const video = presentationVideoRef.current;
    if (video && presentationStream) {
      if (video.srcObject !== presentationStream) {
        video.srcObject = presentationStream;
        video.play().catch((err) => {
          if (err.name !== "AbortError") {
            console.error("[Meets] Presentation video play error:", err);
          }
        });
      }
    }
  }, [presentationStream]);

  const participantArray = Array.from(participants.values()).filter(
    (participant) =>
      !isSystemUserId(participant.userId) && participant.userId !== currentUserId
  );
  const smartOrderedParticipants = useSmartParticipantOrder(
    participantArray,
    activeSpeakerId
  );
  const remoteParticipants = useMemo(() => {
    const { orderedParticipants, nextOverflowSpeakerHistory } =
      reorderOverflowActiveSpeakers(
        participantArray,
        smartOrderedParticipants,
        activeSpeakerId,
        currentUserId,
        overflowSpeakerHistoryRef.current
      );
    overflowSpeakerHistoryRef.current = nextOverflowSpeakerHistory;
    return orderedParticipants;
  }, [activeSpeakerId, currentUserId, participantArray, smartOrderedParticipants]);

  return (
    <div className="flex flex-1 gap-4 overflow-hidden mt-5">
      <div className="flex-1 bg-[#252525] border border-white/5 rounded-lg overflow-hidden relative flex items-center justify-center">
        <video
          ref={presentationVideoRef}
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

      <div className="w-64 flex flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
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
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""
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
            <span className="font-medium text-[#FEFCD9] uppercase tracking-wide">You</span>
            {isMuted ? (
              <MicOff className="w-3 h-3 text-[#F95F4A]" />
            ) : (
              <Mic className="w-3 h-3 text-emerald-300" />
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
              audioOutputDeviceId={audioOutputDeviceId}
            />
          ))}
      </div>
    </div>
  );
}

export default memo(PresentationLayout);
