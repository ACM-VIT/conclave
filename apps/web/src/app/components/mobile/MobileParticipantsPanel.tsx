"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";

interface MobileParticipantsPanelProps {
  participants: Map<string, Participant>;
  currentUserId: string;
  onClose: () => void;
  isOpen: boolean;
  socket: Socket | null;
  isAdmin: boolean;
  pendingUsers: Map<string, string>;
  getDisplayName: (userId: string) => string;
  hostUserId?: string | null;
  hostUserIds?: string[];
}

function MobileParticipantsPanel({
  participants,
  currentUserId,
  onClose,
  isOpen,
  socket,
  isAdmin,
  pendingUsers,
  getDisplayName,
  hostUserId,
  hostUserIds,
}: MobileParticipantsPanelProps) {
  const participantArray = Array.from(participants.values()).filter(
    (participant) => !isSystemUserId(participant.userId),
  );
  const pendingArray = Array.from(pendingUsers.entries());
  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);
  const effectiveHostUserIds = new Set<string>(
    hostUserIds && hostUserIds.length > 0
      ? hostUserIds
      : effectiveHostUserId
        ? [effectiveHostUserId]
        : [],
  );
  const canManageHost = Boolean(isAdmin);
  const [promotingHostUserId, setPromotingHostUserId] = useState<string | null>(
    null,
  );
  const [pendingHostPromotionUserId, setPendingHostPromotionUserId] = useState<
    string | null
  >(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [pendingKickUserId, setPendingKickUserId] = useState<string | null>(null);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [hostActionError, setHostActionError] = useState<string | null>(null);
  const localParticipant = participants.get(currentUserId);
  const formatName = (value: string, maxLength = 18) =>
    truncateDisplayName(value, maxLength);

  const handleAdmit = (userId: string) => {
    socket?.emit("admitUser", { userId });
  };

  const handleReject = (userId: string) => {
    socket?.emit("rejectUser", { userId });
  };

  const handlePromoteHost = (targetUserId: string) => {
    if (!socket || !canManageHost || effectiveHostUserIds.has(targetUserId)) {
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

  const toggleExpanded = (userId: string) => {
    setExpandedUserId((prev) => (prev === userId ? null : userId));
  };

  useEffect(() => {
    if (
      expandedUserId &&
      !participantArray.some((participant) => participant.userId === expandedUserId)
    ) {
      setExpandedUserId(null);
    }
  }, [expandedUserId, participantArray]);

  return (
    <div
      className="mobile-sheet-root z-50"
      data-state={isOpen ? "open" : "closed"}
      aria-hidden={!isOpen}
    >
      <div className="mobile-sheet-overlay" onClick={onClose} />
      <div className="mobile-sheet-panel">
        <div
          className="mobile-sheet w-full max-h-[85vh] flex flex-col safe-area-pb"
          role="dialog"
          aria-modal="true"
          aria-label="Participants"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="px-4 pt-3 pb-2">
            <div className="mx-auto mobile-sheet-grabber" />
            <div
              className="mt-3 flex items-center justify-between"
            >
              <h2 className="text-base font-semibold text-[#FEFCD9]">
                Participants ({participantArray.length + 1})
              </h2>
              <button
                onClick={onClose}
                className="mobile-pill mobile-glass-soft px-3 py-1 text-xs text-[#FEFCD9]"
              >
                Done
              </button>
            </div>
          </div>

        <div className="flex-1 mobile-sheet-scroll overflow-y-auto px-4 pb-4 space-y-4">
          {hostActionError && (
            <div className="text-[11px] px-2.5 py-1.5 rounded-lg bg-red-500/10 text-red-300 border border-red-500/20">
              {hostActionError}
            </div>
          )}

          {isAdmin && pendingArray.length > 0 && (
            <div className="mobile-sheet-card p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[0.25em] text-[#F95F4A]/80">
                  Waiting ({pendingArray.length})
                </span>
              </div>
              <div className="space-y-2">
                {pendingArray.map(([userId, displayName]) => (
                  <div
                    key={userId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[#FEFCD9]/10 bg-white/5 px-3 py-2"
                  >
                    <span className="text-sm text-[#FEFCD9] truncate">
                      {formatName(displayName)}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleReject(userId)}
                        className="h-7 w-7 rounded-lg border border-red-400/40 text-red-300 flex items-center justify-center active:scale-95"
                        aria-label="Reject"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleAdmit(userId)}
                        className="h-7 w-7 rounded-lg border border-[#F95F4A]/40 bg-[#F95F4A]/90 text-white flex items-center justify-center active:scale-95"
                        aria-label="Admit"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs text-[#FEFCD9]/55">In meeting</span>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-[#FEFCD9]/10 bg-white/5 px-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[#FEFCD9] truncate">
                      {formatName(getDisplayName(currentUserId), 16)}
                    </span>
                    <span className="text-[9px] uppercase tracking-[0.2em] text-[#F95F4A]/70">
                      YOU
                    </span>
                    {effectiveHostUserIds.has(currentUserId) && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                        Host
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {participantArray.map((participant) => {
                const isExpanded = expandedUserId === participant.userId;
                const detailId = `mobile-participant-${participant.userId.replace(
                  /[^a-zA-Z0-9_-]/g,
                  "",
                )}`;

                return (
                  <div key={participant.userId} className="space-y-2">
                    <div
                      className={`flex items-center justify-between gap-3 rounded-xl border border-[#FEFCD9]/10 bg-white/5 px-3 py-3 transition ${
                        isExpanded ? "bg-white/10" : ""
                      }`}
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
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm text-[#FEFCD9] truncate">
                            {formatName(getDisplayName(participant.userId), 16)}
                          </span>
                          {effectiveHostUserIds.has(participant.userId) && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                              Host
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(participant.userId);
                        }}
                        className="rounded-full border border-[#FEFCD9]/15 p-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9]"
                        aria-expanded={isExpanded}
                        aria-controls={detailId}
                        aria-label={`Toggle details for ${getDisplayName(
                          participant.userId,
                        )}`}
                      >
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    </div>

                    {isExpanded && (
                      <div
                        id={detailId}
                        className="rounded-xl border border-[#FEFCD9]/10 bg-black/30 px-3 py-2 text-[11px] text-[#FEFCD9]/70"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[#FEFCD9]/55">ID:</span>
                          <span className="text-[#FEFCD9]">
                            {participant.userId.split("#")[0] || participant.userId}
                          </span>
                        </div>
                        {canManageHost &&
                          !effectiveHostUserIds.has(participant.userId) &&
                          !participant.isGhost && (
                            <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                              {pendingHostPromotionUserId === participant.userId ? (
                                <>
                                  <button
                                    onClick={() => handlePromoteHost(participant.userId)}
                                    disabled={promotingHostUserId === participant.userId}
                                    className="rounded-md border border-amber-300/35 bg-amber-400/10 px-2 py-1 text-amber-200/90 transition-colors hover:border-amber-300/60 hover:text-amber-200 disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    {promotingHostUserId === participant.userId
                                      ? "Promoting"
                                      : "Confirm host"}
                                  </button>
                                  <button
                                    onClick={cancelHostPromotion}
                                    disabled={promotingHostUserId === participant.userId}
                                    className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => beginHostPromotion(participant.userId)}
                                  disabled={promotingHostUserId === participant.userId}
                                  className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/70 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Make host
                                </button>
                              )}
                              {pendingKickUserId === participant.userId ? (
                                <>
                                  <button
                                    onClick={() => handleKickUser(participant.userId)}
                                    disabled={removingUserId === participant.userId}
                                    className="rounded-md border border-red-400/40 bg-red-500/15 px-2 py-1 text-red-200 transition-colors hover:border-red-400/70 hover:text-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    {removingUserId === participant.userId
                                      ? "Removing"
                                      : "Confirm remove"}
                                  </button>
                                  <button
                                    onClick={cancelKickUser}
                                    disabled={removingUserId === participant.userId}
                                    className="rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 px-2 py-1 text-[#FEFCD9]/60 transition-colors hover:border-[#FEFCD9]/35 hover:text-[#FEFCD9] disabled:opacity-40 disabled:cursor-not-allowed"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  onClick={() => beginKickUser(participant.userId)}
                                  disabled={removingUserId === participant.userId}
                                  className="rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1 text-red-200/80 transition-colors hover:border-red-400/60 hover:text-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

export default memo(MobileParticipantsPanel);
