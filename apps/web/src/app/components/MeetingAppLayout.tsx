"use client";

import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { LogOut, RotateCw } from "lucide-react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import AdminNoticePill from "./AdminNoticePill";
import LocalVideoTile from "./LocalVideoTile";
import ParticipantVideo from "./ParticipantVideo";
import {
  STAGE_RAIL_CLASS,
  STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS,
  STAGE_RAIL_TILE_CLASS,
  STAGE_SPLIT_CLASS,
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
  syncFailed?: boolean;
  onRetrySync?: () => void;
  rejectedChangeAt?: number | null;
  rejectedChangeReason?: string | null;
  frozen?: boolean;
  documentsVersion?: number;
}

const REJECTED_CHANGE_NOTICE_MS = 4_000;
const rejectedChangeNotice = (reason: string | null) => ({
  message:
    reason === "too-large"
      ? "This app is full, so your last change couldn't be saved"
      : "Your last change couldn't be saved",
  level: "info" as const,
});

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
  syncFailed = false,
  onRetrySync,
  rejectedChangeAt = null,
  rejectedChangeReason = null,
  frozen = false,
  documentsVersion,
}: MeetingAppLayoutProps) {
  const [noticeFor, setNoticeFor] = useState<number | null>(null);

  useEffect(() => {
    const remaining = rejectedChangeAt === null ? 0 : rejectedChangeAt + REJECTED_CHANGE_NOTICE_MS - Date.now();
    if (remaining <= 0) return;
    setNoticeFor(rejectedChangeAt);
    const timer = window.setTimeout(() => setNoticeFor(null), remaining);
    return () => window.clearTimeout(timer);
  }, [rejectedChangeAt]);

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
          {syncFailed ? (
            <div
              role="status"
              className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#141414] px-3 py-2"
            >
              <span className="text-[12.5px] text-[#fafafa]/80">
                {"Couldn't load this app"}
              </span>
              <button
                type="button"
                onClick={onRetrySync}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[12px] font-medium text-[#fafafa]/85 transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
              >
                <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
                Retry
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
            <div key={documentsVersion} inert={frozen} className="contents">
              {children}
            </div>
            {noticeFor !== null && noticeFor === rejectedChangeAt ? (
              <AdminNoticePill notice={rejectedChangeNotice(rejectedChangeReason)} compact />
            ) : null}
          </div>
        </div>
        <div
          className={fullStageBelowLarge ? "hidden lg:contents" : "contents"}
        >
          <div
            className={`${STAGE_RAIL_CLASS} ${STAGE_RAIL_SHORT_LANDSCAPE_HIDDEN_CLASS}`}
            data-meet-stage-rail
          >
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
    </div>
  );
}

export default memo(MeetingAppLayout);
