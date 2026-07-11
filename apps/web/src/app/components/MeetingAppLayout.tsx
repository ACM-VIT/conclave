"use client";

import { memo, type ComponentType } from "react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import ParticipantVideo from "./ParticipantVideo";
import RailLocalTile from "./RailLocalTile";

interface MeetingAppLayoutProps {
  app: ComponentType;
  frameContent?: boolean;
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  getDisplayName: (userId: string) => string;
}

function MeetingAppLayout({
  app: App,
  frameContent = true,
  localStream,
  isCameraOff,
  isMuted,
  isHandRaised,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  currentUserId,
  audioOutputDeviceId,
  getDisplayName,
}: MeetingAppLayoutProps) {
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  const participantsList = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        !isSystemUserId(participant.userId) &&
        participant.userId !== currentUserId,
    ),
    activeSpeakerId
  );

  return (
    <div className="mt-5 flex min-h-0 min-w-0 flex-1 gap-4 overflow-hidden">
      <div
        className={
          frameContent
            ? "min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b0b] shadow-[0_20px_60px_rgba(0,0,0,0.4)]"
            : "min-h-0 min-w-0 flex-1 overflow-hidden"
        }
      >
        <App />
      </div>
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-3 overflow-y-auto overflow-x-visible px-1">
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

export default memo(MeetingAppLayout);
