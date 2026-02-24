"use client";

import {
  AlertCircle,
  ChevronDown,
  Hand,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Users,
  Video,
  VideoOff,
  X,
  Check,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Participant } from "../lib/types";
import { formatDisplayName, isSystemUserId } from "../lib/utils";


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
  };
  hostUserId?: string | null;
  hostUserIds?: string[];
}

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
}: ParticipantsPanelProps & {
  socket: Socket | null;
  isAdmin?: boolean | null;
}) {
  const participantsList = Array.from(participants.values()).filter(
    (participant) => !isSystemUserId(participant.userId),
  );
  const hasLocalEntry = participants.has(currentUserId);
  const localParticipant: Participant | null =
    !hasLocalEntry && localState
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
          isHandRaised: localState.isHandRaised,
          isGhost: false,
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

  const hostBulkButtonClass =
    "flex-1 rounded-lg border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-3 py-2 text-[13px] font-normal text-[#FEFCD9]/75 transition-all hover:border-[#F95F4A]/45 hover:bg-[#F95F4A]/10 hover:text-[#FEFCD9]";
  const hostUserActionButtonClass =
    "inline-flex h-6 w-6 items-center justify-center rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 text-[#FEFCD9]/60 transition-colors";

  const getEmailFromUserId = (userId: string): string => {
    return userId.split("#")[0] || userId;
  };

  const handleCloseProducer = (producerId: string) => {
    if (!socket || !isAdmin) return;
    socket.emit("closeRemoteProducer", { producerId }, (res: any) => {
      if (res.error) console.error("Failed to close producer:", res.error);
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

  return (
    <div
      className="fixed right-4 top-16 bottom-20 z-40 flex w-72 flex-col overflow-hidden rounded-xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 shadow-2xl backdrop-blur-md"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex items-center justify-between border-b border-[#FEFCD9]/10 px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#FEFCD9]">
          <Users className="h-4 w-4 text-[#FEFCD9]/70" />
          <span>Participants</span>
          <span className="text-[#F95F4A]">({displayParticipants.length})</span>
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded text-[#FEFCD9]/50 transition-all hover:bg-[#FEFCD9]/10 hover:text-[#FEFCD9]"
          aria-label="Close participants panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {isAdmin && (
        <div className="border-b border-[#FEFCD9]/5 px-3 py-2">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#FEFCD9]/70">
            <AlertCircle className="h-3.5 w-3.5 text-[#FEFCD9]/45" />
            Host controls
          </div>
          {hostActionError && (
            <div className="mb-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
              {hostActionError}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={() =>
                socket?.emit("muteAll", (res: unknown) =>
                  console.log("Muted all:", res),
                )
              }
              className={`${hostBulkButtonClass} flex items-center justify-center gap-2`}
              title="Mute all"
            >
              <MicOff className="h-4 w-4" />
              <span>Mute all</span>
            </button>
            <button
              onClick={() =>
                socket?.emit("closeAllVideo", (res: unknown) =>
                  console.log("Stopped all video:", res),
                )
              }
              className={`${hostBulkButtonClass} flex items-center justify-center gap-2`}
              title="Stop all video"
            >
              <VideoOff className="h-4 w-4" />
              <span>Stop video</span>
            </button>
          </div>
        </div>
      )}

      {isAdmin && pendingList.length > 0 && (
        <div className="border-b border-[#FEFCD9]/5">
          <button
            type="button"
            onClick={() => setIsPendingExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between px-3 py-2 transition-colors hover:bg-[#F95F4A]/5"
            aria-expanded={isPendingExpanded}
          >
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#F95F4A]">
              Pending
              <span className="rounded bg-[#F95F4A]/20 px-1.5 py-0.5 text-[9px] tabular-nums">
                {pendingList.length}
              </span>
            </span>
            <ChevronDown
              className={`h-3 w-3 text-[#F95F4A] transition-transform ${
                isPendingExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
          {isPendingExpanded && (
            <div className="max-h-32 space-y-1 overflow-y-auto px-3 pb-2">
              {pendingList.map(([userId, displayName]) => {
                const pendingName = formatDisplayName(displayName || userId);
                return (
                  <div
                    key={userId}
                    className="flex items-center justify-between rounded-md bg-black/30 px-2 py-1.5"
                  >
                    <span className="flex-1 truncate text-xs text-[#FEFCD9]/70">
                      {pendingName}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() =>
                          socket?.emit(
                            "admitUser",
                            { userId },
                            (res: { success?: boolean; error?: string }) => {
                              if (res?.error) onPendingUserStale?.(userId);
                            },
                          )
                        }
                        className="rounded px-2 py-1 text-[9px] text-green-400 transition-all hover:bg-green-500/20"
                        title="Admit"
                        aria-label="Admit user"
                      >
                        ✓
                      </button>
                      <button
                        onClick={() =>
                          socket?.emit(
                            "rejectUser",
                            { userId },
                            (res: { success?: boolean; error?: string }) => {
                              if (res?.error) onPendingUserStale?.(userId);
                            },
                          )
                        }
                        className="rounded px-2 py-1 text-[9px] text-red-400 transition-all hover:bg-red-500/20"
                        title="Reject"
                        aria-label="Reject user"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 space-y-0.5 overflow-y-auto px-2 py-2">
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
          const userEmail = getEmailFromUserId(participant.userId);
          const hasScreenShare =
            Boolean(participant.screenShareStream) ||
            (isMe && Boolean(localState?.isScreenSharing));
          const isExpanded = expandedUserId === participant.userId;
          const detailId = `participant-details-${participant.userId.replace(
            /[^a-zA-Z0-9_-]/g,
            "",
          )}`;
          return (
            <div key={participant.userId} className="space-y-1">
              <div
                className={`flex items-center justify-between rounded-md px-2 py-1.5 transition-all cursor-pointer ${
                  isMe ? "bg-[#F95F4A]/5" : "hover:bg-[#FEFCD9]/5"
                } ${isExpanded ? "bg-[#FEFCD9]/5" : ""}`}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={detailId}
                onClick={() => toggleExpanded(participant.userId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggleExpanded(participant.userId);
                  }
                }}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate text-sm text-[#FEFCD9]/85" title={userEmail}>
                    {displayName} {isMe && <span className="text-[#F95F4A]/60">(you)</span>}
                  </span>
                  {isHost && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                      Host
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {participant.isHandRaised && (
                    <Hand className="h-3.5 w-3.5 text-amber-400" />
                  )}
                  {hasScreenShare && (
                    <Monitor className="h-3.5 w-3.5 text-green-500" />
                  )}
                  {participant.isCameraOff ? (
                    <VideoOff className="h-3.5 w-3.5 text-red-400/70" />
                  ) : (
                    <Video className="h-3.5 w-3.5 text-green-500/70" />
                  )}
                  {participant.isMuted ? (
                    <MicOff className="h-3.5 w-3.5 text-red-400/70" />
                  ) : (
                    <Mic className="h-3.5 w-3.5 text-green-500/70" />
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleExpanded(participant.userId);
                    }}
                    className="rounded-full border border-[#FEFCD9]/15 p-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9]"
                    aria-expanded={isExpanded}
                    aria-controls={detailId}
                    aria-label={`Toggle details for ${displayName}`}
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div
                  id={detailId}
                  className="rounded-md border border-[#FEFCD9]/10 bg-black/30 px-2 py-2 text-[11px] text-[#FEFCD9]/70"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[#FEFCD9]/55">ID:</span>
                    <span className="text-[#FEFCD9]">{userEmail}</span>
                  </div>
                  {isAdmin && !isMe && (
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
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
                                className="rounded-md border border-amber-300/35 bg-amber-400/10 px-2 py-1 text-amber-200/90 transition-colors hover:border-amber-300/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {promotingHostUserId === participant.userId
                                  ? "Promoting"
                                  : "Confirm host"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelHostPromotion}
                                disabled={
                                  promotingHostUserId === participant.userId
                                }
                                className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:cursor-not-allowed disabled:opacity-40"
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
                              className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/70 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:cursor-not-allowed disabled:opacity-40"
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
                                className="rounded-md border border-red-400/40 bg-red-500/15 px-2 py-1 text-red-200 transition-colors hover:border-red-400/70 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {removingUserId === participant.userId
                                  ? "Removing"
                                  : "Confirm remove"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelKickUser}
                                disabled={removingUserId === participant.userId}
                                className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => beginKickUser(participant.userId)}
                              disabled={removingUserId === participant.userId}
                              className="rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-red-200/80 transition-colors hover:border-red-400/60 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
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
                            className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/75 transition hover:border-[#F95F4A]/40 hover:text-[#FEFCD9]"
                          >
                            Stop mic
                          </button>
                        );
                      })() : null}
                      {participant.videoProducerId ? (() => {
                        const producerId = participant.videoProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/75 transition hover:border-[#F95F4A]/40 hover:text-[#FEFCD9]"
                          >
                            Stop video
                          </button>
                        );
                      })() : null}
                      {participant.screenShareProducerId ? (() => {
                        const producerId = participant.screenShareProducerId;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCloseProducer(producerId)}
                            className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/75 transition hover:border-[#F95F4A]/40 hover:text-[#FEFCD9]"
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
                            className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/75 transition hover:border-[#F95F4A]/40 hover:text-[#FEFCD9]"
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
