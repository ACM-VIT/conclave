"use client";

import { memo } from "react";
import { DevPlaygroundWebApp } from "@conclave/apps-sdk/dev-playground/web";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import ParticipantVideo from "./ParticipantVideo";
import RailLocalTile from "./RailLocalTile";

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
    <div className="mt-5 flex flex-1 min-h-0 min-w-0 gap-4 overflow-hidden">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <DevPlaygroundWebApp />
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

export default memo(DevPlaygroundLayout);
