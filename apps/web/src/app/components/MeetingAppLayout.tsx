"use client";

import { memo, useMemo, type ReactNode } from "react";
import { LogOut } from "lucide-react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import LocalVideoTile from "./LocalVideoTile";
import ParticipantVideo from "./ParticipantVideo";
import {
  STAGE_RAIL_CLASS,
  STAGE_RAIL_TILE_CLASS,
  STAGE_SPLIT_CLASS,
} from "./stage-layout";

interface MeetingAppLayoutProps {
  children: ReactNode;
  stageId: string;
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
  onAudioAutoplayBlocked?: () => void;
  onAudioPlaybackStarted?: () => void;
  audioPlaybackAttemptToken?: number;
  getDisplayName: (userId: string) => string;
  leaveAction?: { label: string; hint?: string; onLeave: () => void };
}

function MeetingAppLayout({
  children,
  stageId,
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
  onAudioAutoplayBlocked,
  onAudioPlaybackStarted,
  audioPlaybackAttemptToken,
  getDisplayName,
  leaveAction,
}: MeetingAppLayoutProps) {
  const remoteParticipants = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) =>
          !isSystemUserId(participant.userId) &&
          participant.userId !== currentUserId,
      ),
    [currentUserId, participants],
  );
  const participantsList = useSmartParticipantOrder(
    remoteParticipants,
    activeSpeakerId,
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 p-4">
      <div className={STAGE_SPLIT_CLASS}>
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
          data-meet-stage-main={stageId}
        >
          {leaveAction ? (
            <div className="flex shrink-0 items-center justify-end gap-3">
              {leaveAction.hint ? (
                <span className="hidden text-[12px] text-[#a1a1aa] sm:inline">
                  {leaveAction.hint}
                </span>
              ) : null}
              <button
                type="button"
                onClick={leaveAction.onLeave}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12.5px] font-medium text-[#fafafa]/80 transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                <LogOut size={14} strokeWidth={1.75} aria-hidden="true" />
                {leaveAction.label}
              </button>
            </div>
          ) : null}
          <div
            className={
              frameContent
                ? "acm-stage-frame min-h-0 min-w-0 flex-1"
                : "relative min-h-0 min-w-0 flex-1 overflow-hidden"
            }
          >
            {children}
          </div>
        </div>
        <div className={STAGE_RAIL_CLASS} data-meet-stage-rail>
          <div className={STAGE_RAIL_TILE_CLASS} data-userid={currentUserId}>
            <LocalVideoTile
              stream={localStream}
              isCameraOff={isCameraOff}
              isMuted={isMuted}
              isHandRaised={isHandRaised}
              isMirrorCamera={isMirrorCamera}
              displayName={getDisplayName(currentUserId)}
              userEmail={userEmail}
              isActiveSpeaker={activeSpeakerId === currentUserId}
              size="rail"
            />
          </div>
          {participantsList.map((participant) => (
            <div
              key={participant.userId}
              className={STAGE_RAIL_TILE_CLASS}
              data-userid={participant.userId}
            >
              <ParticipantVideo
                participant={participant}
                displayName={getDisplayName(participant.userId)}
                isActiveSpeaker={activeSpeakerId === participant.userId}
                audioOutputDeviceId={audioOutputDeviceId}
                onAudioAutoplayBlocked={onAudioAutoplayBlocked}
                onAudioPlaybackStarted={onAudioPlaybackStarted}
                audioPlaybackAttemptToken={audioPlaybackAttemptToken}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(MeetingAppLayout);
