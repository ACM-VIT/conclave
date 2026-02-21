"use client";

import { Ghost, Hand, MicOff, X } from "lucide-react";
import { memo } from "react";
import type { Socket } from "socket.io-client";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";

interface MobileParticipantsPanelProps {
  participants: Map<string, Participant>;
  currentUserId: string;
  onClose: () => void;
  socket: Socket | null;
  isAdmin: boolean;
  pendingUsers: Map<string, string>;
  getDisplayName: (userId: string) => string;
  hostUserId?: string | null;
}

function MobileParticipantsPanel({
  participants,
  currentUserId,
  onClose,
  socket,
  isAdmin,
  pendingUsers,
  getDisplayName,
  hostUserId,
}: MobileParticipantsPanelProps) {
  const participantArray = Array.from(participants.values()).filter(
    (participant) => !isSystemUserId(participant.userId),
  );
  const pendingArray = Array.from(pendingUsers.entries());
  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);
  const formatName = (value: string, maxLength = 18) =>
    truncateDisplayName(value, maxLength);

  const handleAdmit = (userId: string) => {
    socket?.emit("admitUser", { userId });
  };

  const handleReject = (userId: string) => {
    socket?.emit("rejectUser", { userId });
  };

  return (
    <div className="fixed inset-0 bg-[#1a1a1a] z-50 flex flex-col safe-area-pt safe-area-pb">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-[#FEFCD9]/10"
        style={{ fontFamily: "'PolySans Mono', monospace" }}
      >
        <h2 className="text-lg font-semibold text-[#FEFCD9] uppercase tracking-wide">
          Participants ({participantArray.length + 1})
        </h2>
        <button
          onClick={onClose}
          className="p-2 rounded-full hover:bg-[#FEFCD9]/10 text-[#FEFCD9]/70"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Waiting room section (for admins) */}
        {isAdmin && pendingArray.length > 0 && (
          <div className="px-4 py-3 border-b border-[#FEFCD9]/10">
            <p className="text-[10px] text-[#FEFCD9]/40 uppercase tracking-widest mb-3">
              Waiting ({pendingArray.length})
            </p>
            <div className="space-y-2">
              {pendingArray.map(([userId, displayName]) => (
                <div
                  key={userId}
                  className="flex items-center justify-between bg-[#252525] rounded-xl p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold">
                      {displayName[0]?.toUpperCase() || "?"}
                    </div>
                    <span
                      className="text-sm text-[#FEFCD9]"
                      title={displayName}
                    >
                      {formatName(displayName)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleReject(userId)}
                      className="px-3 py-1.5 text-xs text-red-400 border border-red-400/30 rounded-lg active:bg-red-400/10"
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => handleAdmit(userId)}
                      className="px-3 py-1.5 text-xs text-white bg-[#F95F4A] rounded-lg active:bg-[#e8553f]"
                    >
                      Admit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* In meeting section */}
        <div className="px-4 py-3">
          <p className="text-[10px] text-[#FEFCD9]/40 uppercase tracking-widest mb-3">
            In meeting
          </p>
          <div className="space-y-2">
            {/* Current user (You) */}
            <div className="flex items-center gap-3 bg-[#252525] rounded-xl p-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold">
                {getDisplayName(currentUserId)[0]?.toUpperCase() || "?"}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[#FEFCD9]">
                    {formatName(getDisplayName(currentUserId), 16)}
                  </span>
                  <span className="text-[9px] text-[#F95F4A]/60 uppercase">
                    (You)
                  </span>
                  {effectiveHostUserId === currentUserId && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                      Host
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Other participants */}
            {participantArray.map((participant) => (
              <div
                key={participant.userId}
                className="flex items-center gap-3 bg-[#252525] rounded-xl p-3"
              >
                <div className="relative">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-[#FEFCD9] font-bold">
                    {getDisplayName(participant.userId)[0]?.toUpperCase() ||
                      "?"}
                  </div>
                  {participant.isGhost && (
                    <Ghost className="absolute -bottom-0.5 -right-0.5 w-4 h-4 text-[#FF007A] bg-[#252525] rounded-full p-0.5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-[#FEFCD9] truncate block">
                      {formatName(getDisplayName(participant.userId), 16)}
                    </span>
                    {effectiveHostUserId === participant.userId && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                        Host
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {participant.isHandRaised && (
                    <Hand className="w-4 h-4 text-amber-400" />
                  )}
                  {participant.isMuted && (
                    <MicOff className="w-4 h-4 text-[#F95F4A]" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(MobileParticipantsPanel);
