"use client";

import { Hand, MicOff, VenetianMask } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  computeGridLayout,
  type GridTilePosition,
} from "@conclave/meeting-core";
import { Avatar } from "@conclave/ui-tokens/web";
import { useSmartParticipantOrderWithMetadata } from "../../hooks/useSmartParticipantOrder";
import { createPlaybackRecoveryScheduler } from "../../lib/playback-recovery";
import { getRenderableParticipantVideoStream } from "../../lib/participant-media";
import type { Participant } from "../../lib/types";
import { isSystemUserId, truncateDisplayName } from "../../lib/utils";
import ParticipantAudio from "../ParticipantAudio";
import ParticipantConnectionOverlay from "../ParticipantConnectionOverlay";

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

type TileVariant = "solo" | "primary" | "rail" | "grid";

type MobileTileDescriptor =
  | { kind: "local"; key: "local" }
  | {
      kind: "remote";
      key: string;
      participant: Participant;
      displayName: string;
    }
  | { kind: "overflow"; key: "overflow"; count: number };

const MAX_MOBILE_VISIBLE_TILES = 9;
const MOBILE_WARM_BUFFER_TILES = 4;
const MOBILE_RECENTLY_VISIBLE_WARM_BUFFER_TILES = 3;
const MOBILE_RECENTLY_VISIBLE_WARM_HOLD_MS = 3500;
const MOBILE_PRIORITY_WARM_BUFFER_TILES = 3;
const MOBILE_GRID_PADDING = 12;
const MOBILE_GRID_GAP = 8;
const MOBILE_GRID_PORTRAIT_MAX_COLS = 2;
const MOBILE_GRID_LANDSCAPE_MAX_COLS = 4;
const MOBILE_ROOM_TILING_METADATA_INTERVAL_MS = 200;
const MOBILE_ROOM_TILING_PROMOTE_DELAY_MS = 220;
const MOBILE_ROOM_TILING_MIN_SWITCH_INTERVAL_MS = 2200;

type MobileRoomTilingWarmReason =
  | "boundary"
  | "recently-visible"
  | "active-speaker"
  | "featured-speaker"
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
  renderedMode: "solo" | "tiled";
  effectiveMode: "solo" | "tiled";
  autoStageMode: "mobile-solo" | "mobile-tiled";
  dynamicCrop: false;
  presenting: false;
  pinnedId: null;
  primaryIds: string[];
  focusIds: string[];
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
  const gridRef = useRef<HTMLDivElement>(null);
  const localTileRef = useRef<HTMLDivElement>(null);
  const roomTilingSequenceRef = useRef(0);
  const roomTilingMetadataRef = useRef<MobileRoomTilingMetadata | null>(null);
  const roomTilingHistoryRef = useRef<MobileRoomTilingMetadata[]>([]);
  const lastRoomTilingSignatureRef = useRef<string | null>(null);
  const recentlyVisibleWarmIdsRef = useRef<Map<string, number>>(new Map());
  const previousVisibleWarmIdsRef = useRef<Set<string>>(new Set());
  const [recentlyVisibleWarmRevision, setRecentlyVisibleWarmRevision] =
    useState(0);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setGridSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    const scheduleMeasure = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    window.addEventListener("orientationchange", scheduleMeasure);

    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("orientationchange", scheduleMeasure);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

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

  const {
    orderedParticipants: orderedRemoteParticipants,
    featuredSpeakerId,
  } = useSmartParticipantOrderWithMetadata(
    Array.from(participants.values()).filter(
      (participant) =>
        !isSystemUserId(participant.userId) &&
        participant.userId !== currentUserId,
    ),
    activeSpeakerId,
    {
      promoteDelayMs: MOBILE_ROOM_TILING_PROMOTE_DELAY_MS,
      minSwitchIntervalMs: MOBILE_ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
      minParticipantsForReorder: MAX_MOBILE_VISIBLE_TILES,
    },
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

  const {
    visibleTiles,
    hiddenTiles,
    hiddenParticipantsCount,
    showOverflowTile,
  } = useMemo(() => {
    const localTile: MobileTileDescriptor = { kind: "local", key: "local" };
    const remoteTileList = remoteTiles.filter(
      (tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote",
    );
    const stableSpeakerId = featuredSpeakerId ?? activeSpeakerId;
    const primaryRemote =
      remoteTileList.find(
        (tile) => tile.participant.userId === stableSpeakerId,
      ) ??
      remoteTileList.find((tile) => hasLiveVideo(tile.participant)) ??
      remoteTileList.find((tile) => hasLiveAudio(tile.participant)) ??
      (remoteTileList.length > 0 ? remoteTileList[0] : null);
    const primary = primaryRemote ?? localTile;
    const ordered: MobileTileDescriptor[] = [
      primary,
      ...(primary.kind === "local" ? [] : [localTile]),
      ...remoteTileList.filter((tile) => tile.key !== primary.key),
    ];

    if (ordered.length <= MAX_MOBILE_VISIBLE_TILES) {
      return {
        visibleTiles: ordered,
        hiddenTiles: [] as MobileTileDescriptor[],
        hiddenParticipantsCount: 0,
        showOverflowTile: false,
      };
    }

    const visibleWithoutOverflow = ordered.slice(0, MAX_MOBILE_VISIBLE_TILES - 1);
    const hidden = ordered.slice(visibleWithoutOverflow.length);
    const hiddenCount = hidden.length;
    const overflowTile: MobileTileDescriptor = {
      kind: "overflow",
      key: "overflow",
      count: hiddenCount,
    };
    return {
      visibleTiles: [...visibleWithoutOverflow, overflowTile],
      hiddenTiles: hidden,
      hiddenParticipantsCount: hiddenCount,
      showOverflowTile: true,
    };
  }, [activeSpeakerId, featuredSpeakerId, remoteTiles]);

  const totalPeople = orderedRemoteParticipants.length + 1;
  const layoutMode = visibleTiles.length <= 1 ? "solo" : "tiled";
  const renderedRoomMode: MobileRoomTilingMetadata["renderedMode"] =
    layoutMode === "solo" ? "solo" : "tiled";
  const primaryTile = visibleTiles[0] ?? { kind: "local", key: "local" };
  const primaryIds = useMemo(() => {
    const ids = visibleTiles.map((tile) => tile.key);
    return ids.length > 0 ? ids : ["local"];
  }, [visibleTiles]);
  const focusIds = useMemo(() => {
    const ids: string[] = [];
    if (primaryTile.kind === "remote") {
      ids.push(primaryTile.participant.userId);
    }
    if (activeSpeakerId) {
      ids.push(activeSpeakerId);
    }
    if (featuredSpeakerId) {
      ids.push(featuredSpeakerId);
    }
    return Array.from(new Set(ids.filter(Boolean)));
  }, [activeSpeakerId, featuredSpeakerId, primaryTile]);
  const visibleRemoteIds = useMemo(() => {
    const ids = new Set<string>();
    visibleTiles.forEach((tile) => {
      if (tile.kind === "remote") {
        ids.add(tile.key);
      }
    });
    return Array.from(ids);
  }, [visibleTiles]);
  const hiddenRemoteIds = useMemo(() => {
    return hiddenTiles
      .filter((tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote",
      )
      .map((tile) => tile.key);
  }, [hiddenTiles]);

  const visibleRemoteIdSignature = useMemo(
    () => visibleRemoteIds.join(","),
    [visibleRemoteIds],
  );
  const orderedRemoteIdSignature = useMemo(
    () =>
      orderedRemoteParticipants
        .map((participant) => participant.userId)
        .join(","),
    [orderedRemoteParticipants],
  );
  const hiddenRemoteIdSignature = useMemo(
    () => hiddenRemoteIds.join(","),
    [hiddenRemoteIds],
  );

  useEffect(() => {
    const now = performance.now();
    const visibleIds = new Set(visibleRemoteIdSignature.split(",").filter(Boolean));
    const previousVisibleIds = previousVisibleWarmIdsRef.current;
    const orderedIds = new Set(orderedRemoteIdSignature.split(",").filter(Boolean));
    const map = recentlyVisibleWarmIdsRef.current;
    let changed = false;

    for (const id of visibleIds) {
      if (map.get(id) !== Number.POSITIVE_INFINITY) {
        map.set(id, Number.POSITIVE_INFINITY);
        changed = true;
      }
    }

    for (const id of previousVisibleIds) {
      if (!visibleIds.has(id) && orderedIds.has(id)) {
        const expiresAt = now + MOBILE_RECENTLY_VISIBLE_WARM_HOLD_MS;
        if (map.get(id) !== expiresAt) {
          map.set(id, expiresAt);
          changed = true;
        }
      }
    }

    for (const [id, expiresAt] of map) {
      if (visibleIds.has(id)) continue;
      if (!orderedIds.has(id) || expiresAt <= now) {
        map.delete(id);
        changed = true;
      }
    }

    previousVisibleWarmIdsRef.current = visibleIds;

    if (changed) {
      setRecentlyVisibleWarmRevision((revision) => revision + 1);
    }

    const nextExpiry = Array.from(map.values())
      .filter(Number.isFinite)
      .reduce((min, expiresAt) => Math.min(min, expiresAt), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpiry)) return;

    const timeout = window.setTimeout(() => {
      const pruneAt = performance.now();
      let pruned = false;
      for (const [id, expiresAt] of recentlyVisibleWarmIdsRef.current) {
        if (
          !orderedIds.has(id) ||
          (Number.isFinite(expiresAt) && expiresAt <= pruneAt)
        ) {
          recentlyVisibleWarmIdsRef.current.delete(id);
          pruned = true;
        }
      }
      if (pruned) {
        setRecentlyVisibleWarmRevision((revision) => revision + 1);
      }
    }, Math.max(16, nextExpiry - now + 16));

    return () => window.clearTimeout(timeout);
  }, [
    hiddenRemoteIdSignature,
    orderedRemoteIdSignature,
    visibleRemoteIdSignature,
  ]);

  const { warmRemoteTiles, warmReasonById } = useMemo(() => {
    const visibleSet = new Set(visibleRemoteIds);
    const hiddenRemoteTiles = hiddenTiles.filter(
      (tile): tile is Extract<MobileTileDescriptor, { kind: "remote" }> =>
        tile.kind === "remote",
    );
    const warmById = new Map<
      string,
      Extract<MobileTileDescriptor, { kind: "remote" }>
    >();
    const reasonSets = new Map<string, Set<MobileRoomTilingWarmReason>>();
    const addWarm = (
      tile:
        | Extract<MobileTileDescriptor, { kind: "remote" }>
        | undefined,
      reason: MobileRoomTilingWarmReason,
    ) => {
      if (!tile || visibleSet.has(tile.key)) return;
      warmById.set(tile.key, tile);
      const reasons = reasonSets.get(tile.key) ?? new Set();
      reasons.add(reason);
      reasonSets.set(tile.key, reasons);
    };

    hiddenRemoteTiles
      .slice(0, MOBILE_WARM_BUFFER_TILES)
      .forEach((tile) => addWarm(tile, "boundary"));

    const now = performance.now();
    const recentlyVisibleWarmIds = new Set(
      Array.from(recentlyVisibleWarmIdsRef.current.entries())
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([id]) => id),
    );
    hiddenRemoteTiles
      .filter((tile) => recentlyVisibleWarmIds.has(tile.key))
      .slice(0, MOBILE_RECENTLY_VISIBLE_WARM_BUFFER_TILES)
      .forEach((tile) => addWarm(tile, "recently-visible"));

    if (activeSpeakerId) {
      addWarm(
        hiddenRemoteTiles.find((tile) => tile.key === activeSpeakerId),
        "active-speaker",
      );
    }

    if (featuredSpeakerId) {
      addWarm(
        hiddenRemoteTiles.find((tile) => tile.key === featuredSpeakerId),
        "featured-speaker",
      );
    }

    hiddenRemoteTiles
      .filter((tile) => tile.participant.isHandRaised)
      .slice(0, MOBILE_PRIORITY_WARM_BUFFER_TILES)
      .forEach((tile) => addWarm(tile, "hand-raised"));

    return {
      warmRemoteTiles: Array.from(warmById.values()),
      warmReasonById: new Map(
        Array.from(reasonSets.entries()).map(([id, reasons]) => [
          id,
          Array.from(reasons),
        ]),
      ),
    };
  }, [
    activeSpeakerId,
    featuredSpeakerId,
    hiddenTiles,
    recentlyVisibleWarmRevision,
    visibleRemoteIds,
  ]);
  const warmRemoteIds = useMemo(
    () => warmRemoteTiles.map((tile) => tile.key),
    [warmRemoteTiles],
  );
  const warmRemoteVideoTiles = useMemo(
    () => warmRemoteTiles.filter((tile) => hasLiveVideo(tile.participant)),
    [warmRemoteTiles],
  );
  const roomTilingWarmReasons = useMemo(() => {
    return Object.fromEntries(
      warmReasonById.entries(),
    ) as Record<string, MobileRoomTilingWarmReason[]>;
  }, [warmReasonById]);
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
        const featured = tile.participant.userId === featuredSpeakerId;
        const video = hasLiveVideo(tile.participant);
        const audio = hasLiveAudio(tile.participant);
        const raised = tile.participant.isHandRaised;
        return {
          id: tile.participant.userId,
          rank,
          score:
            (active ? 1000 : 0) +
            (featured ? 500 : 0) +
            (raised ? 80 : 0) +
            (video ? 40 : 0) +
            (audio ? 20 : 0) -
            rank,
          active,
          featured,
          raised,
          video,
          audio,
          visible: visible.has(tile.participant.userId),
          hidden: hidden.has(tile.participant.userId),
          warm: warm.has(tile.participant.userId),
          warmReasons: warmReasonById.get(tile.participant.userId) ?? [],
        };
      });
  }, [
    activeSpeakerId,
    featuredSpeakerId,
    hiddenRemoteIds,
    remoteTiles,
    visibleRemoteIds,
    warmReasonById,
    warmRemoteIds,
  ]);
  const roomTilingWarmReasonsJson = useMemo(() => {
    try {
      return JSON.stringify(roomTilingWarmReasons);
    } catch {
      return "{}";
    }
  }, [roomTilingWarmReasons]);
  const roomTilingScoresJson = useMemo(() => {
    try {
      return JSON.stringify(roomTilingScores);
    } catch {
      return "[]";
    }
  }, [roomTilingScores]);

  const mobileMaxCols =
    gridSize.width > gridSize.height
      ? MOBILE_GRID_LANDSCAPE_MAX_COLS
      : MOBILE_GRID_PORTRAIT_MAX_COLS;
  const mobileGridLayout = useMemo(
    () =>
      computeGridLayout(
        Math.max(1, visibleTiles.length),
        Math.max(0, gridSize.width - MOBILE_GRID_PADDING * 2),
        Math.max(0, gridSize.height - MOBILE_GRID_PADDING * 2),
        {
          gap: MOBILE_GRID_GAP,
          maxCols: mobileMaxCols,
          maxTilesPerPage: MAX_MOBILE_VISIBLE_TILES,
          targetAspect: 16 / 9,
        },
      ),
    [gridSize.height, gridSize.width, mobileMaxCols, visibleTiles.length],
  );
  const mobileGridTileIds = useMemo(
    () => visibleTiles.map((tile) => tile.key),
    [visibleTiles],
  );
  const gridTilePlacements = useMemo(
    () =>
      mobileGridTileIds
        .map((id, index) => {
          const position = mobileGridLayout.positions[index];
          return position ? { ...position, id } : null;
        })
        .filter(
          (position): position is GridTilePosition & { id: string } =>
            position !== null,
        ),
    [mobileGridLayout.positions, mobileGridTileIds],
  );
  const gridTileStyleById = useMemo(() => {
    const styles = new Map<string, CSSProperties>();
    gridTilePlacements.forEach((position) => {
      styles.set(position.id, {
        left: MOBILE_GRID_PADDING + position.x,
        top: MOBILE_GRID_PADDING + position.y,
        width: position.width,
        height: position.height,
      });
    });
    return styles;
  }, [gridTilePlacements]);
  const fallbackTileStyle: CSSProperties | undefined =
    mobileGridLayout.tileWidth > 0
      ? {
          width: mobileGridLayout.tileWidth,
          height: mobileGridLayout.tileHeight,
        }
      : undefined;
  const getGridTileStyle = useCallback(
    (id: string) => gridTileStyleById.get(id) ?? fallbackTileStyle,
    [fallbackTileStyle, gridTileStyleById],
  );
  const mobileRoomTilingBase = useMemo(
    () => ({
      activeSpeakerId,
      featuredSpeakerId,
      renderedMode: renderedRoomMode,
      primaryIds,
      focusIds,
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
      localIsVisibleTile: visibleTiles.some((tile) => tile.kind === "local"),
      visibleTileCount:
        visibleTiles.filter((tile) => tile.kind !== "overflow").length,
      overflowTileVisible: showOverflowTile,
      hiddenParticipantsCount,
      totalPeople,
    }),
    [
      activeSpeakerId,
      featuredSpeakerId,
      hiddenParticipantsCount,
      hiddenRemoteIds,
      orderedRemoteParticipants,
      primaryIds,
      focusIds,
      primaryTile,
      showOverflowTile,
      renderedRoomMode,
      roomTilingScores,
      roomTilingWarmReasons,
      totalPeople,
      visibleRemoteIds,
      visibleTiles,
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
      const localRect = readRect(localTileRef.current);
      const tileWidth = localRect.width || mobileGridLayout.tileWidth;
      const tileHeight = localRect.height || mobileGridLayout.tileHeight;
      const positions =
        gridTilePlacements.length > 0
          ? gridTilePlacements
          : tileWidth > 0 && tileHeight > 0
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
        featuredSpeakerId: mobileRoomTilingBase.featuredSpeakerId,
        requestedMode: "auto" as const,
        renderedMode: mobileRoomTilingBase.renderedMode,
        effectiveMode: mobileRoomTilingBase.renderedMode,
        autoStageMode:
          mobileRoomTilingBase.renderedMode === "solo"
            ? ("mobile-solo" as const)
            : ("mobile-tiled" as const),
        dynamicCrop: false as const,
        presenting: false as const,
        pinnedId: null,
        primaryIds: mobileRoomTilingBase.primaryIds,
        focusIds: mobileRoomTilingBase.focusIds,
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
          stageRail: 0,
          maxTiles: MAX_MOBILE_VISIBLE_TILES,
          requestedMaxTiles: MAX_MOBILE_VISIBLE_TILES,
          autoTileLimit: MAX_MOBILE_VISIBLE_TILES,
          recentlyVisibleWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) => reasons.includes("recently-visible")).length,
          priorityWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) =>
            reasons.some(
              (reason) =>
                reason === "active-speaker" ||
                reason === "featured-speaker" ||
                reason === "hand-raised",
            ),
          ).length,
          handRaisedWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) => reasons.includes("hand-raised")).length,
          featuredSpeakerWarm: Object.values(
            mobileRoomTilingBase.roomTilingWarmReasons,
          ).filter((reasons) => reasons.includes("featured-speaker")).length,
        },
        stage: {
          mainKind: mobileRoomTilingBase.primaryKind,
          candidateMainKind: mobileRoomTilingBase.primaryKind,
          mainParticipantId: mobileRoomTilingBase.localIsPrimary
            ? currentUserId
            : mobileRoomTilingBase.primaryParticipantId,
          sideCompanionKind: "none" as const,
          sideCompanionId: null,
          sideBySide: false as const,
          spotlight: false,
        },
        selfView: {
          requested: "auto" as const,
          effective: "tile" as const,
          placement: "tile" as const,
          corner: "bottom-right" as const,
        },
        layout: {
          width: rootRect.width,
          height: rootRect.height,
          cols: mobileGridLayout.cols,
          rows: mobileGridLayout.rows,
          tileWidth,
          tileHeight,
          contentWidth: mobileGridLayout.contentWidth,
          contentHeight: mobileGridLayout.contentHeight,
          offsetX: mobileGridLayout.offsetX,
          offsetY: mobileGridLayout.offsetY,
          positions,
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
  }, [
    currentUserId,
    gridTilePlacements,
    mobileGridLayout.cols,
    mobileGridLayout.contentHeight,
    mobileGridLayout.contentWidth,
    mobileGridLayout.offsetX,
    mobileGridLayout.offsetY,
    mobileGridLayout.rows,
    mobileGridLayout.tileHeight,
    mobileGridLayout.tileWidth,
    mobileRoomTilingBase,
  ]);

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
      data-mobile-room-tiling-metadata-interval={
        MOBILE_ROOM_TILING_METADATA_INTERVAL_MS
      }
      data-mobile-room-tiling-promote-delay={MOBILE_ROOM_TILING_PROMOTE_DELAY_MS}
      data-mobile-room-tiling-min-switch-interval={
        MOBILE_ROOM_TILING_MIN_SWITCH_INTERVAL_MS
      }
      data-mobile-room-tiling-active-speaker={activeSpeakerId ?? ""}
      data-mobile-room-tiling-featured-speaker={featuredSpeakerId ?? ""}
      data-mobile-primary={primaryTile.key}
      data-mobile-primary-kind={primaryTile.kind}
      data-mobile-primary-ids={primaryIds.join(",")}
      data-mobile-room-tiling-primary-ids={primaryIds.join(",")}
      data-mobile-rail-count={0}
      data-mobile-visible-count={mobileRoomTilingBase.visibleTileCount}
      data-mobile-hidden-count={hiddenParticipantsCount}
      data-mobile-max-tiles={MAX_MOBILE_VISIBLE_TILES}
      data-mobile-visible-ids={visibleRemoteIds.join(",")}
      data-mobile-room-tiling-visible-ids={visibleRemoteIds.join(",")}
      data-mobile-hidden-ids={hiddenRemoteIds.join(",")}
      data-mobile-room-tiling-hidden-ids={hiddenRemoteIds.join(",")}
      data-mobile-warm-ids={warmRemoteIds.join(",")}
      data-mobile-room-tiling-warm-ids={warmRemoteIds.join(",")}
      data-mobile-warm-hold={MOBILE_RECENTLY_VISIBLE_WARM_HOLD_MS}
      data-mobile-room-tiling-warm-hold={MOBILE_RECENTLY_VISIBLE_WARM_HOLD_MS}
      data-mobile-warm-reasons={roomTilingWarmReasonsJson}
      data-mobile-room-tiling-warm-reasons={roomTilingWarmReasonsJson}
      data-mobile-room-tiling-scores={roomTilingScoresJson}
      data-mobile-warm-count={warmRemoteIds.length}
      data-mobile-total-people={totalPeople}
      data-mobile-grid-cols={mobileGridLayout.cols}
      data-mobile-grid-rows={mobileGridLayout.rows}
      data-mobile-grid-tile-size={`${mobileGridLayout.tileWidth}x${mobileGridLayout.tileHeight}`}
      data-mobile-grid-visible-tile-ids={mobileGridTileIds.join(",")}
      data-mobile-overflow-tile={showOverflowTile ? "true" : "false"}
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
        ref={gridRef}
        className="mobile-stage-layout mobile-tiled-layout mobile-stage-main relative h-full w-full p-3"
        data-mobile-stage-layout={layoutMode}
      >
        {visibleTiles.map((tile) => (
          <div
            key={`mobile-grid-${tile.key}`}
            className={
              mobileGridLayout.tileWidth > 0
                ? "mobile-grid-tile absolute will-change-transform"
                : "mobile-grid-tile relative h-full w-full"
            }
            style={getGridTileStyle(tile.key)}
            data-mobile-grid-tile={tile.key}
          >
            {renderTile(
              tile,
              visibleTiles.length === 1
                ? "solo"
                : tile.key === primaryTile.key
                  ? "primary"
                  : "grid",
            )}
          </div>
        ))}
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
          <Avatar
            className="relative mobile-avatar"
            id={userEmail}
            name={displayName || userEmail}
            size={avatarSize === "h-12 w-12 text-lg" ? 48 : 80}
          />
        </div>
      )}
      {isGhost && <GhostOverlay variant={variant} />}
      {isHandRaised && <HandRaisedBadge variant={variant} />}
      <TileLabel
        displayName={label}
        isMuted={isMuted}
        isActiveSpeaker={isActiveSpeaker}
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
  const videoStream = getRenderableParticipantVideoStream(participant);
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;
  const connectionStatus = participant.connectionStatus;
  const isReconnecting = connectionStatus?.state === "reconnecting";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!videoStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== videoStream) {
      video.srcObject = videoStream;
    }

    let cancelled = false;
    const playVideo = () => {
      if (cancelled) return;
      video.play().catch((err) => {
        if (err.name === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
          return;
        }
        if (err.name !== "AbortError") {
          console.error("[Meets] Mobile grid video play error:", err);
        }
      });
    };

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleResize = () => {
      scheduleReplay();
    };
    const handleOrientationChange = () => {
      scheduleReplay();
    };

    scheduleReplay();
    videoTrack?.addEventListener("unmute", scheduleReplay);
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);

    return () => {
      cancelled = true;
      videoTrack?.removeEventListener("unmute", scheduleReplay);
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      playbackRecovery.clear();
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [videoStream, videoTrack]);

  const showPlaceholder = !videoStream;
  const label = truncateDisplayName(displayName, variant === "rail" ? 14 : 20);

  return (
    <div
      className={getTileClassName({
        variant,
        isActiveSpeaker,
        isHandRaised: participant.isHandRaised,
      })}
      data-meet-video-adaptively-paused={
        participant.isVideoAdaptivelyPaused ? "true" : "false"
      }
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`h-full w-full object-cover ${
          showPlaceholder ? "hidden" : ""
        } ${isReconnecting ? "opacity-75 saturate-90" : ""}`}
      />
      {showPlaceholder && (
        <div
          className={`absolute inset-0 flex items-center justify-center bg-[#0a0a0b] ${
            isReconnecting ? "opacity-90" : ""
          }`}
        >
          <Avatar
            className="relative mobile-avatar"
            id={participant.userId}
            name={displayName}
            size={variant === "rail" ? 48 : 80}
          />
        </div>
      )}
      <ParticipantConnectionOverlay status={connectionStatus} compact />
      {participant.isGhost && <GhostOverlay variant={variant} />}
      {participant.isHandRaised && <HandRaisedBadge variant={variant} />}
      <TileLabel
        displayName={label}
        isMuted={participant.isMuted}
        isActiveSpeaker={isActiveSpeaker}
        title={displayName}
        variant={variant}
      />
    </div>
  );
});

function WarmRemoteVideo({ participant }: { participant: Participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoStream = getRenderableParticipantVideoStream(participant);
  const videoTrack = videoStream?.getVideoTracks()[0] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!videoStream) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== videoStream) {
      video.srcObject = videoStream;
    }

    let cancelled = false;
    const playVideo = () => {
      if (cancelled) return;
      video.play().catch(() => {});
    };

    const playbackRecovery = createPlaybackRecoveryScheduler({
      attemptPlayback: playVideo,
      shouldAttemptAnimationFrameReplay: () =>
        !cancelled &&
        (video.paused ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA),
    });
    const scheduleReplay = playbackRecovery.schedule;
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleReplay();
      }
    };
    const handleResize = () => {
      scheduleReplay();
    };
    const handleOrientationChange = () => {
      scheduleReplay();
    };

    scheduleReplay();
    videoTrack?.addEventListener("unmute", scheduleReplay);
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);

    return () => {
      cancelled = true;
      videoTrack?.removeEventListener("unmute", scheduleReplay);
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      playbackRecovery.clear();
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [videoStream, videoTrack]);

  if (!videoStream) {
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
  isActiveSpeaker,
  variant,
}: {
  displayName: string;
  title: string;
  suffix?: string;
  isMuted: boolean;
  isActiveSpeaker: boolean;
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
        {isActiveSpeaker && !isMuted ? (
          <span className="acm-voice-activity" aria-label="Speaking">
            <span />
            <span />
            <span />
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
  const videoStream = getRenderableParticipantVideoStream(participant);
  if (!videoStream) return false;
  return videoStream
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
