"use client";

import {
  ChevronDown,
  Hand,
  Mic,
  MicOff,
  MonitorUp,
  Shield,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { Avatar } from "@conclave/ui-tokens/web";
import type { Participant } from "../lib/types";
import { formatDisplayName, isSystemUserId } from "../lib/utils";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import { GhostParticipantBadge } from "./GhostParticipantChrome";

interface ParticipantsPanelProps {
  participants: Map<string, Participant>;
  currentUserId: string;
  onClose: () => void;
  pendingUsers?: Map<string, string>;
  onPendingUserStale?: (userId: string) => void;
  getDisplayName: (userId: string) => string;
  localState?: {
    isMuted: boolean;
    isCameraOff: boolean;
    isHandRaised: boolean;
    isScreenSharing: boolean;
    isGhost?: boolean;
  };
  viewerIsGhost?: boolean;
  hostUserId?: string | null;
  hostUserIds?: string[];
}

const ICON = 18;
const STROKE = 1.75;

const getAdminActionError = (
  response: unknown,
  fallbackMessage: string,
): string | null => {
  if (!response || typeof response !== "object") {
    return fallbackMessage;
  }
  const result = response as { success?: unknown; error?: unknown };
  if (typeof result.error === "string" && result.error.trim()) {
    return result.error;
  }
  return result.success === true ? null : fallbackMessage;
};

function ParticipantsPanel({
  participants,
  currentUserId,
  onClose,
  getDisplayName,
  socket,
  isAdmin,
  pendingUsers,
  onPendingUserStale,
  localState,
  hostUserId,
  hostUserIds,
  viewerIsGhost = false,
}: ParticipantsPanelProps & {
  socket: Socket | null;
  isAdmin?: boolean | null;
}) {
  const participantsList = Array.from(participants.values()).filter(
    (participant) =>
      participant.userId !== currentUserId &&
      !isSystemUserId(participant.userId) &&
      isRemoteParticipantVisible(participant, viewerIsGhost, currentUserId),
  );
  const localParticipant: Participant | null =
    localState
      ? {
          userId: currentUserId,
          videoStream: null,
          audioStream: null,
          screenShareStream: null,
          screenShareAudioStream: null,
          audioProducerId: null,
          videoProducerId: null,
          screenShareProducerId: null,
          screenShareAudioProducerId: null,
          isMuted: localState.isMuted,
          isCameraOff: localState.isCameraOff,
          isVideoAdaptivelyPaused: false,
          isHandRaised: localState.isHandRaised,
          isGhost: Boolean(localState.isGhost),
        }
      : null;
  const displayParticipants = localParticipant
    ? [localParticipant, ...participantsList]
    : participantsList;
  const pendingList = pendingUsers ? Array.from(pendingUsers.entries()) : [];
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);
  const [promotingHostUserId, setPromotingHostUserId] = useState<string | null>(
    null,
  );
  const [pendingHostPromotionUserId, setPendingHostPromotionUserId] = useState<
    string | null
  >(null);
  const [pendingKickUserId, setPendingKickUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [hostActionError, setHostActionError] = useState<string | null>(null);
  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);
  const effectiveHostUserIds = new Set<string>(
    hostUserIds && hostUserIds.length > 0
      ? hostUserIds
      : effectiveHostUserId
        ? [effectiveHostUserId]
        : [],
  );
  const canManageHost = Boolean(isAdmin);

  const handleCloseProducer = (producerId: string) => {
    if (!socket || !isAdmin) return;
    setHostActionError(null);
    socket.emit("closeRemoteProducer", { producerId }, (res: unknown) => {
      const error = getAdminActionError(res, "Couldn’t stop that stream.");
      if (error) setHostActionError(error);
    });
  };

  const handleMuteAll = () => {
    if (!socket || !isAdmin) return;
    setHostActionError(null);
    socket.emit("muteAll", (res: unknown) => {
      const error = getAdminActionError(res, "Couldn’t mute everyone.");
      if (error) setHostActionError(error);
    });
  };

  const handleCloseAllVideo = () => {
    if (!socket || !isAdmin) return;
    setHostActionError(null);
    socket.emit("closeAllVideo", (res: unknown) => {
      const error = getAdminActionError(res, "Couldn’t turn off everyone’s camera.");
      if (error) setHostActionError(error);
    });
  };

  const handlePromoteHost = (targetUserId: string) => {
    const targetParticipant = participants.get(targetUserId);
    const isWebinarAttendee = Boolean(
      (
        targetParticipant as
          | (Participant & { isWebinarAttendee?: boolean })
          | undefined
      )?.isWebinarAttendee,
    );
    if (
      !socket ||
      !canManageHost ||
      effectiveHostUserIds.has(targetUserId) ||
      targetParticipant?.isGhost ||
      isWebinarAttendee
    ) {
      return;
    }
    setHostActionError(null);
    setPromotingHostUserId(targetUserId);
    socket.emit(
      "promoteHost",
      { userId: targetUserId },
      (res: { success?: boolean; hostUserId?: string; error?: string }) => {
        setPromotingHostUserId(null);
        setPendingHostPromotionUserId(null);
        if (res.error || !res.success) {
          setHostActionError(res.error || "Failed to promote host.");
        }
      },
    );
  };

  const beginHostPromotion = (targetUserId: string) => {
    if (!canManageHost || effectiveHostUserIds.has(targetUserId)) return;
    setHostActionError(null);
    setPendingHostPromotionUserId(targetUserId);
  };

  const cancelHostPromotion = () => {
    if (promotingHostUserId) return;
    setPendingHostPromotionUserId(null);
  };

  const beginKickUser = (targetUserId: string) => {
    if (!socket || !isAdmin) return;
    setHostActionError(null);
    setPendingKickUserId(targetUserId);
  };

  const cancelKickUser = () => {
    if (removingUserId) return;
    setPendingKickUserId(null);
  };

  const handleKickUser = (targetUserId: string) => {
    if (!socket || !isAdmin) return;
    setHostActionError(null);
    setRemovingUserId(targetUserId);
    socket.emit(
      "kickUser",
      { userId: targetUserId },
      (res: { success?: boolean; error?: string }) => {
        setRemovingUserId(null);
        setPendingKickUserId(null);
        if (res?.error || !res?.success) {
          setHostActionError(res?.error || "Failed to remove participant.");
        }
      },
    );
  };

  useEffect(() => {
    if (
      expandedUserId &&
      !displayParticipants.some((participant) => participant.userId === expandedUserId)
    ) {
      setExpandedUserId(null);
    }
  }, [displayParticipants, expandedUserId]);

  const toggleExpanded = (userId: string) => {
    setExpandedUserId((prev) => (prev === userId ? null : userId));
  };

  const bulkButtonClass =
    "flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] font-medium text-[#a1a1aa] transition-colors hover:bg-white/[0.07] hover:text-[#fafafa]";
  const actionButtonBase =
    "inline-flex items-center justify-center rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const neutralActionClass =
    actionButtonBase +
    " border border-white/10 bg-white/[0.04] text-[#a1a1aa] hover:bg-white/[0.07] hover:text-[#fafafa]";
  const hostActionClass =
    actionButtonBase +
    " border border-[#F95F4A]/35 bg-[#F95F4A]/10 text-[#F95F4A] hover:bg-[#F95F4A]/15";
  const dangerActionClass =
    actionButtonBase +
    " border border-[#ea4335]/35 bg-[#ea4335]/10 text-[#ea4335] hover:bg-[#ea4335]/15";

  return (
    <div
      className="safe-area-pt safe-area-pb fixed right-0 top-0 bottom-0 z-40 flex w-full sm:w-[360px] flex-col overflow-hidden border-l border-white/10 bg-[#18181b] animate-[meet-panel-in_280ms_cubic-bezier(0.22,1,0.36,1)]"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <Users size={ICON} strokeWidth={STROKE} className="text-[#a1a1aa]" />
          <h2 className="text-[15px] font-semibold text-[#fafafa]">
            Participants
          </h2>
          <span className="text-[15px] font-semibold text-[#a1a1aa]">
            ({displayParticipants.length})
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
          aria-label="Close participants panel"
        >
          <X size={ICON} strokeWidth={STROKE} />
        </button>
      </header>

      {isAdmin && (
        <section className="border-b border-white/10 px-4 py-3">
          <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#71717a]">
            Host controls
          </h3>
          {hostActionError && (
            <div className="mb-2.5 rounded-md border border-[#ea4335]/25 bg-[#ea4335]/10 px-2.5 py-1.5 text-[12px] text-[#ea4335]">
              {hostActionError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleMuteAll}
              className={bulkButtonClass}
              title="Mute everyone"
            >
              <MicOff size={ICON} strokeWidth={STROKE} />
              <span>Mute all</span>
            </button>
            <button
              type="button"
              onClick={handleCloseAllVideo}
              className={bulkButtonClass}
              title="Turn off everyone's camera"
            >
              <VideoOff size={ICON} strokeWidth={STROKE} />
              <span>Stop video</span>
            </button>
          </div>
        </section>
      )}

      {isAdmin && pendingList.length > 0 && (
        <section className="border-b border-white/10">
          <button
            type="button"
            onClick={() => setIsPendingExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between px-4 py-2.5 transition-colors hover:bg-white/[0.04]"
            aria-expanded={isPendingExpanded}
          >
            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-[#fafafa]">
              Waiting to join
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[#F95F4A]/15 px-1.5 text-[11px] font-semibold tabular-nums text-[#F95F4A]">
                {pendingList.length}
              </span>
            </span>
            <ChevronDown
              size={ICON}
              strokeWidth={STROKE}
              className={`text-[#a1a1aa] transition-transform ${
                isPendingExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
          {isPendingExpanded && (
            <div className="max-h-40 space-y-1 overflow-y-auto px-2 pb-2">
              {pendingList.map(([userId, displayName]) => {
                const pendingName = formatDisplayName(displayName || userId);
                return (
                  <div
                    key={userId}
                    className="flex items-center gap-3 rounded-lg px-2 py-2"
                  >
                    <Avatar name={pendingName} id={userId} size={32} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#fafafa]">
                      {pendingName}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          socket?.emit(
                            "admitUser",
                            { userId },
                            (res: { success?: boolean; error?: string }) => {
                              if (res?.error) onPendingUserStale?.(userId);
                            },
                          )
                        }
                        className="inline-flex items-center justify-center rounded-md border border-[#22c55e]/35 bg-[#22c55e]/10 px-2.5 py-1.5 text-[12.5px] font-medium text-[#22c55e] transition-colors hover:bg-[#22c55e]/15"
                        title="Admit to meeting"
                        aria-label={`Admit ${pendingName}`}
                      >
                        Admit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          socket?.emit(
                            "rejectUser",
                            { userId },
                            (res: { success?: boolean; error?: string }) => {
                              if (res?.error) onPendingUserStale?.(userId);
                            },
                          )
                        }
                        className="inline-flex items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12.5px] font-medium text-[#a1a1aa] transition-colors hover:bg-white/[0.07] hover:text-[#fafafa]"
                        title="Deny entry"
                        aria-label={`Reject ${pendingName}`}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Participant list */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {displayParticipants.map((participant) => {
          const isMe = participant.userId === currentUserId;
          const isHost = effectiveHostUserIds.has(participant.userId);
          const isWebinarAttendee = Boolean(
            (
              participant as Participant & { isWebinarAttendee?: boolean }
            ).isWebinarAttendee,
          );
          const canPromoteParticipant =
            canManageHost && !isHost && !participant.isGhost && !isWebinarAttendee;
          const isPendingPromotion =
            pendingHostPromotionUserId === participant.userId;
          const displayName = formatDisplayName(
            getDisplayName(participant.userId),
          );
          const hasScreenShare =
            Boolean(participant.screenShareStream) ||
            (isMe && Boolean(localState?.isScreenSharing));
          const isExpanded = expandedUserId === participant.userId;
          // Only hosts get an expandable row (the detail panel holds moderation
          // actions); for everyone else there's nothing to reveal.
          const canExpand = isAdmin && !isMe;
          const detailId = `participant-details-${participant.userId.replace(
            /[^a-zA-Z0-9_-]/g,
            "",
          )}`;
          return (
            <div key={participant.userId}>
              <div
                className={`flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors ${
                  canExpand ? "cursor-pointer" : ""
                } ${isExpanded ? "bg-white/[0.06]" : canExpand ? "hover:bg-white/[0.04]" : ""}`}
                role={canExpand ? "button" : undefined}
                tabIndex={canExpand ? 0 : undefined}
                aria-expanded={canExpand ? isExpanded : undefined}
                aria-controls={canExpand ? detailId : undefined}
                onClick={canExpand ? () => toggleExpanded(participant.userId) : undefined}
                onKeyDown={
                  canExpand
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleExpanded(participant.userId);
                        }
                      }
                    : undefined
                }
              >
                <Avatar name={displayName} id={participant.userId} size={36} />

                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate text-[14px] font-medium text-[#fafafa]"
                      title={displayName}
                    >
                      {displayName}
                    </span>
                    {isMe && (
                      <span className="shrink-0 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-[#a1a1aa]">
                        You
                      </span>
                    )}
                    {isHost && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#F95F4A]/12 px-1.5 py-0.5 text-[11px] font-medium text-[#F95F4A]">
                        <Shield size={12} strokeWidth={STROKE} />
                        Host
                      </span>
                    )}
                    {participant.isGhost && (
                      <GhostParticipantBadge compact label="Ghost" />
                    )}
                  </div>
                  {participant.isGhost && viewerIsGhost && (
                    <p className="truncate text-[12px] text-[#fafafa]/45">
                      Visible only to other ghosts
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2.5">
                  {participant.isHandRaised && (
                    <Hand
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#fbbf24]"
                    />
                  )}
                  {hasScreenShare && (
                    <MonitorUp
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#22c55e]"
                    />
                  )}
                  {participant.isCameraOff ? (
                    <VideoOff
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#ea4335]"
                    />
                  ) : (
                    <Video
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#a1a1aa]"
                    />
                  )}
                  {participant.isMuted ? (
                    <MicOff
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#ea4335]"
                    />
                  ) : (
                    <Mic
                      size={ICON}
                      strokeWidth={STROKE}
                      className="text-[#a1a1aa]"
                    />
                  )}
                  {canExpand && (
                    <ChevronDown
                      size={ICON}
                      strokeWidth={STROKE}
                      className={`text-[#71717a] transition-transform ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>

              {isExpanded && canExpand && (
                <div
                  id={detailId}
                  className="mx-2 mb-1 mt-0.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5"
                >
                  {isAdmin && !isMe && (
                    <div className="flex flex-wrap gap-1.5">
                      {canPromoteParticipant && (
                        <>
                          {isPendingPromotion ? (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  handlePromoteHost(participant.userId)
                                }
                                disabled={
                                  promotingHostUserId === participant.userId
                                }
                                className={hostActionClass}
                              >
                                {promotingHostUserId === participant.userId
                                  ? "Promoting…"
                                  : "Confirm host"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelHostPromotion}
                                disabled={
                                  promotingHostUserId === participant.userId
                                }
                                className={neutralActionClass}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                beginHostPromotion(participant.userId)
                              }
                              disabled={
                                promotingHostUserId === participant.userId
                              }
                              className={neutralActionClass}
                            >
                              Make host
                            </button>
                          )}
                        </>
                      )}
                      {!isMe && (
                        <>
                          {pendingKickUserId === participant.userId ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handleKickUser(participant.userId)}
                                disabled={removingUserId === participant.userId}
                                className={dangerActionClass}
                              >
                                {removingUserId === participant.userId
                                  ? "Removing…"
                                  : "Confirm remove"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelKickUser}
                                disabled={removingUserId === participant.userId}
                                className={neutralActionClass}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginKickUser(participant.userId)}
                              disabled={removingUserId === participant.userId}
                              className={dangerActionClass}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      )}
                      {participant.audioProducerId ? (() => {
                        const producerId = participant.audioProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className={neutralActionClass}
                          >
                            Mute
                          </button>
                        );
                      })() : null}
                      {participant.videoProducerId ? (() => {
                        const producerId = participant.videoProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className={neutralActionClass}
                          >
                            Turn off camera
                          </button>
                        );
                      })() : null}
                      {participant.screenShareProducerId ? (() => {
                        const producerId = participant.screenShareProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className={neutralActionClass}
                          >
                            Stop share
                          </button>
                        );
                      })() : null}
                      {participant.screenShareAudioProducerId ? (() => {
                        const producerId = participant.screenShareAudioProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className={neutralActionClass}
                          >
                            Stop share audio
                          </button>
                        );
                      })() : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(ParticipantsPanel);
