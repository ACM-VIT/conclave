"use client";

import { Ghost, Hand, MicOff } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Participant } from "../lib/types";
import { isSystemUserId, reorderOverflowActiveSpeakers } from "../lib/utils";
import ParticipantVideo from "./ParticipantVideo";

interface GridLayoutProps {
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isGhost: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  isAdmin?: boolean;
  selectedParticipantId?: string | null;
  onParticipantClick?: (userId: string) => void;
  getDisplayName: (userId: string) => string;
  pageIndex: number;
  onPageIndexChange: (pageIndex: number) => void;
  onTotalPagesChange: (totalPages: number) => void;
}

const TILES_PER_PAGE = 16;

type GridTile =
  | { kind: "local" }
  | { kind: "remote"; participant: Participant };

function GridLayout({
  localStream,
  isCameraOff,
  isMuted,
  isHandRaised,
  isGhost,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  currentUserId,
  audioOutputDeviceId,
  isAdmin = false,
  selectedParticipantId,
  onParticipantClick,
  getDisplayName,
  pageIndex,
  onPageIndexChange,
  onTotalPagesChange,
}: GridLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const overflowSpeakerHistoryRef = useRef<string[]>([]);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Grid local video play error:", err);
        }
      });
    }
  }, [localStream]);

  const remoteParticipants = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) =>
          !isSystemUserId(participant.userId) &&
          participant.userId !== currentUserId
      ),
    [participants, currentUserId]
  );

  const orderedRemoteParticipants = useMemo(() => {
    const { orderedParticipants: nextParticipants, nextOverflowSpeakerHistory } =
      reorderOverflowActiveSpeakers(
        remoteParticipants,
        remoteParticipants,
        activeSpeakerId,
        currentUserId,
        overflowSpeakerHistoryRef.current
      );
    overflowSpeakerHistoryRef.current = nextOverflowSpeakerHistory;
    return nextParticipants;
  }, [activeSpeakerId, currentUserId, remoteParticipants]);
  const totalParticipants = orderedRemoteParticipants.length + 1;
  const totalPages = Math.max(1, Math.ceil(totalParticipants / TILES_PER_PAGE));
  const currentPage = Math.min(Math.max(0, pageIndex), totalPages - 1);

  useEffect(() => {
    onTotalPagesChange(totalPages);
  }, [onTotalPagesChange, totalPages]);

  useEffect(() => {
    if (pageIndex !== currentPage) {
      onPageIndexChange(currentPage);
    }
  }, [currentPage, onPageIndexChange, pageIndex]);

  const pageTiles = useMemo(() => {
    const allTiles: GridTile[] = [
      { kind: "local" },
      ...orderedRemoteParticipants.map((participant) => ({
        kind: "remote" as const,
        participant,
      })),
    ];
    const start = currentPage * TILES_PER_PAGE;
    return allTiles.slice(start, start + TILES_PER_PAGE);
  }, [orderedRemoteParticipants, currentPage]);

  const localDisplayName = getDisplayName(currentUserId);

  const getGridLayout = (count: number) => {
    if (count === 1) return "grid-cols-1 grid-rows-1";
    if (count === 2) return "grid-cols-2 grid-rows-1";
    if (count === 3) return "grid-cols-3 grid-rows-1";
    if (count === 4) return "grid-cols-2 grid-rows-2";
    if (count <= 6) return "grid-cols-3 grid-rows-2";
    if (count <= 9) return "grid-cols-3 grid-rows-3";
    if (count <= 12) return "grid-cols-4 grid-rows-3";
    if (count <= 16) return "grid-cols-4 grid-rows-4";
    return "grid-cols-3 sm:grid-cols-4 xl:grid-cols-5 auto-rows-[minmax(150px,1fr)]";
  };

  const gridClass =
    totalPages > 1 ? "grid-cols-4 grid-rows-4" : getGridLayout(totalParticipants);

  const localSpeakerHighlight = isLocalActiveSpeaker 
    ? "speaking" 
    : "";

  return (
    <div className="relative flex-1 min-h-0">
      <div className={`h-full grid ${gridClass} gap-3 overflow-hidden p-4`}>
        {pageTiles.map((tile) =>
          tile.kind === "local" ? (
            <div
              key={currentUserId}
              className={`acm-video-tile ${localSpeakerHighlight}`}
              style={{ fontFamily: "'PolySans Trial', sans-serif" }}
            >
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={`w-full h-full object-cover ${
                  isCameraOff ? "hidden" : ""
                } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
              />
              {isCameraOff && (
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#F95F4A]/20 to-[#FF007A]/20 border border-[#FEFCD9]/20 flex items-center justify-center text-3xl text-[#FEFCD9] font-bold">
                    {userEmail[0]?.toUpperCase() || "?"}
                  </div>
                </div>
              )}
              {isGhost && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/40">
                  <div className="flex flex-col items-center gap-2">
                    <Ghost className="w-16 h-16 text-[#FF007A] drop-shadow-[0_0_22px_rgba(255,0,122,0.5)]" />
                    <span
                      className="text-[11px] text-[#FF007A] bg-black/60 border border-[#FF007A]/30 px-3 py-1 rounded-full uppercase tracking-[0.1em]"
                      style={{ fontFamily: "'PolySans Mono', monospace" }}
                    >
                      Ghost
                    </span>
                  </div>
                </div>
              )}
              {isHandRaised && (
                <div
                  className="absolute top-3 left-3 p-2 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]"
                  title="Hand raised"
                >
                  <Hand className="w-4 h-4" />
                </div>
              )}
              <div
                className="absolute bottom-3 left-3 px-3 py-1.5 bg-black/70 backdrop-blur-sm border border-[#FEFCD9]/10 rounded-full text-xs flex items-center gap-2 text-[#FEFCD9] uppercase tracking-wide"
                style={{ fontFamily: "'PolySans Mono', monospace" }}
              >
                <div className="flex items-center gap-1">
                  <span className="font-medium text-[#FEFCD9] uppercase tracking-wide">
                    {localDisplayName}
                  </span>
                  <span className="text-[9px] text-[#F95F4A]/60 uppercase tracking-[0.15em]">
                    You
                  </span>
                </div>
                {isMuted && <MicOff className="w-3 h-3 text-[#F95F4A]" />}
              </div>
            </div>
          ) : (
            <ParticipantVideo
              key={tile.participant.userId}
              participant={tile.participant}
              displayName={getDisplayName(tile.participant.userId)}
              isActiveSpeaker={activeSpeakerId === tile.participant.userId}
              audioOutputDeviceId={audioOutputDeviceId}
              isAdmin={isAdmin}
              isSelected={selectedParticipantId === tile.participant.userId}
              onAdminClick={onParticipantClick}
            />
          )
        )}
      </div>
    </div>
  );
}

export default memo(GridLayout);
