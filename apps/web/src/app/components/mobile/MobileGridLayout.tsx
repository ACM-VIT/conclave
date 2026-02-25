"use client";

import { Hand, MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";
import ParticipantAudio from "../ParticipantAudio";

interface MobileGridLayoutProps {
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
  onOpenParticipantsPanel?: () => void;
  getDisplayName: (userId: string) => string;
}

const MAX_GRID_TILES = 8;
const isParticipantVideoOn = (participant: Participant) =>
  !participant.isCameraOff &&
  Boolean(participant.videoProducerId || participant.videoStream);

function MobileGridLayout({
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
  onOpenParticipantsPanel,
  getDisplayName,
}: MobileGridLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const stableOrderRef = useRef<string[]>([]);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && localStream) {
      video.srcObject = localStream;
      video.play().catch((err) => {
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile grid local video play error:", err);
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

  const stableRemoteParticipants = useMemo(() => {
    const participantMap = new Map(
      remoteParticipants.map((participant) => [participant.userId, participant])
    );
    const nextOrder: string[] = [];
    const seen = new Set<string>();

    for (const userId of stableOrderRef.current) {
      if (participantMap.has(userId)) {
        nextOrder.push(userId);
        seen.add(userId);
      }
    }

    for (const participant of remoteParticipants) {
      if (!seen.has(participant.userId)) {
        nextOrder.push(participant.userId);
        seen.add(participant.userId);
      }
    }

    return nextOrder
      .map((userId) => participantMap.get(userId))
      .filter((participant): participant is Participant => Boolean(participant));
  }, [remoteParticipants]);

  const prioritizedRemoteParticipants = useMemo(() => {
    const withVideo: Participant[] = [];
    const withoutVideo: Participant[] = [];

    for (const participant of stableRemoteParticipants) {
      if (isParticipantVideoOn(participant)) {
        withVideo.push(participant);
      } else {
        withoutVideo.push(participant);
      }
    }

    return withVideo.concat(withoutVideo);
  }, [stableRemoteParticipants]);

  useEffect(() => {
    stableOrderRef.current = stableRemoteParticipants.map(
      (participant) => participant.userId
    );
  }, [stableRemoteParticipants]);

  const maxRemoteWithoutOverflow = Math.max(0, MAX_GRID_TILES - 1);
  const hasOverflow = prioritizedRemoteParticipants.length > maxRemoteWithoutOverflow;
  const maxVisibleRemoteParticipants = maxRemoteWithoutOverflow;
  const visibleParticipants = useMemo(() => {
    if (maxVisibleRemoteParticipants <= 0) {
      return [];
    }

    if (prioritizedRemoteParticipants.length <= maxVisibleRemoteParticipants) {
      return prioritizedRemoteParticipants;
    }

    const baseVisible = prioritizedRemoteParticipants.slice(0, maxVisibleRemoteParticipants);

    if (!activeSpeakerId || activeSpeakerId === currentUserId) {
      return baseVisible;
    }

    if (baseVisible.some((participant) => participant.userId === activeSpeakerId)) {
      return baseVisible;
    }

    const activeParticipant = prioritizedRemoteParticipants.find(
      (participant) => participant.userId === activeSpeakerId
    );
    if (!activeParticipant || !isParticipantVideoOn(activeParticipant)) {
      return baseVisible;
    }

    const nextVisible = baseVisible.slice(0, maxVisibleRemoteParticipants - 1);
    nextVisible.push(activeParticipant);
    return nextVisible;
  }, [
    prioritizedRemoteParticipants,
    activeSpeakerId,
    currentUserId,
    maxVisibleRemoteParticipants,
  ]);
  const hiddenParticipantsCount = Math.max(
    0,
    prioritizedRemoteParticipants.length - visibleParticipants.length
  );
  const showOverflowTile = hiddenParticipantsCount > 0;
  const totalCount = visibleParticipants.length + 1 + (showOverflowTile ? 1 : 0);
  const localDisplayName = truncateDisplayName(
    getDisplayName(currentUserId) || userEmail || "You",
    totalCount <= 2 ? 16 : totalCount <= 4 ? 12 : 10
  );

  // Determine grid layout based on participant count
  const getGridClass = () => {
    if (totalCount === 1) return "grid-cols-1 grid-rows-1";
    if (totalCount === 2) return "grid-cols-1 grid-rows-2";
    if (totalCount <= 4) return "grid-cols-2 grid-rows-2";
    if (totalCount <= 6) return "grid-cols-2 grid-rows-3";
    if (totalCount <= 9) return "grid-cols-3 grid-rows-3";
    return "grid-cols-3 auto-rows-fr"; // 10+ participants
  };

  const speakerRing = (isActive: boolean) =>
    isActive ? "mobile-tile-active" : "";
  const maxLabelLength = totalCount <= 2 ? 16 : totalCount <= 4 ? 12 : 10;

  return (
    <div className="relative w-full h-full">
      <div
        className="pointer-events-none absolute h-0 w-0 overflow-hidden"
        aria-hidden={true}
      >
        {prioritizedRemoteParticipants.map((participant) => (
          <ParticipantAudio
            key={`audio-${participant.userId}`}
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
          />
        ))}
      </div>

      <div className={`w-full h-full grid ${getGridClass()} gap-3 p-3 auto-rows-fr`}>
        {/* Local video tile */}
        <div
          className={`mobile-tile ${speakerRing(isLocalActiveSpeaker)}`}
        >
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className={`w-full h-full object-cover ${isCameraOff ? "hidden" : ""} ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
          />
          {isCameraOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
              <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
              <div
                className={`relative rounded-full mobile-avatar flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}
                style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
              >
                {userEmail[0]?.toUpperCase() || "?"}
              </div>
            </div>
          )}
          {isGhost && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
              <div className="flex flex-col items-center gap-2">
                <VenetianMask
                  className={`text-[#FF007A] ${totalCount <= 2 ? "w-10 h-10" : "w-8 h-8"}`}
                />
                <span
                  className="mobile-ghost-badge rounded-full px-3 py-1 text-[10px] tracking-[0.25em] text-[#FF007A]"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  GHOST
                </span>
              </div>
            </div>
          )}
          {isHandRaised && (
            <div className="absolute top-2 left-2 p-2 rounded-full mobile-hand-badge text-amber-200">
              <Hand className="w-3.5 h-3.5" />
            </div>
          )}
          {/* Name label */}
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
            <div
              className="mobile-name-pill px-2.5 py-1 flex items-center gap-2 backdrop-blur-md"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              <span className={`text-[#FEFCD9] font-medium uppercase tracking-[0.18em] truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
                {localDisplayName}
              </span>
              <span className="text-[9px] uppercase tracking-[0.25em] text-[#F95F4A]/70">
                YOU
              </span>
              {isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
            </div>
          </div>
        </div>

        {/* Participant tiles */}
        {visibleParticipants.map((participant) => (
          <ParticipantTile
            key={participant.userId}
            participant={participant}
            displayName={truncateDisplayName(
              getDisplayName(participant.userId),
              maxLabelLength
            )}
            isActiveSpeaker={activeSpeakerId === participant.userId}
            totalCount={totalCount}
          />
        ))}

        {showOverflowTile ? (
          <button
            type="button"
            onClick={onOpenParticipantsPanel}
            disabled={!onOpenParticipantsPanel}
            aria-label={`View ${hiddenParticipantsCount} more participants`}
            className={`mobile-tile flex flex-col items-center justify-center border-dashed border-[#FEFCD9]/20 bg-[#0d0e0d]/85 text-[#FEFCD9] ${
              onOpenParticipantsPanel ? "cursor-pointer" : "opacity-70"
            }`}
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <div className="text-2xl font-semibold text-[#FEFCD9]">
              +{hiddenParticipantsCount}
            </div>
            <div
              className="mt-1 text-[10px] uppercase tracking-[0.35em] text-[#FEFCD9]/60"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              More
            </div>
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Separate component for participant tiles
const ParticipantTile = memo(function ParticipantTile({
  participant,
  displayName,
  isActiveSpeaker,
  totalCount,
}: {
  participant: Participant;
  displayName: string;
  isActiveSpeaker: boolean;
  totalCount: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!participant.videoStream || participant.isCameraOff) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== participant.videoStream) {
      video.srcObject = participant.videoStream;
    }

    const playVideo = () => {
      video.play().catch(() => {});
    };

    playVideo();

    const videoTrack = participant.videoStream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.addEventListener("unmute", playVideo);

    return () => {
      videoTrack.removeEventListener("unmute", playVideo);
    };
  }, [participant.videoStream, participant.videoProducerId, participant.isCameraOff]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;
  const speakerRing = isActiveSpeaker ? "mobile-tile-active" : "";

  return (
    <div
      className={`mobile-tile ${speakerRing}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover ${showPlaceholder ? "hidden" : ""}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0e0d]">
          <div className="absolute inset-0 bg-gradient-to-br from-[#F95F4A]/15 to-[#FF007A]/10" />
          <div
            className={`relative rounded-full mobile-avatar flex items-center justify-center text-[#FEFCD9] font-bold ${totalCount <= 2 ? "w-20 h-20 text-3xl" : totalCount <= 4 ? "w-14 h-14 text-xl" : "w-10 h-10 text-lg"}`}
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none mobile-ghost-overlay">
          <div className="flex flex-col items-center gap-2">
            <VenetianMask
              className={`text-[#FF007A] ${totalCount <= 2 ? "w-10 h-10" : "w-8 h-8"}`}
            />
            <span
              className="mobile-ghost-badge rounded-full px-3 py-1 text-[10px] tracking-[0.25em] text-[#FF007A]"
              style={{ fontFamily: "'PolySans Mono', monospace" }}
            >
              GHOST
            </span>
          </div>
        </div>
      )}
      {participant.isHandRaised && (
        <div className="absolute top-2 left-2 p-2 rounded-full mobile-hand-badge text-amber-200">
          <Hand className="w-3.5 h-3.5" />
        </div>
      )}
      {/* Name label */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
        <div 
          className="mobile-name-pill px-2.5 py-1 flex items-center gap-2 max-w-full backdrop-blur-md"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <span className={`text-[#FEFCD9] font-medium uppercase tracking-[0.18em] truncate ${totalCount <= 4 ? "text-xs" : "text-[10px]"}`}>
            {displayName}
          </span>
          {participant.isMuted && <MicOff className="w-3 h-3 text-[#F95F4A] shrink-0" />}
        </div>
      </div>
    </div>
  );
});

export default memo(MobileGridLayout);
