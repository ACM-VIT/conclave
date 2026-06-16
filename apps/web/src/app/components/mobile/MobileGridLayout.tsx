"use client";

import { Hand, MicOff, VenetianMask } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type RefObject } from "react";
import { useSmartParticipantOrder } from "../../hooks/useSmartParticipantOrder";
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

type TileVariant = "solo" | "primary" | "rail";

type MobileTileDescriptor =
  | { kind: "local"; key: "local" }
  | {
      kind: "remote";
      key: string;
      participant: Participant;
      displayName: string;
    }
  | { kind: "overflow"; key: "overflow"; count: number };

const MAX_MOBILE_RAIL_TILES = 6;

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

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;

    if (!localStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    video.srcObject = localStream;
    video.play().catch((err) => {
      if (err.name !== "AbortError") {
        console.error("[Meets] Mobile grid local video play error:", err);
      }
    });

    return () => {
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [localStream]);

  const orderedRemoteParticipants = useSmartParticipantOrder(
    Array.from(participants.values()).filter(
      (participant) =>
        !isSystemUserId(participant.userId) &&
        participant.userId !== currentUserId,
    ),
    activeSpeakerId,
  );

  const localDisplayName = truncateDisplayName(
    getDisplayName(currentUserId) || userEmail || "You",
    20,
  );

  const remoteTiles = useMemo<MobileTileDescriptor[]>(() => {
    return orderedRemoteParticipants.map((participant) => ({
      kind: "remote",
      key: participant.userId,
      participant,
      displayName: truncateDisplayName(getDisplayName(participant.userId), 20),
    }));
  }, [getDisplayName, orderedRemoteParticipants]);

  const { primaryTile, railTiles, hiddenParticipantsCount } = useMemo(() => {
    const localTile: MobileTileDescriptor = { kind: "local", key: "local" };
    const remoteTileList = remoteTiles.filter(
      (tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote",
    );
    const primaryRemote =
      remoteTileList.find(
        (tile) => tile.participant.userId === activeSpeakerId,
      ) ??
      remoteTileList.find((tile) => hasLiveVideo(tile.participant)) ??
      remoteTileList.find((tile) => hasLiveAudio(tile.participant)) ??
      (remoteTileList.length > 0 ? remoteTileList[0] : null);
    const primary = primaryRemote ?? localTile;
    const secondaryTiles: MobileTileDescriptor[] = [
      ...(primary.kind === "local" ? [] : [localTile]),
      ...remoteTileList.filter((tile) => tile.key !== primary.key),
    ];

    if (secondaryTiles.length <= MAX_MOBILE_RAIL_TILES) {
      return {
        primaryTile: primary,
        railTiles: secondaryTiles,
        hiddenParticipantsCount: 0,
      };
    }

    const visibleRailTiles = secondaryTiles.slice(0, MAX_MOBILE_RAIL_TILES - 1);
    const hiddenCount = secondaryTiles.length - visibleRailTiles.length;
    const overflowTile: MobileTileDescriptor = {
      kind: "overflow",
      key: "overflow",
      count: hiddenCount,
    };
    return {
      primaryTile: primary,
      railTiles: [...visibleRailTiles, overflowTile],
      hiddenParticipantsCount: hiddenCount,
    };
  }, [activeSpeakerId, remoteTiles]);

  const totalPeople = orderedRemoteParticipants.length + 1;
  const layoutMode = railTiles.length === 0 ? "solo" : "stage-rail";

  const renderTile = (tile: MobileTileDescriptor, variant: TileVariant) => {
    if (tile.kind === "local") {
      return (
        <LocalTile
          key={tile.key}
          variant={variant}
          videoRef={localVideoRef}
          stream={localStream}
          displayName={localDisplayName}
          userEmail={userEmail}
          isCameraOff={isCameraOff}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          isGhost={isGhost}
          isMirrorCamera={isMirrorCamera}
          isActiveSpeaker={activeSpeakerId === currentUserId}
        />
      );
    }

    if (tile.kind === "overflow") {
      return (
        <button
          key={tile.key}
          type="button"
          onClick={onOpenParticipantsPanel}
          disabled={!onOpenParticipantsPanel}
          aria-label={`View ${tile.count} more participants`}
          className={`mobile-tile flex h-full min-h-[112px] flex-col items-center justify-center border-dashed border-[#fafafa]/18 bg-[#131316] text-[#fafafa] ${
            onOpenParticipantsPanel ? "cursor-pointer" : "opacity-70"
          }`}
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          <div className="text-2xl font-semibold">+{tile.count}</div>
          <div className="mt-1 text-[12px] font-medium text-[#fafafa]/70">
            More
          </div>
        </button>
      );
    }

    return (
      <ParticipantTile
        key={tile.key}
        variant={variant}
        participant={tile.participant}
        displayName={tile.displayName}
        isActiveSpeaker={activeSpeakerId === tile.participant.userId}
      />
    );
  };

  return (
    <div
      className="relative h-full w-full"
      data-mobile-meet-layout={layoutMode}
      data-mobile-primary={primaryTile.key}
      data-mobile-rail-count={railTiles.length}
      data-mobile-hidden-count={hiddenParticipantsCount}
      data-mobile-total-people={totalPeople}
    >
      <div
        className="pointer-events-none absolute h-0 w-0 overflow-hidden"
        aria-hidden={true}
      >
        {orderedRemoteParticipants.map((participant) => (
          <ParticipantAudio
            key={`audio-${participant.userId}`}
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
          />
        ))}
      </div>

      <div
        className="mobile-stage-layout flex h-full w-full flex-col gap-2 p-3"
        data-mobile-stage-layout={layoutMode}
      >
        <div className="mobile-stage-main min-h-0 flex-1">
          {renderTile(primaryTile, railTiles.length === 0 ? "solo" : "primary")}
        </div>
        {railTiles.length > 0 ? (
          <div
            className="mobile-stage-rail grid h-32 shrink-0 grid-flow-col auto-cols-[minmax(112px,34vw)] gap-2 overflow-x-auto pb-1"
            aria-label="Other participants"
          >
            {railTiles.map((tile) => renderTile(tile, "rail"))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LocalTile({
  variant,
  videoRef,
  stream,
  displayName,
  userEmail,
  isCameraOff,
  isMuted,
  isHandRaised,
  isGhost,
  isMirrorCamera,
  isActiveSpeaker,
}: {
  variant: TileVariant;
  videoRef: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  displayName: string;
  userEmail: string;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isGhost: boolean;
  isMirrorCamera: boolean;
  isActiveSpeaker: boolean;
}) {
  const showPlaceholder = isCameraOff || !stream;
  const avatarSize = getAvatarSize(variant);
  const label = truncateDisplayName(displayName, variant === "rail" ? 14 : 20);

  return (
    <div
      className={getTileClassName({
        variant,
        isActiveSpeaker,
        isHandRaised,
      })}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className={`h-full w-full object-cover ${showPlaceholder ? "hidden" : ""} ${
          isMirrorCamera ? "scale-x-[-1]" : ""
        }`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0b]">
          <div
            className={`relative flex items-center justify-center rounded-full mobile-avatar font-bold text-[#fafafa] ${avatarSize}`}
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {(displayName || userEmail)[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {isGhost && <GhostOverlay variant={variant} />}
      {isHandRaised && <HandRaisedBadge variant={variant} />}
      <TileLabel
        displayName={label}
        isMuted={isMuted}
        suffix="You"
        title={displayName}
        variant={variant}
      />
    </div>
  );
}

const ParticipantTile = memo(function ParticipantTile({
  variant,
  participant,
  displayName,
  isActiveSpeaker,
}: {
  variant: TileVariant;
  participant: Participant;
  displayName: string;
  isActiveSpeaker: boolean;
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

    const videoStream = participant.videoStream;
    const videoTrack = videoStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener("unmute", playVideo);
    }

    return () => {
      if (videoTrack) {
        videoTrack.removeEventListener("unmute", playVideo);
      }
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [
    participant.videoStream,
    participant.videoProducerId,
    participant.isCameraOff,
  ]);

  const showPlaceholder = !participant.videoStream || participant.isCameraOff;
  const label = truncateDisplayName(displayName, variant === "rail" ? 14 : 20);

  return (
    <div
      className={getTileClassName({
        variant,
        isActiveSpeaker,
        isHandRaised: participant.isHandRaised,
      })}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`h-full w-full object-cover ${
          showPlaceholder ? "hidden" : ""
        }`}
      />
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0b]">
          <div
            className={`relative flex items-center justify-center rounded-full mobile-avatar font-bold text-[#fafafa] ${getAvatarSize(
              variant,
            )}`}
            style={{ fontFamily: "'PolySans Bulky Wide', sans-serif" }}
          >
            {displayName[0]?.toUpperCase() || "?"}
          </div>
        </div>
      )}
      {participant.isGhost && <GhostOverlay variant={variant} />}
      {participant.isHandRaised && <HandRaisedBadge variant={variant} />}
      <TileLabel
        displayName={label}
        isMuted={participant.isMuted}
        title={displayName}
        variant={variant}
      />
    </div>
  );
});

function TileLabel({
  displayName,
  title,
  suffix,
  isMuted,
  variant,
}: {
  displayName: string;
  title: string;
  suffix?: string;
  isMuted: boolean;
  variant: TileVariant;
}) {
  const iconSize = variant === "rail" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center">
      <div
        className="mobile-name-pill flex max-w-full items-center gap-1.5 px-2.5 py-1"
        style={{ fontFamily: "'PolySans Trial', sans-serif" }}
      >
        <span
          className="truncate text-[12px] font-medium text-[#fafafa]"
          title={title}
        >
          {displayName}
        </span>
        {suffix ? (
          <span className="shrink-0 text-[11px] font-medium text-[#F95F4A]">
            {suffix}
          </span>
        ) : null}
        {isMuted ? <MicOff className={`${iconSize} shrink-0 text-[#F95F4A]`} /> : null}
      </div>
    </div>
  );
}

function GhostOverlay({ variant }: { variant: TileVariant }) {
  const iconSize = variant === "rail" ? "h-7 w-7" : "h-10 w-10";

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center mobile-ghost-overlay">
      <div className="flex flex-col items-center gap-2">
        <VenetianMask className={`${iconSize} text-[#FF007A]`} />
        <span
          className="mobile-ghost-badge rounded-full px-3 py-1 text-[11px] font-medium text-[#FF007A]"
          style={{ fontFamily: "'PolySans Trial', sans-serif" }}
        >
          Ghost
        </span>
      </div>
    </div>
  );
}

function HandRaisedBadge({ variant }: { variant: TileVariant }) {
  return (
    <div
      className={`absolute left-2 top-2 rounded-full mobile-hand-badge text-amber-200 ${
        variant === "rail" ? "p-1.5" : "p-2"
      }`}
    >
      <Hand className={variant === "rail" ? "h-3 w-3" : "h-3.5 w-3.5"} />
    </div>
  );
}

function getTileClassName({
  variant,
  isActiveSpeaker,
  isHandRaised,
}: {
  variant: TileVariant;
  isActiveSpeaker: boolean;
  isHandRaised: boolean;
}) {
  return [
    "mobile-tile h-full min-h-0",
    variant === "rail" ? "min-h-[112px]" : "",
    isActiveSpeaker ? "mobile-tile-active" : "",
    isHandRaised ? "mobile-tile-hand-raised" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function getAvatarSize(variant: TileVariant) {
  if (variant === "rail") return "h-12 w-12 text-lg";
  return "h-20 w-20 text-3xl";
}

function hasLiveVideo(participant: Participant) {
  if (!participant.videoStream || participant.isCameraOff) return false;
  return participant.videoStream
    .getVideoTracks()
    .some((track) => track.readyState === "live");
}

function hasLiveAudio(participant: Participant) {
  if (!participant.audioStream || participant.isMuted) return false;
  return participant.audioStream
    .getAudioTracks()
    .some((track) => track.readyState === "live");
}

export default memo(MobileGridLayout);
