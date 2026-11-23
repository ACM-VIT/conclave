"use client";

import { memo, useEffect, useState, type ComponentType } from "react";
import { LogOut, RotateCw } from "lucide-react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import AdminNoticePill from "./AdminNoticePill";
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
  onAudioAutoplayBlocked?: () => void;
  onAudioPlaybackStarted?: () => void;
  audioPlaybackAttemptToken?: number;
  getDisplayName: (userId: string) => string;
  /** Lets this participant step out of a shared app without affecting others. */
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
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
              ? "relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-[#0b0b0b] shadow-[0_20px_60px_rgba(0,0,0,0.4)]"
              : "relative min-h-0 min-w-0 flex-1 overflow-hidden"
          }
        >
          <div inert={frozen} className="contents">
            <App key={documentsVersion} />
          </div>
          {noticeFor !== null && noticeFor === rejectedChangeAt ? <AdminNoticePill notice={rejectedChangeNotice(rejectedChangeReason)} compact /> : null}
        </div>
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
            onAudioAutoplayBlocked={onAudioAutoplayBlocked}
            onAudioPlaybackStarted={onAudioPlaybackStarted}
            audioPlaybackAttemptToken={audioPlaybackAttemptToken}
          />
        ))}
      </aside>
    </div>
  );
}

export default memo(MeetingAppLayout);
