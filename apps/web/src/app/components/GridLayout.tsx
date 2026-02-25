"use client";

import { Ghost, Hand, MicOff } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Participant } from "../lib/types";
import { isSystemUserId, truncateDisplayName } from "../lib/utils";
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
  onOpenParticipantsPanel?: () => void;
  getDisplayName: (userId: string) => string;
}

const MAX_GRID_TILES = 16;
const isParticipantVideoOn = (participant: Participant) =>
  !participant.isCameraOff &&
  Boolean(participant.videoProducerId || participant.videoStream);

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
  onOpenParticipantsPanel,
  getDisplayName,
}: GridLayoutProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const stableOrderRef = useRef<string[]>([]);
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "shared" | "copied">(
    "idle"
  );
  const copyTimeoutRef = useRef<number | null>(null);
  const inviteTimeoutRef = useRef<number | null>(null);
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;
  const maxRemoteWithoutOverflow = Math.max(0, MAX_GRID_TILES - 1);

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

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      if (inviteTimeoutRef.current) {
        window.clearTimeout(inviteTimeoutRef.current);
      }
    };
  }, []);

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

    for (const participant of orderedRemoteParticipants) {
      if (isParticipantVideoOn(participant)) {
        withVideo.push(participant);
      } else {
        withoutVideo.push(participant);
      }
    }

    return withVideo.concat(withoutVideo);
  }, [orderedRemoteParticipants]);

  const stableRemoteParticipants = useMemo(() => {
    if (
      !activeSpeakerId ||
      activeSpeakerId === currentUserId ||
      maxRemoteWithoutOverflow <= 0
    ) {
      return prioritizedRemoteParticipants;
    }

    const activeSpeakerIndex = prioritizedRemoteParticipants.findIndex(
      (participant) => participant.userId === activeSpeakerId
    );
    if (activeSpeakerIndex < 0 || activeSpeakerIndex < maxRemoteWithoutOverflow) {
      return prioritizedRemoteParticipants;
    }

    const activeSpeaker = prioritizedRemoteParticipants[activeSpeakerIndex];
    if (!activeSpeaker || !isParticipantVideoOn(activeSpeaker)) {
      return prioritizedRemoteParticipants;
    }

    // If the active speaker is in the overflow panel, promote them into the top-16 band.
    const nextParticipants = [...prioritizedRemoteParticipants];
    const [speakerToPromote] = nextParticipants.splice(activeSpeakerIndex, 1);
    if (!speakerToPromote) return prioritizedRemoteParticipants;
    nextParticipants.splice(maxRemoteWithoutOverflow - 1, 0, speakerToPromote);
    return nextParticipants;
  }, [
    prioritizedRemoteParticipants,
    activeSpeakerId,
    currentUserId,
    maxRemoteWithoutOverflow,
  ]);

  useEffect(() => {
    stableOrderRef.current = stableRemoteParticipants.map(
      (participant) => participant.userId
    );
  }, [stableRemoteParticipants]);

  const hasOverflow = stableRemoteParticipants.length > maxRemoteWithoutOverflow;
  const isSolo = stableRemoteParticipants.length === 0;
  const maxVisibleRemoteParticipants = hasOverflow
    ? isOverflowOpen
      ? maxRemoteWithoutOverflow
      : Math.max(0, MAX_GRID_TILES - 2)
    : maxRemoteWithoutOverflow;
  const visibleParticipants = useMemo(() => {
    if (maxVisibleRemoteParticipants <= 0) {
      return [];
    }

    if (stableRemoteParticipants.length <= maxVisibleRemoteParticipants) {
      return stableRemoteParticipants;
    }

    const baseVisible = stableRemoteParticipants.slice(0, maxVisibleRemoteParticipants);

    if (!activeSpeakerId || activeSpeakerId === currentUserId) {
      return baseVisible;
    }

    if (baseVisible.some((participant) => participant.userId === activeSpeakerId)) {
      return baseVisible;
    }

    const activeParticipant = stableRemoteParticipants.find(
      (participant) => participant.userId === activeSpeakerId
    );
    if (!activeParticipant || !isParticipantVideoOn(activeParticipant)) {
      return baseVisible;
    }

    const nextVisible = baseVisible.slice(0, maxVisibleRemoteParticipants - 1);
    nextVisible.push(activeParticipant);
    return nextVisible;
  }, [
    stableRemoteParticipants,
    activeSpeakerId,
    currentUserId,
    maxVisibleRemoteParticipants,
  ]);

  const hiddenParticipants = useMemo(() => {
    const visibleIds = new Set(
      visibleParticipants.map((participant) => participant.userId)
    );
    return stableRemoteParticipants.filter(
      (participant) => !visibleIds.has(participant.userId)
    );
  }, [stableRemoteParticipants, visibleParticipants]);
  const hiddenParticipantsCount = hiddenParticipants.length;
  const showOverflowTile = hiddenParticipantsCount > 0;
  const showOverflowTileInGrid = showOverflowTile && !isOverflowOpen;
  const totalParticipants =
    visibleParticipants.length + 1 + (showOverflowTileInGrid ? 1 : 0);
  const overflowPreviewParticipants = hiddenParticipants.slice(0, 4);

  useEffect(() => {
    if (!showOverflowTile) {
      setIsOverflowOpen(false);
    }
  }, [showOverflowTile]);

  useEffect(() => {
    if (!isOverflowOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOverflowOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOverflowOpen]);

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

  const gridClass = getGridLayout(totalParticipants);

  const localSpeakerHighlight = isLocalActiveSpeaker 
    ? "speaking" 
    : "";

  const copyToClipboard = async (value: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  };

  const handleCopyLink = async () => {
    if (copyTimeoutRef.current) {
      window.clearTimeout(copyTimeoutRef.current);
    }
    try {
      await copyToClipboard(window.location.href);
      setCopyStatus("copied");
    } catch (error) {
      console.error("[Meets] Failed to copy meeting link:", error);
      setCopyStatus("copied");
    }
    copyTimeoutRef.current = window.setTimeout(() => {
      setCopyStatus("idle");
    }, 2000);
  };

  const handleInvite = async () => {
    if (inviteTimeoutRef.current) {
      window.clearTimeout(inviteTimeoutRef.current);
    }
    const meetingLink = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Conclave meeting",
          text: "Join me in this Conclave room.",
          url: meetingLink,
        });
        setInviteStatus("shared");
      } else {
        await copyToClipboard(meetingLink);
        setInviteStatus("copied");
      }
    } catch (error) {
      return;
    }
    inviteTimeoutRef.current = window.setTimeout(() => {
      setInviteStatus("idle");
    }, 2400);
  };

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div className={`flex-1 min-h-0 grid ${gridClass} gap-3 overflow-hidden p-4`}>
        <div
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
          {isSolo ? (
            <div className="absolute top-3 left-3 w-[304px] rounded-xl border border-[#FEFCD9]/10 bg-black/60 px-4 py-3 text-[#FEFCD9] shadow-[0_10px_28px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <p className="text-[15px] font-semibold leading-tight">
                You are the only person here
              </p>
              <p className="mt-1 text-xs text-[#FEFCD9]/60">
                Invite people to join this room.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={handleInvite}
                  className="flex-1 rounded-lg border border-[#FEFCD9]/18 bg-white/[0.05] px-3 py-2 text-xs font-medium text-[#FEFCD9] transition-colors hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEFCD9]/20"
                >
                  {inviteStatus === "shared"
                    ? "Invite sent"
                    : inviteStatus === "copied"
                    ? "Link copied"
                    : "Invite people"}
                </button>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="flex-1 rounded-lg border border-[#FEFCD9]/14 bg-transparent px-3 py-2 text-xs font-medium text-[#FEFCD9]/85 transition-colors hover:bg-white/[0.04] hover:text-[#FEFCD9] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEFCD9]/20"
                >
                  {copyStatus === "copied" ? "Link copied" : "Copy link"}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {visibleParticipants.map((participant) => (
          <ParticipantVideo
            key={participant.userId}
            participant={participant}
            displayName={getDisplayName(participant.userId)}
            isActiveSpeaker={activeSpeakerId === participant.userId}
            audioOutputDeviceId={audioOutputDeviceId}
            isAdmin={isAdmin}
            isSelected={selectedParticipantId === participant.userId}
            onAdminClick={onParticipantClick}
          />
        ))}

        {showOverflowTileInGrid ? (
          <button
            type="button"
            onClick={() => setIsOverflowOpen((prev) => !prev)}
            aria-expanded={isOverflowOpen}
            aria-label={`View ${hiddenParticipantsCount} more participants`}
            title={isOverflowOpen ? "Hide overflow" : "Peek at hidden participants"}
            className={`acm-video-tile group relative flex flex-col items-center justify-center border-dashed border-[#FEFCD9]/20 bg-[#0d0e0d] text-[#FEFCD9] shadow-[inset_0_0_0_1px_rgba(254,252,217,0.04)] transition-all duration-300 hover:border-[#F95F4A]/50 ${
              isOverflowOpen ? "ring-2 ring-[#F95F4A]/30" : ""
            }`}
            style={{ fontFamily: "'PolySans Trial', sans-serif" }}
          >
            <div className="absolute inset-2 rounded-xl border border-[#FEFCD9]/5" />
            <div className="absolute inset-3 grid grid-cols-2 grid-rows-2 gap-2 opacity-35 transition-opacity duration-200 group-hover:opacity-65">
              {overflowPreviewParticipants.map((participant) => (
                <OverflowPreviewTile
                  key={participant.userId}
                  participant={participant}
                  displayName={getDisplayName(participant.userId)}
                />
              ))}
            </div>
            <div className="relative z-10 flex flex-col items-center gap-2 text-center px-4">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold text-[#FEFCD9]">
                  +{hiddenParticipantsCount}
                </span>
                <span
                  className="text-[10px] uppercase tracking-[0.35em] text-[#FEFCD9]/55"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  More
                </span>
              </div>
              <div className="h-[1px] w-12 bg-[#F95F4A]/50" />
              <div className="rounded-full border border-[#FEFCD9]/15 bg-black/60 px-3 py-1 text-[9px] uppercase tracking-[0.25em] text-[#FEFCD9]/70 transition-colors duration-200 group-hover:border-[#F95F4A]/50 group-hover:text-[#FEFCD9]">
                {isOverflowOpen ? "Hide panel" : "Show panel"}
              </div>
            </div>
          </button>
        ) : null}
      </div>

      {showOverflowTile ? (
        <div
          className={`overflow-hidden transition-all duration-300 ${
            isOverflowOpen
              ? "max-h-64 opacity-100 mt-3 pointer-events-auto"
              : "max-h-0 opacity-0 mt-0 pointer-events-none"
          }`}
        >
          <div
            className="relative w-full overflow-hidden rounded-xl border border-[#FEFCD9]/10 bg-[#0d0e0d]/95 shadow-2xl backdrop-blur-md"
          >
            <div className="relative flex items-center justify-between border-b border-[#FEFCD9]/10 px-4 py-3">
              <div>
                <span
                  className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[#FEFCD9]/70"
                  style={{ fontFamily: "'PolySans Mono', monospace" }}
                >
                  More participants
                  <span className="text-[#F95F4A]">({hiddenParticipantsCount})</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                {onOpenParticipantsPanel ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOverflowOpen(false);
                      onOpenParticipantsPanel();
                    }}
                    className="rounded-full border border-[#FEFCD9]/15 bg-black/50 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]/70 transition-colors duration-200 hover:border-[#F95F4A]/50 hover:text-[#FEFCD9]"
                  >
                    Full list
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setIsOverflowOpen(false)}
                  className="rounded-full border border-[#FEFCD9]/15 bg-black/60 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[#FEFCD9]/70 transition-colors duration-200 hover:border-[#F95F4A]/50 hover:text-[#FEFCD9]"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="relative grid grid-flow-col auto-cols-[11rem] gap-3 overflow-x-auto px-4 pb-4 pt-4 snap-x snap-mandatory">
              {hiddenParticipants.map((participant) => (
                <OverflowGalleryTile
                  key={participant.userId}
                  participant={participant}
                  displayName={getDisplayName(participant.userId)}
                  isActiveSpeaker={activeSpeakerId === participant.userId}
                  isAdmin={isAdmin}
                  onParticipantClick={onParticipantClick}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const OverflowPreviewTile = memo(function OverflowPreviewTile({
  participant,
  displayName,
}: {
  participant: Participant;
  displayName: string;
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

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-[#FEFCD9]/10 bg-[#0d0e0d]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`h-full w-full object-cover ${showPlaceholder ? "hidden" : ""}`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
          <span className="text-sm font-semibold text-[#FEFCD9]/70">
            {displayName[0]?.toUpperCase() || "?"}
          </span>
        </div>
      )}
    </div>
  );
});

const OverflowGalleryTile = memo(function OverflowGalleryTile({
  participant,
  displayName,
  isActiveSpeaker,
  isAdmin,
  onParticipantClick,
}: {
  participant: Participant;
  displayName: string;
  isActiveSpeaker: boolean;
  isAdmin: boolean;
  onParticipantClick?: (userId: string) => void;
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
  const tileLabel = truncateDisplayName(displayName, 18);
  const isClickable = isAdmin && Boolean(onParticipantClick);
  const handleClick = () => {
    if (isClickable && onParticipantClick) {
      onParticipantClick(participant.userId);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isClickable}
      title={displayName}
      className={`acm-video-tile group relative flex h-28 w-44 shrink-0 flex-col overflow-hidden text-left snap-start ${
        isActiveSpeaker ? "speaking" : ""
      } ${isClickable ? "cursor-pointer hover:border-[#F95F4A]/40" : "cursor-default opacity-85"}`}
    >
      <div className="relative h-full w-full">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`h-full w-full object-cover ${showPlaceholder ? "hidden" : ""}`}
        />
        {showPlaceholder && (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0d0e0d]">
            <span className="text-xl font-semibold text-[#FEFCD9]">
              {tileLabel[0]?.toUpperCase() || "?"}
            </span>
          </div>
        )}
        {participant.isGhost && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <Ghost className="h-8 w-8 text-[#FF007A] drop-shadow-[0_0_14px_rgba(255,0,122,0.5)]" />
          </div>
        )}
        {participant.isHandRaised && (
          <div className="absolute top-2 left-2 rounded-full border border-amber-400/40 bg-amber-500/20 p-1 text-amber-300">
            <Hand className="h-3 w-3" />
          </div>
        )}
        <div
          className="absolute bottom-2 left-2 flex max-w-[80%] items-center gap-2 rounded-full border border-[#FEFCD9]/10 bg-black/55 px-2 py-1 text-[10px] uppercase tracking-wide text-[#FEFCD9]/80"
          style={{ fontFamily: "'PolySans Mono', monospace" }}
        >
          <span className="truncate">{tileLabel}</span>
          {participant.isMuted && <MicOff className="h-3 w-3 text-[#F95F4A]" />}
        </div>
      </div>
    </button>
  );
});

export default memo(GridLayout);
