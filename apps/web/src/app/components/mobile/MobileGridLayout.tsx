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
const MOBILE_WARM_BUFFER_TILES = 3;
const MOBILE_ROOM_TILING_METADATA_INTERVAL_MS = 200;
const MOBILE_ROOM_TILING_PROMOTE_DELAY_MS = 220;
const MOBILE_ROOM_TILING_MIN_SWITCH_INTERVAL_MS = 2200;

type MobileRoomTilingWarmReason =
  | "boundary"
  | "active-speaker"
  | "hand-raised";

type MobileRoomTilingScore = {
  id: string;
  rank: number;
  score: number;
  active: boolean;
  featured: boolean;
  raised: boolean;
  video: boolean;
  audio: boolean;
  visible: boolean;
  hidden: boolean;
  warm: boolean;
  warmReasons: MobileRoomTilingWarmReason[];
};

type MobileRoomTilingMetadata = {
  source: "client";
  intervalMs: number;
  promoteDelayMs: number;
  minSwitchIntervalMs: number;
  activeSpeakerId: string | null;
  featuredSpeakerId: string | null;
  requestedMode: "auto";
  renderedMode: "solo" | "stageRail";
  effectiveMode: "solo" | "stageRail";
  autoStageMode: "mobile-solo" | "mobile-stage-rail";
  dynamicCrop: false;
  presenting: false;
  pinnedId: null;
  primaryIds: string[];
  visibleRemoteIds: string[];
  hiddenIds: string[];
  warmIds: string[];
  warmReasons: Record<string, MobileRoomTilingWarmReason[]>;
  orderedRemoteIds: string[];
  scores: MobileRoomTilingScore[];
  counts: {
    orderedRemote: number;
    visible: number;
    hidden: number;
    warm: number;
    totalGrid: number;
    stageRail: number;
    maxTiles: number;
    requestedMaxTiles: number;
    autoTileLimit: number;
    recentlyVisibleWarm: number;
    priorityWarm: number;
    handRaisedWarm: number;
    featuredSpeakerWarm: number;
  };
  stage: {
    mainKind: "local" | "remote" | "none";
    candidateMainKind: "local" | "remote" | "none";
    mainParticipantId: string | null;
    sideCompanionKind: "local" | "remote" | "none";
    sideCompanionId: string | null;
    sideBySide: false;
    spotlight: boolean;
  };
  selfView: {
    requested: "auto";
    effective: "tile";
    placement: "stage" | "tile";
    corner: "bottom-right";
  };
  layout: {
    width: number;
    height: number;
    cols: number;
    rows: number;
    tileWidth: number;
    tileHeight: number;
    contentWidth: number;
    contentHeight: number;
    offsetX: number;
    offsetY: number;
    positions: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    gridVideoFit: "cover";
    fullVideoTileIds: string[];
  };
  sequence: number;
  timestamp: number;
  performanceTime: number;
  signature: string;
};

type MobileRoomTilingDebugSnapshot = {
  current: MobileRoomTilingMetadata | null;
  history: MobileRoomTilingMetadata[];
  sequence: number;
  intervalMs: number;
};

type MobileRoomTilingDebugWindow = {
  __conclaveGetMeetRoomTilingDebug?: () => MobileRoomTilingDebugSnapshot;
  __conclaveMeetRoomTilingDebug?: MobileRoomTilingDebugSnapshot;
};

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
  const rootRef = useRef<HTMLDivElement>(null);
  const stageMainRef = useRef<HTMLDivElement>(null);
  const stageRailRef = useRef<HTMLDivElement>(null);
  const localTileRef = useRef<HTMLDivElement>(null);
  const roomTilingSequenceRef = useRef(0);
  const roomTilingMetadataRef = useRef<MobileRoomTilingMetadata | null>(null);
  const roomTilingHistoryRef = useRef<MobileRoomTilingMetadata[]>([]);
  const lastRoomTilingSignatureRef = useRef<string | null>(null);

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
  const renderedRoomMode: MobileRoomTilingMetadata["renderedMode"] =
    layoutMode === "solo" ? "solo" : "stageRail";
  const primaryIds = useMemo(() => [primaryTile.key], [primaryTile.key]);
  const visibleRemoteIds = useMemo(() => {
    const ids = new Set<string>();
    if (primaryTile.kind === "remote") {
      ids.add(primaryTile.key);
    }
    railTiles.forEach((tile) => {
      if (tile.kind === "remote") {
        ids.add(tile.key);
      }
    });
    return Array.from(ids);
  }, [primaryTile, railTiles]);
  const hiddenRemoteIds = useMemo(() => {
    const visible = new Set(visibleRemoteIds);
    return remoteTiles
      .filter((tile) => tile.kind === "remote" && !visible.has(tile.key))
      .map((tile) => tile.key);
  }, [remoteTiles, visibleRemoteIds]);
  const warmRemoteIds = useMemo(
    () => hiddenRemoteIds.slice(0, MOBILE_WARM_BUFFER_TILES),
    [hiddenRemoteIds],
  );
  const warmRemoteTiles = useMemo(() => {
    const warm = new Set(warmRemoteIds);
    return remoteTiles.filter(
      (tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote" && warm.has(tile.key),
    );
  }, [remoteTiles, warmRemoteIds]);
  const warmRemoteVideoTiles = useMemo(
    () => warmRemoteTiles.filter((tile) => hasLiveVideo(tile.participant)),
    [warmRemoteTiles],
  );
  const roomTilingWarmReasons = useMemo(() => {
    const reasons: Record<string, MobileRoomTilingWarmReason[]> = {};
    warmRemoteTiles.forEach((tile) => {
      const nextReasons: MobileRoomTilingWarmReason[] = ["boundary"];
      if (tile.participant.userId === activeSpeakerId) {
        nextReasons.push("active-speaker");
      }
      if (tile.participant.isHandRaised) {
        nextReasons.push("hand-raised");
      }
      reasons[tile.participant.userId] = nextReasons;
    });
    return reasons;
  }, [activeSpeakerId, warmRemoteTiles]);
  const roomTilingScores = useMemo<MobileRoomTilingScore[]>(() => {
    const visible = new Set(visibleRemoteIds);
    const hidden = new Set(hiddenRemoteIds);
    const warm = new Set(warmRemoteIds);
    return remoteTiles
      .filter((tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote",
      )
      .map((tile, rank) => {
        const active = tile.participant.userId === activeSpeakerId;
        const video = hasLiveVideo(tile.participant);
        const audio = hasLiveAudio(tile.participant);
        const raised = tile.participant.isHandRaised;
        return {
          id: tile.participant.userId,
          rank,
          score:
            (active ? 1000 : 0) +
            (raised ? 80 : 0) +
            (video ? 40 : 0) +
            (audio ? 20 : 0) -
            rank,
          active,
          featured: false,
          raised,
          video,
          audio,
          visible: visible.has(tile.participant.userId),
          hidden: hidden.has(tile.participant.userId),
          warm: warm.has(tile.participant.userId),
          warmReasons: roomTilingWarmReasons[tile.participant.userId] ?? [],
        };
      });
  }, [
    activeSpeakerId,
    hiddenRemoteIds,
    remoteTiles,
    roomTilingWarmReasons,
    visibleRemoteIds,
    warmRemoteIds,
  ]);
  const mobileRoomTilingBase = useMemo(
    () => ({
      activeSpeakerId,
      renderedMode: renderedRoomMode,
      primaryIds,
      visibleRemoteIds,
      hiddenRemoteIds,
      warmRemoteIds,
      roomTilingWarmReasons,
      orderedRemoteIds: orderedRemoteParticipants.map(
        (participant) => participant.userId,
      ),
      roomTilingScores,
      primaryKind: (primaryTile.kind === "remote" ? "remote" : "local") as
        | "remote"
        | "local",
      primaryParticipantId:
        primaryTile.kind === "remote" ? primaryTile.participant.userId : null,
      localIsPrimary: primaryTile.kind === "local",
      localIsRail: railTiles.some((tile) => tile.kind === "local"),
      visibleTileCount:
        1 + railTiles.filter((tile) => tile.kind !== "overflow").length,
      railTileCount: railTiles.length,
      hiddenParticipantsCount,
      totalPeople,
    }),
    [
      activeSpeakerId,
      hiddenParticipantsCount,
      hiddenRemoteIds,
      orderedRemoteParticipants,
      primaryIds,
      primaryTile,
      railTiles,
      renderedRoomMode,
      roomTilingScores,
      roomTilingWarmReasons,
      totalPeople,
      visibleRemoteIds,
      warmRemoteIds,
    ],
  );

  useEffect(() => {
    const debugWindow = window as unknown as MobileRoomTilingDebugWindow;
    const readRect = (element: HTMLElement | null) => {
      const rect = element?.getBoundingClientRect();
      return {
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        width: Math.round(rect?.width ?? 0),
        height: Math.round(rect?.height ?? 0),
      };
    };
    const getSnapshot = (): MobileRoomTilingDebugSnapshot => ({
      current: roomTilingMetadataRef.current,
      history: roomTilingHistoryRef.current,
      sequence: roomTilingSequenceRef.current,
      intervalMs: MOBILE_ROOM_TILING_METADATA_INTERVAL_MS,
    });
    const publish = ({ heartbeat = false } = {}) => {
      const rootRect = readRect(rootRef.current);
      const mainRect = readRect(stageMainRef.current);
      const railRect = readRect(stageRailRef.current);
      const localRect = readRect(localTileRef.current);
      const fallbackTileRect = mobileRoomTilingBase.localIsPrimary
        ? mainRect
        : railRect;
      const tileWidth = localRect.width || fallbackTileRect.width;
      const tileHeight = localRect.height || fallbackTileRect.height;
      const localPosition =
        tileWidth > 0 && tileHeight > 0
          ? [
              {
                id: "local",
                x: Math.max(0, localRect.x - rootRect.x),
                y: Math.max(0, localRect.y - rootRect.y),
                width: tileWidth,
                height: tileHeight,
              },
            ]
          : [];
      const metadataWithoutSequence = {
        source: "client" as const,
        intervalMs: MOBILE_ROOM_TILING_METADATA_INTERVAL_MS,
        promoteDelayMs: MOBILE_ROOM_TILING_PROMOTE_DELAY_MS,
        minSwitchIntervalMs: MOBILE_ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
        activeSpeakerId: mobileRoomTilingBase.activeSpeakerId,
        featuredSpeakerId: null,
        requestedMode: "auto" as const,
        renderedMode: mobileRoomTilingBase.renderedMode,
        effectiveMode: mobileRoomTilingBase.renderedMode,
        autoStageMode:
          mobileRoomTilingBase.renderedMode === "solo"
            ? ("mobile-solo" as const)
            : ("mobile-stage-rail" as const),
        dynamicCrop: false as const,
        presenting: false as const,
        pinnedId: null,
        primaryIds: mobileRoomTilingBase.primaryIds,
        visibleRemoteIds: mobileRoomTilingBase.visibleRemoteIds,
        hiddenIds: mobileRoomTilingBase.hiddenRemoteIds,
        warmIds: mobileRoomTilingBase.warmRemoteIds,
        warmReasons: mobileRoomTilingBase.roomTilingWarmReasons,
        orderedRemoteIds: mobileRoomTilingBase.orderedRemoteIds,
        scores: mobileRoomTilingBase.roomTilingScores,
        counts: {
          orderedRemote: mobileRoomTilingBase.orderedRemoteIds.length,
          visible: mobileRoomTilingBase.visibleTileCount,
          hidden: mobileRoomTilingBase.hiddenParticipantsCount,
          warm: mobileRoomTilingBase.warmRemoteIds.length,
          totalGrid: mobileRoomTilingBase.totalPeople,
          stageRail: mobileRoomTilingBase.railTileCount,
          maxTiles: MAX_MOBILE_RAIL_TILES + 1,
          requestedMaxTiles: MAX_MOBILE_RAIL_TILES + 1,
          autoTileLimit: MAX_MOBILE_RAIL_TILES + 1,
          recentlyVisibleWarm: 0,
          priorityWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) =>
            reasons.some(
              (reason) =>
                reason === "active-speaker" || reason === "hand-raised",
            ),
          ).length,
          handRaisedWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) => reasons.includes("hand-raised")).length,
          featuredSpeakerWarm: 0,
        },
        stage: {
          mainKind: mobileRoomTilingBase.primaryKind,
          candidateMainKind: mobileRoomTilingBase.primaryKind,
          mainParticipantId: mobileRoomTilingBase.localIsPrimary
            ? currentUserId
            : mobileRoomTilingBase.primaryParticipantId,
          sideCompanionKind: mobileRoomTilingBase.localIsRail
            ? ("local" as const)
            : mobileRoomTilingBase.railTileCount > 0
              ? ("remote" as const)
              : ("none" as const),
          sideCompanionId: mobileRoomTilingBase.localIsRail
            ? currentUserId
            : null,
          sideBySide: false as const,
          spotlight: mobileRoomTilingBase.renderedMode === "stageRail",
        },
        selfView: {
          requested: "auto" as const,
          effective: "tile" as const,
          placement: mobileRoomTilingBase.localIsPrimary
            ? ("stage" as const)
            : ("tile" as const),
          corner: "bottom-right" as const,
        },
        layout: {
          width: rootRect.width,
          height: rootRect.height,
          cols: mobileRoomTilingBase.renderedMode === "solo" ? 1 : 2,
          rows: mobileRoomTilingBase.renderedMode === "solo" ? 1 : 2,
          tileWidth,
          tileHeight,
          contentWidth: rootRect.width,
          contentHeight: rootRect.height,
          offsetX: 0,
          offsetY: 0,
          positions: localPosition,
          gridVideoFit: "cover" as const,
          fullVideoTileIds: [],
        },
      };
      const signature = JSON.stringify(metadataWithoutSequence);
      if (lastRoomTilingSignatureRef.current === signature && !heartbeat) {
        return;
      }
      const metadata: MobileRoomTilingMetadata = {
        ...metadataWithoutSequence,
        sequence: roomTilingSequenceRef.current + 1,
        timestamp: Date.now(),
        performanceTime: Math.round(performance.now()),
        signature,
      };
      roomTilingSequenceRef.current = metadata.sequence;
      roomTilingMetadataRef.current = metadata;
      roomTilingHistoryRef.current = [
        ...roomTilingHistoryRef.current,
        metadata,
      ].slice(-24);
      lastRoomTilingSignatureRef.current = signature;
      debugWindow.__conclaveMeetRoomTilingDebug = getSnapshot();
      window.dispatchEvent(
        new CustomEvent("conclave:meet-room-tiling", { detail: metadata }),
      );
    };

    debugWindow.__conclaveGetMeetRoomTilingDebug = getSnapshot;
    publish();
    const interval = window.setInterval(
      () => publish({ heartbeat: true }),
      MOBILE_ROOM_TILING_METADATA_INTERVAL_MS,
    );
    const forcePublish = () => {
      lastRoomTilingSignatureRef.current = null;
      publish();
    };
    window.addEventListener("resize", forcePublish);
    window.addEventListener("orientationchange", forcePublish);
    window.visualViewport?.addEventListener("resize", forcePublish);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("resize", forcePublish);
      window.removeEventListener("orientationchange", forcePublish);
      window.visualViewport?.removeEventListener("resize", forcePublish);
      if (debugWindow.__conclaveGetMeetRoomTilingDebug === getSnapshot) {
        delete debugWindow.__conclaveGetMeetRoomTilingDebug;
      }
      if (
        debugWindow.__conclaveMeetRoomTilingDebug?.current ===
        roomTilingMetadataRef.current
      ) {
        delete debugWindow.__conclaveMeetRoomTilingDebug;
      }
    };
  }, [currentUserId, mobileRoomTilingBase]);

  const renderTile = (tile: MobileTileDescriptor, variant: TileVariant) => {
    if (tile.kind === "local") {
      return (
        <LocalTile
          key={tile.key}
          variant={variant}
          tileRef={localTileRef}
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
      ref={rootRef}
      className="relative h-full w-full"
      data-mobile-meet-layout={layoutMode}
      data-mobile-room-tiling-source="client"
      data-mobile-room-tiling-interval={MOBILE_ROOM_TILING_METADATA_INTERVAL_MS}
      data-mobile-primary={primaryTile.key}
      data-mobile-primary-kind={primaryTile.kind}
      data-mobile-rail-count={railTiles.length}
      data-mobile-visible-count={mobileRoomTilingBase.visibleTileCount}
      data-mobile-hidden-count={hiddenParticipantsCount}
      data-mobile-max-tiles={MAX_MOBILE_RAIL_TILES + 1}
      data-mobile-visible-ids={visibleRemoteIds.join(",")}
      data-mobile-hidden-ids={hiddenRemoteIds.join(",")}
      data-mobile-warm-ids={warmRemoteIds.join(",")}
      data-mobile-warm-count={warmRemoteIds.length}
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
      {warmRemoteVideoTiles.length > 0 ? (
        <div
          className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-hidden opacity-0"
          aria-hidden={true}
          data-mobile-warm-video-decoders={warmRemoteVideoTiles.length}
        >
          {warmRemoteVideoTiles.map((tile) => (
            <WarmRemoteVideo
              key={`warm-video-${tile.participant.userId}`}
              participant={tile.participant}
            />
          ))}
        </div>
      ) : null}

      <div
        className="mobile-stage-layout flex h-full w-full flex-col gap-2 p-3"
        data-mobile-stage-layout={layoutMode}
      >
        <div ref={stageMainRef} className="mobile-stage-main min-h-0 flex-1">
          {renderTile(primaryTile, railTiles.length === 0 ? "solo" : "primary")}
        </div>
        {railTiles.length > 0 ? (
          <div
            ref={stageRailRef}
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
  tileRef,
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
  tileRef: RefObject<HTMLDivElement | null>;
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
      ref={tileRef}
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

function WarmRemoteVideo({ participant }: { participant: Participant }) {
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

  if (!participant.videoStream || participant.isCameraOff) {
    return null;
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      className="h-px w-px"
      aria-hidden={true}
    />
  );
}

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
