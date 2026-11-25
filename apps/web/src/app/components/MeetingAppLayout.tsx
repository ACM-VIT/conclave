"use client";

import { memo, useMemo, useRef, type ReactNode } from "react";
import { LogOut } from "lucide-react";
import { useElementSize } from "../hooks/useElementSize";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import { PARTICIPANT_RAIL, chooseStageSplit } from "../lib/stage-split";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import LocalVideoTile from "./LocalVideoTile";
import ParticipantVideo from "./ParticipantVideo";
import {
  STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS,
  stageRailClass,
  stageRailStyle,
  stageRailTileClass,
  stageSplitClass,
} from "./stage-layout";

interface MeetingAppLayoutProps {
  children: ReactNode;
  stageId: string;
  frameContent?: boolean;
  fullStageBelowLarge?: boolean;
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
  fullStageBelowLarge = false,
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
  const splitRef = useRef<HTMLDivElement>(null);
  const splitSize = useElementSize(splitRef);
  const split = chooseStageSplit(splitSize, PARTICIPANT_RAIL);
  const railTileClass = stageRailTileClass(split.mode);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 p-4">
      <div
        ref={splitRef}
        className={stageSplitClass(split.mode)}
        data-meet-stage-split={split.mode}
      >
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
        <div
          className={fullStageBelowLarge ? "hidden lg:contents" : "contents"}
        >
          <div
            className={`${stageRailClass(split.mode)} ${STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS}`}
            style={stageRailStyle(split)}
            data-meet-stage-rail
          >
            <div className={railTileClass} data-userid={currentUserId}>
              <LocalVideoTile
                stream={localStream}
                isCameraOff={isCameraOff}
                isMuted={isMuted}
                isHandRaised={isHandRaised}
                isMirrorCamera={isMirrorCamera}
                displayName={getDisplayName(currentUserId)}
                userEmail={userEmail}
                isActiveSpeaker={activeSpeakerId === currentUserId}
              />
            </div>
            {participantsList.map((participant) => (
              <div
                key={participant.userId}
                className={railTileClass}
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
    </div>
  );
}

export default memo(MeetingAppLayout);
