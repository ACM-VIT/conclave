"use client";

import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  Hand,
  Mic,
  MicOff,
  Monitor,
  Users,
  Video,
  VideoOff,
  X,
  UserMinus,
} from "lucide-react";
import { memo, useState } from "react";
import type { Socket } from "socket.io-client";
import type { RoomInfo } from "@/lib/sfu-types";
import type { Participant } from "../lib/types";
import { formatDisplayName, isSystemUserId } from "../lib/utils";

export type ParticipantsPanelGetRooms = (roomId: string) => Promise<RoomInfo[]>;

interface ParticipantsPanelProps {
  participants: Map<string, Participant>;
  currentUserId: string;
  onClose: () => void;
  pendingUsers?: Map<string, string>;
  roomId: string;
  onPendingUserStale?: (userId: string) => void;
  getDisplayName: (userId: string) => string;
  getRooms?: ParticipantsPanelGetRooms;
  localState?: {
    isMuted: boolean;
    isCameraOff: boolean;
    isHandRaised: boolean;
    isScreenSharing: boolean;
  };
  hostUserId?: string | null;
}

function ParticipantsPanel({
  participants,
  currentUserId,
  onClose,
  getDisplayName,
  socket,
  isAdmin,
  pendingUsers,
  roomId,
  onPendingUserStale,
  getRooms,
  localState,
  hostUserId,
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
          audioProducerId: null,
          videoProducerId: null,
          screenShareProducerId: null,
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
  const [showRedirectModal, setShowRedirectModal] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [selectedUserForRedirect, setSelectedUserForRedirect] = useState<
    string | null
  >(null);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);
  const filteredRooms = availableRooms.filter((room) => room.id !== roomId);
  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);

  const getEmailFromUserId = (userId: string): string => {
    return userId.split("#")[0] || userId;
  };

  const handleCloseProducer = (producerId: string) => {
    if (!socket || !isAdmin) return;
    socket.emit("closeRemoteProducer", { producerId }, (res: any) => {
      if (res.error) console.error("Failed to close producer:", res.error);
    });
  };

  const openRedirectModal = (userId: string) => {
    setSelectedUserForRedirect(userId);
    if (getRooms) {
      getRooms(roomId)
        .then((rooms) => {
          setAvailableRooms(rooms || []);
          setShowRedirectModal(true);
        })
        .catch(() => {
          setAvailableRooms([]);
          setShowRedirectModal(true);
        });
      return;
    }

    socket?.emit("getRooms", (response: { rooms?: RoomInfo[] }) => {
      setAvailableRooms(response.rooms || []);
      setShowRedirectModal(true);
    });
  };

  const handleRedirect = (targetRoomId: string) => {
    if (!selectedUserForRedirect || !socket) return;

    socket.emit(
      "redirectUser",
      { userId: selectedUserForRedirect, newRoomId: targetRoomId },
      (res: { error?: string }) => {
        if (res.error) {
          console.error("Redirect failed:", res.error);
        } else {
          console.log("Redirect success");
          setShowRedirectModal(false);
          setSelectedUserForRedirect(null);
        }
      },
    );
  };

  return (
    <div
      className="fixed right-4 top-16 bottom-20 w-72 bg-[#0d0e0d]/95 backdrop-blur-md border border-[#FEFCD9]/10 rounded-xl flex flex-col z-40 shadow-2xl overflow-hidden"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#FEFCD9]/10">
        <span
          className="text-[10px] uppercase tracking-[0.12em] text-[#FEFCD9]/60 flex items-center gap-1.5"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <Users className="w-3.5 h-3.5" />
          Participants
          <span className="text-[#F95F4A]">({displayParticipants.length})</span>
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center text-[#FEFCD9]/50 hover:text-[#FEFCD9] hover:bg-[#FEFCD9]/10 transition-all"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {isAdmin && (
        <div className="px-3 py-2 flex flex-col gap-2 border-b border-[#FEFCD9]/5">
          <div className="flex gap-1.5">
            <button
              onClick={() =>
                socket?.emit("muteAll", (res: unknown) =>
                  console.log("Muted all:", res),
                )
              }
              className="flex-1 text-[9px] py-1.5 rounded-md flex items-center justify-center gap-1 text-[#FEFCD9]/60 hover:text-[#F95F4A] hover:bg-[#F95F4A]/10 transition-all uppercase tracking-wider"
              title="Mute all"
            >
              <MicOff className="w-3 h-3" />
              Mute
            </button>
            <button
              onClick={() =>
                socket?.emit("closeAllVideo", (res: unknown) =>
                  console.log("Stopped all video:", res),
                )
              }
              className="flex-1 text-[9px] py-1.5 rounded-md flex items-center justify-center gap-1 text-[#FEFCD9]/60 hover:text-[#F95F4A] hover:bg-[#F95F4A]/10 transition-all uppercase tracking-wider"
              title="Stop all video"
            >
              <VideoOff className="w-3 h-3" />
              Video
            </button>
          </div>
        </div>
      )}

      {isAdmin && pendingList.length > 0 && (
        <div className="border-b border-[#FEFCD9]/5">
          <button
            type="button"
            onClick={() => setIsPendingExpanded((prev) => !prev)}
            className="w-full px-3 py-2 flex items-center justify-between hover:bg-[#F95F4A]/5 transition-colors"
            aria-expanded={isPendingExpanded}
          >
            <span className="text-[10px] text-[#F95F4A] uppercase tracking-wider flex items-center gap-1.5">
              Pending
              <span className="px-1.5 py-0.5 rounded bg-[#F95F4A]/20 text-[9px] tabular-nums">
                {pendingList.length}
              </span>
            </span>
            <ChevronDown
              className={`w-3 h-3 text-[#F95F4A] transition-transform ${
                isPendingExpanded ? "rotate-180" : ""
              }`}
            />
          </button>
          {isPendingExpanded && (
            <div className="px-3 pb-2 space-y-1 max-h-32 overflow-y-auto">
              {pendingList.map(([userId, displayName]) => {
                const pendingName = formatDisplayName(displayName || userId);
                return (
                  <div
                    key={userId}
                    className="flex items-center justify-between py-1.5 px-2 rounded-md bg-black/30"
                  >
                    <span className="text-xs text-[#FEFCD9]/70 truncate flex-1">
                      {pendingName}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
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
                        className="px-2 py-1 text-[9px] text-green-400 hover:bg-green-500/20 rounded transition-all"
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
                        className="px-2 py-1 text-[9px] text-red-400 hover:bg-red-500/20 rounded transition-all"
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

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5">
        {displayParticipants.map((p) => {
          const isMe = p.userId === currentUserId;
          const isHost = Boolean(
            effectiveHostUserId && p.userId === effectiveHostUserId,
          );
          const displayName = getDisplayName(p.userId);
          const userEmail = getEmailFromUserId(p.userId);
          const hasScreenShare =
            Boolean(p.screenShareStream) ||
            (isMe && Boolean(localState?.isScreenSharing));

          return (
            <div
              key={p.userId}
              className={`flex items-center justify-between px-2 py-1.5 rounded-md ${
                isMe ? "bg-[#F95F4A]/5" : "hover:bg-[#FEFCD9]/5"
              } transition-all`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-xs text-[#FEFCD9]/80">
                  {displayName}{" "}
                  {isMe && <span className="text-[#F95F4A]/60">(you)</span>}
                </span>
                {isHost && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">
                    Host
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {p.isHandRaised && <Hand className="w-3 h-3 text-amber-400" />}
                {hasScreenShare && (
                  <Monitor className="w-3 h-3 text-green-500" />
                )}
                {p.isCameraOff ? (
                  <VideoOff className="w-3 h-3 text-red-400/60" />
                ) : (
                  <Video className="w-3 h-3 text-green-500/60" />
                )}
                {p.isMuted ? (
                  <MicOff className="w-3 h-3 text-red-400/60" />
                ) : (
                  <Mic className="w-3 h-3 text-green-500/60" />
                )}
                {isAdmin && !isMe && (
                  <>
                    {p.videoProducerId && !p.isCameraOff && (
                      <button
                        onClick={() => handleCloseProducer(p.videoProducerId!)}
                        className="p-0.5 text-[#FEFCD9]/30 hover:text-red-400 transition-colors"
                        title="Stop video"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                    {p.audioProducerId && !p.isMuted && (
                      <button
                        onClick={() => handleCloseProducer(p.audioProducerId!)}
                        className="p-0.5 text-[#FEFCD9]/30 hover:text-red-400 transition-colors"
                        title="Mute"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                    <button
                      onClick={() => openRedirectModal(p.userId)}
                      className="p-0.5 text-[#FEFCD9]/30 hover:text-blue-400 transition-colors"
                      title="Redirect"
                    >
                      <ArrowRight className="w-2.5 h-2.5" />
                    </button>
                    <button
                      onClick={() =>
                        socket?.emit("kickUser", { userId: p.userId }, () => {})
                      }
                      className="p-0.5 text-[#FEFCD9]/30 hover:text-red-400 transition-colors"
                      title="Kick"
                    >
                      <UserMinus className="w-2.5 h-2.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showRedirectModal && (
        <div className="absolute inset-0 bg-[#0d0e0d]/98 backdrop-blur-sm z-20 flex flex-col p-3 rounded-xl">
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-[#FEFCD9]/5">
            <span className="text-[10px] uppercase tracking-wider text-[#FEFCD9]/60">
              Redirect to
            </span>
            <button
              onClick={() => setShowRedirectModal(false)}
              className="w-5 h-5 flex items-center justify-center text-[#FEFCD9]/40 hover:text-[#FEFCD9] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1">
            {filteredRooms.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-[#FEFCD9]/30 text-xs">
                No other rooms
              </div>
            ) : (
              filteredRooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => handleRedirect(room.id)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-[#FEFCD9]/5 transition-all flex justify-between items-center"
                >
                  <span className="text-xs text-[#FEFCD9]/80 truncate">
                    {room.id}
                  </span>
                  <span className="text-[10px] text-[#FEFCD9]/40 flex items-center gap-1">
                    <Users className="w-3 h-3" />
                    {room.userCount}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ParticipantsPanel);
