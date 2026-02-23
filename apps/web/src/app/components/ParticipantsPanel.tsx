"use client";

import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  Hand,
  Mic,
  MicOff,
  Monitor,
  UserMinus,
  Users,
  Video,
  VideoOff,
  X,
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
  const [showRedirectModal, setShowRedirectModal] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [selectedUserForRedirect, setSelectedUserForRedirect] = useState<
    string | null
  >(null);
  const [isPendingExpanded, setIsPendingExpanded] = useState(true);
  const filteredRooms = availableRooms.filter((room) => room.id !== roomId);
  const effectiveHostUserId = hostUserId ?? (isAdmin ? currentUserId : null);

  const hostBulkButtonClass =
    "flex-1 rounded-md border border-[#FEFCD9]/15 bg-[#FEFCD9]/5 py-1.5 text-[10px] uppercase tracking-[0.08em] text-[#FEFCD9]/75 transition-all hover:border-[#F95F4A]/45 hover:bg-[#F95F4A]/10 hover:text-[#FEFCD9]";
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
      className="fixed right-4 top-16 bottom-20 z-40 flex w-72 flex-col overflow-hidden rounded-xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 shadow-2xl backdrop-blur-md"
      style={{ fontFamily: "'PolySans Trial', sans-serif" }}
    >
      <div className="flex items-center justify-between border-b border-[#FEFCD9]/10 px-3 py-2.5">
        <span
          className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[#FEFCD9]/70"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <Users className="h-3.5 w-3.5" />
          Participants
          <span className="text-[#F95F4A]">({displayParticipants.length})</span>
        </span>
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
          <div className="mb-1.5 flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] text-[#FEFCD9]/45">
            <AlertCircle className="h-3 w-3" />
            Host controls
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() =>
                socket?.emit("muteAll", (res: unknown) =>
                  console.log("Muted all:", res),
                )
              }
              className={hostBulkButtonClass}
              title="Mute all"
            >
              <span className="inline-flex items-center justify-center gap-1">
                <MicOff className="h-3.5 w-3.5" />
                Mute all
              </span>
            </button>
            <button
              onClick={() =>
                socket?.emit("closeAllVideo", (res: unknown) =>
                  console.log("Stopped all video:", res),
                )
              }
              className={hostBulkButtonClass}
              title="Stop all video"
            >
              <span className="inline-flex items-center justify-center gap-1">
                <VideoOff className="h-3.5 w-3.5" />
                Stop video
              </span>
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
          const isHost = Boolean(
            effectiveHostUserId && participant.userId === effectiveHostUserId,
          );
          const displayName = formatDisplayName(
            getDisplayName(participant.userId),
          );
          const userEmail = getEmailFromUserId(participant.userId);
          const hasScreenShare =
            Boolean(participant.screenShareStream) ||
            (isMe && Boolean(localState?.isScreenSharing));

          return (
            <div
              key={participant.userId}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 transition-all ${
                isMe ? "bg-[#F95F4A]/5" : "hover:bg-[#FEFCD9]/5"
              }`}
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
                {isAdmin && !isMe && (
                  <>
                    {participant.videoProducerId && !participant.isCameraOff && (
                      <button
                        onClick={() =>
                          handleCloseProducer(participant.videoProducerId!)
                        }
                        className={`${hostUserActionButtonClass} hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300`}
                        title="Stop video"
                        aria-label="Stop participant video"
                      >
                        <VideoOff className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {participant.audioProducerId && !participant.isMuted && (
                      <button
                        onClick={() =>
                          handleCloseProducer(participant.audioProducerId!)
                        }
                        className={`${hostUserActionButtonClass} hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-300`}
                        title="Mute"
                        aria-label="Mute participant"
                      >
                        <MicOff className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => openRedirectModal(participant.userId)}
                      className={`${hostUserActionButtonClass} hover:border-blue-400/45 hover:bg-blue-500/10 hover:text-blue-300`}
                      title="Redirect"
                      aria-label="Redirect participant"
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        socket?.emit(
                          "kickUser",
                          { userId: participant.userId },
                          () => {},
                        )
                      }
                      className={`${hostUserActionButtonClass} hover:border-red-400/45 hover:bg-red-500/10 hover:text-red-300`}
                      title="Kick"
                      aria-label="Kick participant"
                    >
                      <UserMinus className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showRedirectModal && (
        <div className="absolute inset-0 z-20 flex flex-col rounded-xl bg-[#0d0e0d]/98 p-3 backdrop-blur-sm">
          <div className="mb-3 flex items-center justify-between border-b border-[#FEFCD9]/5 pb-2">
            <span className="text-[10px] uppercase tracking-wider text-[#FEFCD9]/60">
              Redirect to
            </span>
            <button
              onClick={() => setShowRedirectModal(false)}
              className="flex h-5 w-5 items-center justify-center text-[#FEFCD9]/40 transition-colors hover:text-[#FEFCD9]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto">
            {filteredRooms.length === 0 ? (
              <div className="flex h-20 items-center justify-center text-xs text-[#FEFCD9]/30">
                No other rooms
              </div>
            ) : (
              filteredRooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => handleRedirect(room.id)}
                  className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left transition-all hover:bg-[#FEFCD9]/5"
                >
                  <span className="truncate text-xs text-[#FEFCD9]/80">
                    {room.id}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-[#FEFCD9]/40">
                    <Users className="h-3 w-3" />
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
