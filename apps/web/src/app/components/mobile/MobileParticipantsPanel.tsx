"use client";

import { Check, X } from "lucide-react";
import { memo, useState } from "react";
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
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <h2 className="text-base font-semibold text-[#FEFCD9] uppercase tracking-[0.2em]">
                Participants ({participantArray.length + 1})
              </h2>
              <button
                onClick={onClose}
                className="mobile-pill mobile-glass-soft px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]"
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
            <span className="text-[10px] uppercase tracking-[0.25em] text-[#FEFCD9]/45">
              In meeting
            </span>
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
                  {localParticipant ? (
                    (() => {
                      const localStatusParts = [
                        localParticipant.isMuted ? "Muted" : null,
                        localParticipant.isCameraOff ? "Cam Off" : null,
                        localParticipant.isHandRaised ? "✋" : null,
                        localParticipant.isGhost ? "Ghost" : null,
                      ].filter(Boolean);
                      return localStatusParts.length > 0 ? (
                        <span className="text-[11px] text-[#FEFCD9]/50">
                          {localStatusParts.join(" · ")}
                        </span>
                      ) : null;
                    })()
                  ) : null}
                </div>
              </div>

              {participantArray.map((participant) => {
                const statusParts = [
                  participant.isMuted ? "Muted" : null,
                  participant.isCameraOff ? "Cam Off" : null,
                  participant.isHandRaised ? "✋" : null,
                  participant.isGhost ? "Ghost" : null,
                ].filter(Boolean);

                return (
                  <div
                    key={participant.userId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-[#FEFCD9]/10 bg-white/5 px-3 py-3"
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
                      {statusParts.length > 0 ? (
                        <span className="text-[11px] text-[#FEFCD9]/50">
                          {statusParts.join(" · ")}
                        </span>
                      ) : null}
                    </div>
                    {canManageHost &&
                      !effectiveHostUserIds.has(participant.userId) &&
                      !participant.isGhost && (
                        <div className="flex items-center gap-2">
                          {pendingHostPromotionUserId === participant.userId ? (
                            <>
                              <button
                                onClick={() => handlePromoteHost(participant.userId)}
                                disabled={promotingHostUserId === participant.userId}
                                className="px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-amber-200 border border-amber-300/35 rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {promotingHostUserId === participant.userId
                                  ? "Promoting"
                                  : "Confirm"}
                              </button>
                              <button
                                onClick={cancelHostPromotion}
                                disabled={promotingHostUserId === participant.userId}
                                className="px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-[#FEFCD9]/55 border border-[#FEFCD9]/15 rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => beginHostPromotion(participant.userId)}
                              disabled={promotingHostUserId === participant.userId}
                              className="px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-[#FEFCD9]/70 border border-[#FEFCD9]/15 rounded-full disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Host
                            </button>
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
