"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LogOut, RotateCw } from "lucide-react";
import { useElementSize } from "../hooks/useElementSize";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useScrollWindow } from "../hooks/useScrollWindow";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import { usePublishStagePlacement } from "../hooks/usePublishStagePlacement";
import { resolveContentStagePlacement } from "../lib/meeting-stage-layout";
import type { Participant } from "../lib/types";
import { isSystemUserId } from "../lib/utils";
import AdminNoticePill from "./AdminNoticePill";
import LocalVideoTile from "./LocalVideoTile";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantVideo from "./ParticipantVideo";
import {
  stageRailClass,
  stageRailStyle,
  stageRailTileClass,
  stageSplitClass,
} from "./stage-layout";

const LARGE_VIEWPORT = "(width >= 64rem)";
const SHORT_LANDSCAPE_VIEWPORT =
  "(width < 40rem) and (height < 31.25rem) and (orientation: landscape)";

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
  const splitRef = useRef<HTMLDivElement>(null);
  const splitSize = useElementSize(splitRef);
  const isLargeViewport = useMediaQuery(LARGE_VIEWPORT);
  const isShortLandscape = useMediaQuery(SHORT_LANDSCAPE_VIEWPORT);
  const railAllowed = !isShortLandscape && (isLargeViewport || !fullStageBelowLarge);
  const [railElement, setRailElement] = useState<HTMLDivElement | null>(null);
  const railWindow = useScrollWindow(
    railElement,
    `${splitSize?.width}x${splitSize?.height}:${participantsList.length}`,
  );
  const placement = useMemo(
    () =>
      resolveContentStagePlacement({
        size: splitSize,
        participants: participantsList,
        railAllowed,
        railWindow,
      }),
    [participantsList, railAllowed, railWindow, splitSize],
  );
  const details = useMemo(
    () => ({
      focusIds: activeSpeakerId ? [activeSpeakerId] : [],
      warmIds: [],
      orderedRemoteIds: participantsList.map((participant) => participant.userId),
      presentation: { presenterId: null, producerId: null, focus: false },
    }),
    [activeSpeakerId, participantsList],
  );
  const stage = usePublishStagePlacement(placement, details);
  const railTileClass = stageRailTileClass(stage);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 p-4">
      <div className="pointer-events-none h-0 w-0 overflow-hidden" aria-hidden={true}>
        {remoteParticipants.map((participant) => (
          <ParticipantAudio
            key={participant.userId}
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
            onAudioAutoplayBlocked={onAudioAutoplayBlocked}
            onAudioPlaybackStarted={onAudioPlaybackStarted}
            audioPlaybackAttemptToken={audioPlaybackAttemptToken}
          />
        ))}
      </div>
      <div
        ref={splitRef}
        className={stageSplitClass(stage)}
        data-meet-stage-split={stage.split.mode}
        data-meet-room-tiling-visible-ids={stage.hints.visibleRemoteIds.join(",")}
        data-meet-room-tiling-primary-ids={stage.hints.primaryIds.join(",")}
        data-meet-room-tiling-hidden-ids={stage.hints.hiddenIds.join(",")}
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
        {stage.rail.length > 0 ? (
          <div
            ref={setRailElement}
            className={stageRailClass(stage)}
            style={stageRailStyle(stage)}
            data-meet-stage-rail
          >
            {stage.rail.map((tile) =>
              tile.kind === "local" ? (
                <div key="local" className={railTileClass} data-userid={currentUserId}>
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
              ) : (
                <div
                  key={tile.participant.userId}
                  className={railTileClass}
                  data-userid={tile.participant.userId}
                >
                  <ParticipantVideo
                    participant={tile.participant}
                    displayName={getDisplayName(tile.participant.userId)}
                    isActiveSpeaker={activeSpeakerId === tile.participant.userId}
                    audioOutputDeviceId={audioOutputDeviceId}
                    disableAudio
                  />
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(MeetingAppLayout);
