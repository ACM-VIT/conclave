"use client";

import { memo } from "react";
import { WhiteboardWebApp } from "@conclave/apps-sdk/whiteboard/web";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import ParticipantVideo from "./ParticipantVideo";
import RailLocalTile from "./RailLocalTile";

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
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

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
    <div className="flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden mt-5">
      <div className="flex-1 min-h-0 min-w-0 rounded-2xl border border-white/10 bg-[#0b0b0b] shadow-[0_20px_60px_rgba(0,0,0,0.4)] overflow-hidden">
        <WhiteboardWebApp />
      </div>
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
        {!isGhost && (
          <RailLocalTile
            stream={localStream}
            isCameraOff={isCameraOff}
            isMuted={isMuted}
            isHandRaised={isHandRaised}
            isMirrorCamera={isMirrorCamera}
            isActiveSpeaker={isLocalActiveSpeaker}
            displayName={getDisplayName(currentUserId)}
            userEmail={userEmail}
          />
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

export default memo(WhiteboardLayout);
