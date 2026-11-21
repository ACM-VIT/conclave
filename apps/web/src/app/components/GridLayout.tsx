"use client";

import { errorName } from "../lib/utils";
import {
  Crop,
  Hand,
  Link2,
  Maximize2,
  Minimize2,
  MicOff,
  Minus,
  MonitorUp,
  Move,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  UserPlus,
  Users,
} from "lucide-react";
import {
  memo,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSmartParticipantOrder } from "../hooks/useSmartParticipantOrder";
import { useStableSpeakerId } from "../hooks/useStableSpeakerId";
import {
  getRenderableParticipantVideoStream,
  isRenderingParticipantScreenShare,
} from "../lib/participant-media";
import { getVisibleRemoteParticipantLimit } from "../lib/participant-order-policy";
import type { Participant } from "../lib/types";
import { isSystemUserId, truncateDisplayName } from "../lib/utils";
import { observeRemoteVideoPresentation } from "../lib/remote-video-presentation";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantConnectionOverlay from "./ParticipantConnectionOverlay";
import ParticipantVideo from "./ParticipantVideo";
import GameTileOverlay from "./games/GameTileOverlay";
import { Avatar } from "@conclave/ui-tokens/web";
import {
  chooseStageMode,
  computeGridLayout,
  computeStageRailLayout,
  type GridTilePosition,
  type GridLayoutResult,
} from "@conclave/meeting-core";
import {
  clampMeetViewTiles,
  DEFAULT_MEET_VIEW_SETTINGS,
  MEET_VIEW_MIN_TILES,
  type MeetSelfViewCorner,
  type MeetSelfViewMode,
  type MeetViewMode,
  type MeetViewSettings,
} from "../lib/meet-view";
import { createPlaybackRecoveryScheduler } from "../lib/playback-recovery";
import {
  readCapturedSurfaceZoomLevel,
  readCapturedSurfaceZoomLevels,
  type CapturedSurfaceControlState,
  type CaptureControllerLike,
} from "../lib/captured-surface-control";
import { useElementSize } from "../hooks/useElementSize";
import { computeTileChrome } from "../lib/tile-chrome";
import { readVideoAspect, resolveTileAspect } from "../lib/tile-video-framing";

interface GridLayoutProps {
  localStream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  participants: Map<string, Participant>;
  userEmail: string;
  isMirrorCamera: boolean;
  activeSpeakerId: string | null;
  currentUserId: string;
  audioOutputDeviceId?: string;
  onAudioAutoplayBlocked?: () => void;
  onAudioPlaybackStarted?: () => void;
  audioPlaybackAttemptToken?: number;
  isAdmin?: boolean;
  onParticipantClick?: (userId: string) => void;
  onOpenParticipantsPanel?: () => void;
  activeVideoEffectsCount?: number;
  isVideoFramingEnabled?: boolean;
  onToggleVideoFraming?: () => void;
  viewSettings?: MeetViewSettings;
  onViewSettingsChange?: Dispatch<SetStateAction<MeetViewSettings>>;
  presentationStream?: MediaStream | null;
  presenterName?: string;
  presentationPresenterId?: string | null;
  presentationProducerId?: string | null;
  isLocalPresenter?: boolean;
  screenShareControlState?: CapturedSurfaceControlState;
  screenShareCaptureController?: CaptureControllerLike | null;
  getDisplayName: (userId: string) => string;
  sidePanelReserve?: number;
  isMobile?: boolean;
}

const WARM_BUFFER_TILES = 4;
const RECENTLY_VISIBLE_WARM_BUFFER_TILES = 4;
const RECENTLY_VISIBLE_WARM_HOLD_MS = 3500;
const PRIORITY_WARM_BUFFER_TILES = 4;
const PRESENTATION_WARM_BUFFER_TILES = 1;
const PRESENTATION_RECENTLY_VISIBLE_WARM_BUFFER_TILES = 1;
const PRESENTATION_PRIORITY_WARM_BUFFER_TILES = 2;
const GRID_PADDING = 16;
const GRID_GAP = 12;
const GRID_MAX_COLS = 6;
const STAGE_RAIL_TILE_HEIGHT = 112;
const SIDE_BY_SIDE_RAIL_HEIGHT_RATIO = 0.35;
const AUTO_GRID_MIN_TILE_WIDTH = 176;
const AUTO_GRID_MIN_TILE_HEIGHT = 99;
const MOBILE_PORTRAIT_COLS = 2;
const MOBILE_PORTRAIT_MAX_TILE_ASPECT = 1.5;
const MOBILE_LANDSCAPE_MAX_COLS = 4;

const computeGridMaxCols = (isMobile: boolean, usableWidth: number) => {
  if (isMobile) return MOBILE_LANDSCAPE_MAX_COLS;
  if (!Number.isFinite(usableWidth) || usableWidth <= 0) return GRID_MAX_COLS;
  return Math.max(
    GRID_MAX_COLS,
    Math.floor((usableWidth + GRID_GAP) / (AUTO_GRID_MIN_TILE_WIDTH + GRID_GAP)),
  );
};

const GRID_TILE_ASPECT = 16 / 9;

const getGridPackingParams = (isMobile: boolean, usableWidth: number) => ({
  maxCols: computeGridMaxCols(isMobile, usableWidth),
  targetAspect: GRID_TILE_ASPECT,
  minTileWidth: AUTO_GRID_MIN_TILE_WIDTH,
  minTileHeight: AUTO_GRID_MIN_TILE_HEIGHT,
});

const isMobilePortrait = (isMobile: boolean, width: number, height: number) =>
  isMobile && height >= width;

const computeMobilePortraitGridLayout = (
  count: number,
  width: number,
  height: number,
  gap: number,
  maxTilesPerPage: number,
): GridLayoutResult => {
  const total = Math.max(1, Math.floor(count));
  if (total === 1) {
    return {
      cols: 1,
      rows: 1,
      tileWidth: width,
      tileHeight: height,
      lastRowCount: 1,
      pages: 1,
      perPage: 1,
      contentWidth: width,
      contentHeight: height,
      offsetX: 0,
      offsetY: 0,
      positions: [
        { index: 0, row: 0, col: 0, x: 0, y: 0, width, height },
      ],
    };
  }
  const perPage = Math.min(total, Math.max(1, Math.floor(maxTilesPerPage)));
  const pages = Math.ceil(total / perPage);
  const cols = Math.min(perPage, MOBILE_PORTRAIT_COLS);
  const rows = Math.ceil(perPage / cols);
  const tileWidth = Math.max(0, Math.floor((width - (cols - 1) * gap) / cols));

  let tileHeight = tileWidth;
  const squareContentHeight = rows * tileHeight + (rows - 1) * gap;
  if (squareContentHeight < height) {
    const fitHeight = Math.floor((height - (rows - 1) * gap) / rows);
    const maxHeight = Math.floor(tileWidth * MOBILE_PORTRAIT_MAX_TILE_ASPECT);
    tileHeight = Math.max(tileWidth, Math.min(fitHeight, maxHeight));
  }
  tileHeight = Math.max(0, tileHeight);

  const contentWidth = cols * tileWidth + Math.max(0, cols - 1) * gap;
  const contentHeight = rows * tileHeight + Math.max(0, rows - 1) * gap;
  const offsetX = Math.max(0, (width - contentWidth) / 2);
  const offsetY = contentHeight <= height ? Math.max(0, (height - contentHeight) / 2) : 0;

  const positions: GridTilePosition[] = [];
  for (let index = 0; index < perPage; index += 1) {
    const row = Math.floor(index / cols);
    const rowStartIndex = row * cols;
    const rowCount = Math.min(cols, perPage - rowStartIndex);
    const rowWidth = rowCount * tileWidth + Math.max(0, rowCount - 1) * gap;
    const rowOffsetX = offsetX + Math.max(0, (contentWidth - rowWidth) / 2);
    const col = index - rowStartIndex;
    positions.push({
      index,
      row,
      col: col + Math.max(0, cols - rowCount) / 2,
      x: rowOffsetX + col * (tileWidth + gap),
      y: offsetY + row * (tileHeight + gap),
      width: tileWidth,
      height: tileHeight,
    });
  }

  const lastRowCount = perPage - (rows - 1) * cols;
  return {
    cols,
    rows,
    tileWidth,
    tileHeight,
    lastRowCount: Math.max(1, lastRowCount),
    pages,
    perPage,
    contentWidth,
    contentHeight,
    offsetX,
    offsetY,
    positions,
  };
};
const ROOM_TILING_METADATA_INTERVAL_MS = 200;
const ROOM_TILING_PROMOTE_DELAY_MS = 1200;
const ROOM_TILING_MIN_SWITCH_INTERVAL_MS = 8000;
const FLIP_DURATION_MS = 220;
const REFLOW_DURATION_MS = 280;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const FONT_SANS = "'PolySans Trial', system-ui, sans-serif";
const LOCAL_STAGE_ID = "__local__";
const PRESENTATION_TILE_ID = "__presentation__";

type EffectiveMeetViewMode = MeetViewMode | "sideBySide";
type ResolvedSelfViewMode = Exclude<MeetSelfViewMode, "auto">;
type SelfPresentationView = "placeholder" | "preview";
type MeetRoomTilingWarmReason =
  | "boundary"
  | "recently-visible"
  | "active-speaker"
  | "featured-speaker"
  | "hand-raised";
type MeetRoomTilingScore = {
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
  warmReasons: MeetRoomTilingWarmReason[];
};

type MeetVideoEffectsHumanTrack = {
  trackId: string;
  source: "face" | "foreground";
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  coverage: number;
};

type MeetVideoEffectsCropRect = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
};

type MeetVideoEffectsFrameMetadata = {
  type: "FRAME_METADATA";
  sequence: number;
  processingConfigId: number;
  approximateTimestampMs: number;
  exactTimestampMs: number | null;
  frame?: {
    width: number;
    height: number;
  };
  roomTilingMetadata?: {
    tileCount: number;
    tilesStable: boolean;
    enabledFramesCount: number;
    stableFramesCount: number;
    fallbackLevel: number;
  };
  humanTrackingMetadata?: {
    lifetimeTrackCount: number;
    activeTrackCount: number;
    trackedHumans: MeetVideoEffectsHumanTrack[];
  };
  continuousAutozoomMetadata?: {
    enabled: boolean;
    source: "off" | "face" | "foreground" | "center";
    zoomFactor: number;
    crop: MeetVideoEffectsCropRect | null;
    targetCrop: MeetVideoEffectsCropRect | null;
    recentered: boolean;
    recenterCount: number;
  };
};

type MeetLocalVideoTracking = {
  active: boolean;
  source: MeetVideoEffectsHumanTrack["source"] | "none";
  trackCount: number;
  primaryTrack: MeetVideoEffectsHumanTrack | null;
  objectPosition: string | null;
  metadataSequence: number | null;
  processingConfigId: number | null;
  exactTimestampMs: number | null;
  approximateTimestampMs: number | null;
  roomTileCount: number | null;
  autozoom: {
    enabled: boolean;
    source: "off" | "face" | "foreground" | "center";
    zoomFactor: number;
    crop: MeetVideoEffectsCropRect | null;
    targetCrop: MeetVideoEffectsCropRect | null;
    recentered: boolean;
    recenterCount: number;
  } | null;
  receivedAt: number;
};

type MeetRoomTilingMetadataBase = {
  source: "client";
  intervalMs: number;
  promoteDelayMs: number;
  minSwitchIntervalMs: number;
  activeSpeakerId: string | null;
  featuredSpeakerId: string | null;
  requestedMode: MeetViewMode;
  renderedMode: EffectiveMeetViewMode;
  effectiveMode: EffectiveMeetViewMode;
  autoStageMode: string;
  dynamicCrop: boolean;
  presenting: boolean;
  presentation: {
    tileId: string;
    presenterId: string | null;
    producerId: string | null;
    visible: boolean;
    primary: boolean;
    focus: boolean;
  };
  pinnedId: string | null;
  primaryIds: string[];
  focusIds: string[];
  visibleRemoteIds: string[];
  hiddenIds: string[];
  warmIds: string[];
  warmReasons: Record<string, MeetRoomTilingWarmReason[]>;
  fallbackLevel: number;
  orderedRemoteIds: string[];
  scores: MeetRoomTilingScore[];
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
    stageRailCapacity: number;
    stageRailRemoteCapacity: number;
  };
  stage: {
    mainKind: "presentation" | "local" | "remote" | "none";
    candidateMainKind: "presentation" | "local" | "remote" | "none";
    mainParticipantId: string | null;
    sideCompanionKind: "local" | "remote" | "none";
    sideCompanionId: string | null;
    sideBySide: boolean;
    spotlight: boolean;
  };
  selfView: {
    requested: MeetSelfViewMode;
    effective: ResolvedSelfViewMode;
    placement: "stage" | "tile" | "floating" | "minimized" | "none";
    corner: MeetSelfViewCorner;
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
    positions: Array<GridTilePosition & { id: string }>;
    gridVideoFit: "cover" | "contain";
    fullVideoTileIds: string[];
  };
  localVideo: MeetLocalVideoTracking;
};

type MeetRoomTilingMetadata = MeetRoomTilingMetadataBase & {
  sequence: number;
  timestamp: number;
  performanceTime: number;
  signature: string;
};

type MeetRoomTilingDebugSnapshot = {
  current: MeetRoomTilingMetadata | null;
  history: MeetRoomTilingMetadata[];
  sequence: number;
  intervalMs: number;
};

declare global {
  interface Window {
    __conclaveGetMeetRoomTilingDebug?: () => MeetRoomTilingDebugSnapshot;
    __conclaveMeetRoomTilingDebug?: MeetRoomTilingDebugSnapshot;
  }
}

const hasLiveTrack = (
  stream: MediaStream | null | undefined,
  kind: "audio" | "video",
) => {
  const track =
    kind === "video" ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0];
  return Boolean(track && track.readyState === "live");
};

const hasLiveVideo = (stream: MediaStream | null | undefined) =>
  hasLiveTrack(stream, "video");

const formatPresentingLabel = (presenterName: string) =>
  presenterName === "You" ? "You're presenting" : `${presenterName} is presenting`;

const participantHasLiveVideo = (participant: Participant) =>
  hasLiveVideo(getRenderableParticipantVideoStream(participant));

const participantHasLiveAudio = (participant: Participant) =>
  !participant.isMuted && hasLiveTrack(participant.audioStream, "audio");

const emptyLocalVideoTracking = (): MeetLocalVideoTracking => ({
  active: false,
  source: "none",
  trackCount: 0,
  primaryTrack: null,
  objectPosition: null,
  metadataSequence: null,
  processingConfigId: null,
  exactTimestampMs: null,
  approximateTimestampMs: null,
  roomTileCount: null,
  autozoom: null,
  receivedAt: 0,
});

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const quantizeObjectPositionPercent = (value: number) =>
  Math.round(value / 2) * 2;

const getTrackingObjectPosition = (
  track: MeetVideoEffectsHumanTrack,
  frame: MeetVideoEffectsFrameMetadata["frame"] | undefined,
  crop: MeetVideoEffectsCropRect | null | undefined,
) => {
  let centerX = clampUnit(track.centerX);
  let centerY = clampUnit(track.centerY);

  if (
    frame &&
    crop &&
    frame.width > 0 &&
    frame.height > 0 &&
    crop.sw > 0 &&
    crop.sh > 0
  ) {
    centerX = clampUnit((track.centerX * frame.width - crop.sx) / crop.sw);
    centerY = clampUnit((track.centerY * frame.height - crop.sy) / crop.sh);
  }

  const x = quantizeObjectPositionPercent(
    Math.min(82, Math.max(18, centerX * 100)),
  );
  const y = quantizeObjectPositionPercent(
    Math.min(82, Math.max(18, centerY * 100)),
  );
  return `${x}% ${y}%`;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readFiniteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readCropRect = (value: unknown): MeetVideoEffectsCropRect | null => {
  if (!isPlainRecord(value)) return null;
  const sx = readFiniteNumber(value.sx);
  const sy = readFiniteNumber(value.sy);
  const sw = readFiniteNumber(value.sw);
  const sh = readFiniteNumber(value.sh);
  if (sx === null || sy === null || sw === null || sh === null) return null;
  return { sx, sy, sw, sh };
};

const readHumanTrack = (value: unknown): MeetVideoEffectsHumanTrack | null => {
  if (!isPlainRecord(value)) return null;
  const source = value.source;
  if (source !== "face" && source !== "foreground") return null;
  const centerX = readFiniteNumber(value.centerX);
  const centerY = readFiniteNumber(value.centerY);
  const width = readFiniteNumber(value.width);
  const height = readFiniteNumber(value.height);
  const coverage = readFiniteNumber(value.coverage);
  if (
    centerX === null ||
    centerY === null ||
    width === null ||
    height === null ||
    coverage === null
  ) {
    return null;
  }

  return {
    trackId:
      typeof value.trackId === "string" && value.trackId
        ? value.trackId
        : `${source}:local:0`,
    source,
    centerX,
    centerY,
    width,
    height,
    coverage,
  };
};

const readVideoEffectsFrameMetadata = (
  detail: unknown,
): MeetVideoEffectsFrameMetadata | null => {
  if (!isPlainRecord(detail) || detail.type !== "FRAME_METADATA") return null;
  const sequence = readFiniteNumber(detail.sequence);
  const processingConfigId = readFiniteNumber(detail.processingConfigId);
  const approximateTimestampMs = readFiniteNumber(detail.approximateTimestampMs);
  if (
    sequence === null ||
    processingConfigId === null ||
    approximateTimestampMs === null
  ) {
    return null;
  }

  const exactTimestampMs = readFiniteNumber(detail.exactTimestampMs);
  const humanTrackingMetadata = isPlainRecord(detail.humanTrackingMetadata)
    ? detail.humanTrackingMetadata
    : null;
  const trackedHumans = Array.isArray(
    humanTrackingMetadata?.trackedHumans,
  )
    ? humanTrackingMetadata.trackedHumans
        .map(readHumanTrack)
        .filter((track): track is MeetVideoEffectsHumanTrack => Boolean(track))
    : [];
  const roomTilingMetadata = isPlainRecord(detail.roomTilingMetadata)
    ? detail.roomTilingMetadata
    : null;
  const continuousAutozoomMetadata = isPlainRecord(
    detail.continuousAutozoomMetadata,
  )
    ? detail.continuousAutozoomMetadata
    : null;
  const frame = isPlainRecord(detail.frame) ? detail.frame : null;
  const frameWidth = readFiniteNumber(frame?.width);
  const frameHeight = readFiniteNumber(frame?.height);
  const autozoomSource = continuousAutozoomMetadata?.source;
  const hasKnownAutozoomSource =
    autozoomSource === "off" ||
    autozoomSource === "face" ||
    autozoomSource === "foreground" ||
    autozoomSource === "center";
  const autozoomCrop = readCropRect(continuousAutozoomMetadata?.crop);
  const autozoomTargetCrop = readCropRect(
    continuousAutozoomMetadata?.targetCrop,
  );

  return {
    type: "FRAME_METADATA",
    sequence,
    processingConfigId,
    approximateTimestampMs,
    exactTimestampMs,
    frame:
      frameWidth !== null && frameHeight !== null
        ? { width: frameWidth, height: frameHeight }
        : undefined,
    roomTilingMetadata: roomTilingMetadata
      ? {
          tileCount: readFiniteNumber(roomTilingMetadata.tileCount) ?? 0,
          tilesStable: roomTilingMetadata.tilesStable === true,
          enabledFramesCount:
            readFiniteNumber(roomTilingMetadata.enabledFramesCount) ?? 0,
          stableFramesCount:
            readFiniteNumber(roomTilingMetadata.stableFramesCount) ?? 0,
          fallbackLevel:
            readFiniteNumber(roomTilingMetadata.fallbackLevel) ?? 0,
        }
      : undefined,
    humanTrackingMetadata: {
      lifetimeTrackCount:
        readFiniteNumber(humanTrackingMetadata?.lifetimeTrackCount) ??
        trackedHumans.length,
      activeTrackCount:
        readFiniteNumber(humanTrackingMetadata?.activeTrackCount) ??
        trackedHumans.length,
      trackedHumans,
    },
    continuousAutozoomMetadata:
      continuousAutozoomMetadata && hasKnownAutozoomSource
        ? {
            enabled: continuousAutozoomMetadata.enabled === true,
            source: autozoomSource,
            zoomFactor:
              readFiniteNumber(continuousAutozoomMetadata.zoomFactor) ?? 1,
            crop: autozoomCrop,
            targetCrop: autozoomTargetCrop,
            recentered: continuousAutozoomMetadata.recentered === true,
            recenterCount:
              readFiniteNumber(continuousAutozoomMetadata.recenterCount) ?? 0,
          }
        : undefined,
  };
};

const createLocalVideoTracking = (
  metadata: MeetVideoEffectsFrameMetadata | null,
): MeetLocalVideoTracking => {
  if (!metadata) return emptyLocalVideoTracking();
  const tracks = metadata.humanTrackingMetadata?.trackedHumans ?? [];
  const primaryTrack =
    tracks.find((track) => track.source === "face") ?? tracks[0] ?? null;
  const autozoomCrop = metadata.continuousAutozoomMetadata?.crop ?? null;

  return {
    active: Boolean(primaryTrack),
    source: primaryTrack?.source ?? "none",
    trackCount: tracks.length,
    primaryTrack,
    objectPosition: primaryTrack
      ? getTrackingObjectPosition(primaryTrack, metadata.frame, autozoomCrop)
      : null,
    metadataSequence: metadata.sequence,
    processingConfigId: metadata.processingConfigId,
    exactTimestampMs: metadata.exactTimestampMs,
    approximateTimestampMs: metadata.approximateTimestampMs,
    roomTileCount: metadata.roomTilingMetadata?.tileCount ?? null,
    autozoom: metadata.continuousAutozoomMetadata
      ? {
          enabled: metadata.continuousAutozoomMetadata.enabled,
          source: metadata.continuousAutozoomMetadata.source,
          zoomFactor: metadata.continuousAutozoomMetadata.zoomFactor,
          crop: metadata.continuousAutozoomMetadata.crop,
          targetCrop: metadata.continuousAutozoomMetadata.targetCrop,
          recentered: metadata.continuousAutozoomMetadata.recentered,
          recenterCount: metadata.continuousAutozoomMetadata.recenterCount,
        }
      : null,
    receivedAt: Math.round(performance.now()),
  };
};

const getLocalVideoTrackingRenderSignature = (
  tracking: MeetLocalVideoTracking,
) =>
  [
    tracking.active ? "1" : "0",
    tracking.source,
    String(tracking.trackCount),
    tracking.objectPosition ?? "",
    String(tracking.processingConfigId ?? ""),
    String(tracking.roomTileCount ?? ""),
    tracking.autozoom?.enabled ? "1" : "0",
    tracking.autozoom?.source ?? "none",
    String(Math.round((tracking.autozoom?.zoomFactor ?? 1) * 100) / 100),
    String(tracking.autozoom?.recenterCount ?? 0),
  ].join("|");

const isLocalVideoTrackingRenderEquivalent = (
  left: MeetLocalVideoTracking,
  right: MeetLocalVideoTracking,
) =>
  getLocalVideoTrackingRenderSignature(left) ===
  getLocalVideoTrackingRenderSignature(right);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const computeMeetAutoTileLimit = (
  requestedMaxTiles: number,
  gridWidth: number,
  gridHeight: number,
  isMobile = false,
) => {
  const usableWidth = Math.max(0, gridWidth - GRID_PADDING * 2);
  const usableHeight = Math.max(0, gridHeight - GRID_PADDING * 2);

  if (usableWidth <= 0 || usableHeight <= 0) {
    return requestedMaxTiles;
  }

  if (isMobilePortrait(isMobile, usableWidth, usableHeight)) {
    return requestedMaxTiles;
  }

  const { maxCols, targetAspect, minTileWidth, minTileHeight } =
    getGridPackingParams(isMobile, usableWidth);

  for (
    let tileCount = requestedMaxTiles;
    tileCount >= MEET_VIEW_MIN_TILES;
    tileCount -= 1
  ) {
    const candidate = computeGridLayout(tileCount, usableWidth, usableHeight, {
      gap: GRID_GAP,
      maxCols,
      maxTilesPerPage: tileCount,
      targetAspect,
    });
    if (
      candidate.tileWidth >= minTileWidth &&
      candidate.tileHeight >= minTileHeight
    ) {
      return tileCount;
    }
  }

  return Math.min(requestedMaxTiles, MEET_VIEW_MIN_TILES);
};

// A change to `signature` (tile order and shapes) animates the tiles. A change
// to `layoutSignature` alone, such as a window resize, snaps them.
function useFlip(
  signature: string,
  layoutSignature: string,
  enabled: boolean,
  reflowNonce: number,
) {
  const nodeMap = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevIdentitySignature = useRef<string | null>(null);
  const prevReflowNonce = useRef(reflowNonce);
  const pendingReflowFirst = useRef<Map<string, DOMRect> | null>(null);
  const frameIds = useRef<number[]>([]);

  const register = useCallback((key: string, node: HTMLElement | null) => {
    if (node) nodeMap.current.set(key, node);
    else nodeMap.current.delete(key);
  }, []);

  useLayoutEffect(() => {
    const cancelPendingFrames = () => {
      frameIds.current.forEach((frameId) => window.cancelAnimationFrame(frameId));
      frameIds.current = [];
    };
    cancelPendingFrames();

    if (!enabled) {
      prevRects.current = new Map();
      prevIdentitySignature.current = null;
      pendingReflowFirst.current = null;
      prevReflowNonce.current = reflowNonce;
      return;
    }

    const nodes = nodeMap.current;
    const reduced = prefersReducedMotion();

    const next = new Map<string, DOMRect>();
    nodes.forEach((node, key) => next.set(key, node.getBoundingClientRect()));

    if (prevReflowNonce.current !== reflowNonce) {
      prevReflowNonce.current = reflowNonce;
      pendingReflowFirst.current = prevRects.current;
      prevRects.current = next;
      const dropId = requestAnimationFrame(() => {
        pendingReflowFirst.current = null;
      });
      frameIds.current.push(dropId);
      return cancelPendingFrames;
    }

    const identityChanged =
      prevIdentitySignature.current !== null &&
      prevIdentitySignature.current !== signature;

    let firstRects: Map<string, DOMRect> | null = null;
    let duration = FLIP_DURATION_MS;
    if (pendingReflowFirst.current) {
      firstRects = pendingReflowFirst.current;
      duration = REFLOW_DURATION_MS;
    } else if (identityChanged) {
      firstRects = prevRects.current;
    }
    pendingReflowFirst.current = null;

    if (firstRects && !reduced) {
      nodes.forEach((node, key) => {
        const oldRect = firstRects.get(key);
        const newRect = next.get(key);
        if (!oldRect || !newRect || newRect.width === 0 || newRect.height === 0) {
          node.style.transition = "none";
          node.style.transform = "";
          return;
        }
        const dx = oldRect.left - newRect.left;
        const dy = oldRect.top - newRect.top;
        const sx = oldRect.width / newRect.width;
        const sy = oldRect.height / newRect.height;
        if (
          Math.abs(dx) < 1 &&
          Math.abs(dy) < 1 &&
          Math.abs(sx - 1) < 0.01 &&
          Math.abs(sy - 1) < 0.01
        ) {
          node.style.transition = "none";
          node.style.transform = "";
          return;
        }
        node.style.transition = "none";
        node.style.transformOrigin = "0 0";
        node.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`;
        const frameId = requestAnimationFrame(() => {
          node.style.transition = `transform ${duration}ms ${FLIP_EASING}`;
          node.style.transform = "translate3d(0, 0, 0) scale(1, 1)";
        });
        frameIds.current.push(frameId);
      });
    } else {
      nodes.forEach((node) => {
        node.style.transition = "none";
        node.style.transform = "";
        node.style.transformOrigin = "";
      });
    }

    prevRects.current = next;
    prevIdentitySignature.current = signature;
    return cancelPendingFrames;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, layoutSignature, enabled, reflowNonce]);

  return register;
}

function GridLayout({
  localStream,
  isCameraOff,
  isMuted,
  isHandRaised,
  participants,
  userEmail,
  isMirrorCamera,
  activeSpeakerId,
  currentUserId,
  audioOutputDeviceId,
  onAudioAutoplayBlocked,
  onAudioPlaybackStarted,
  audioPlaybackAttemptToken,
  isAdmin = false,
  onParticipantClick,
  onOpenParticipantsPanel,
  activeVideoEffectsCount = 0,
  viewSettings = DEFAULT_MEET_VIEW_SETTINGS,
  onViewSettingsChange,
  presentationStream = null,
  presenterName = "Someone",
  presentationPresenterId = null,
  presentationProducerId = null,
  isLocalPresenter = false,
  screenShareControlState,
  screenShareCaptureController = null,
  getDisplayName,
  sidePanelReserve = 0,
  isMobile = false,
}: GridLayoutProps) {
  const stageRootRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const localGridTileRef = useRef<HTMLDivElement>(null);
  const localGridTileSize = useElementSize(localGridTileRef);
  const localTileChrome = computeTileChrome(localGridTileSize);
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const [selfViewDragPoint, setSelfViewDragPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "shared" | "copied">(
    "idle"
  );
  const copyTimeoutRef = useRef<number | null>(null);
  const inviteTimeoutRef = useRef<number | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [fullVideoTileIds, setFullVideoTileIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [videoAspectById, setVideoAspectById] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const videoAspectCallbacks = useRef(
    new Map<string, (aspect: number | null) => void>(),
  );
  const getVideoAspectCallback = useCallback((tileId: string) => {
    let callback = videoAspectCallbacks.current.get(tileId);
    if (!callback) {
      callback = (aspect) =>
        setVideoAspectById((prev) => {
          if ((prev.get(tileId) ?? null) === aspect) return prev;
          const next = new Map(prev);
          if (aspect === null) next.delete(tileId);
          else next.set(tileId, aspect);
          return next;
        });
      videoAspectCallbacks.current.set(tileId, callback);
    }
    return callback;
  }, []);
  const togglePin = useCallback(
    (userId: string) => setPinnedId((prev) => (prev === userId ? null : userId)),
    [],
  );
  const toggleLocalPin = useCallback(
    () =>
      setPinnedId((prev) =>
        prev === LOCAL_STAGE_ID ? null : LOCAL_STAGE_ID,
      ),
    [],
  );
  const toggleFullVideoTile = useCallback((tileId: string) => {
    setFullVideoTileIds((prev) => {
      const next = new Set(prev);
      if (next.has(tileId)) {
        next.delete(tileId);
      } else {
        next.add(tileId);
      }
      return next;
    });
  }, []);
  const canRenderSelfView = true;
  const isLocalActiveSpeaker = activeSpeakerId === currentUserId;
  const isLocalPinned = pinnedId === LOCAL_STAGE_ID;
  const hasPresentation = hasLiveVideo(presentationStream);
  const [selfPresentationView, setSelfPresentationView] =
    useState<SelfPresentationView>("placeholder");
  useLayoutEffect(() => {
    if (!isLocalPresenter) {
      setSelfPresentationView("placeholder");
    }
  }, [isLocalPresenter]);
  const presentationSelfView = isLocalPresenter
    ? { mode: selfPresentationView, onModeChange: setSelfPresentationView }
    : undefined;
  const presentationCaptureControl =
    isLocalPresenter && screenShareControlState?.available
      ? {
          controller: screenShareCaptureController,
          state: screenShareControlState,
        }
      : undefined;
  const localVideoTrack = localStream?.getVideoTracks()[0] ?? null;
  const localVideoTrackingRef = useRef<MeetLocalVideoTracking>(
    emptyLocalVideoTracking(),
  );
  const localVideoTrackingFlushTimerRef = useRef<number | null>(null);
  const lastLocalVideoTrackingFlushAtRef = useRef(0);
  const [localVideoTracking, setLocalVideoTracking] =
    useState<MeetLocalVideoTracking>(() => emptyLocalVideoTracking());

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

  useEffect(() => {
    const flushLocalVideoTracking = () => {
      localVideoTrackingFlushTimerRef.current = null;
      lastLocalVideoTrackingFlushAtRef.current = performance.now();
      const nextTracking = localVideoTrackingRef.current;
      setLocalVideoTracking((previousTracking) =>
        isLocalVideoTrackingRenderEquivalent(previousTracking, nextTracking)
          ? previousTracking
          : nextTracking,
      );
    };
    const scheduleFlush = () => {
      const now = performance.now();
      const delay = Math.max(
        0,
        ROOM_TILING_METADATA_INTERVAL_MS -
          (now - lastLocalVideoTrackingFlushAtRef.current),
      );
      if (delay <= 0) {
        flushLocalVideoTracking();
        return;
      }
      if (localVideoTrackingFlushTimerRef.current !== null) return;
      localVideoTrackingFlushTimerRef.current = window.setTimeout(
        flushLocalVideoTracking,
        delay,
      );
    };
    const handleFrameMetadata = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const metadata = readVideoEffectsFrameMetadata(detail);
      if (!metadata) return;
      localVideoTrackingRef.current = createLocalVideoTracking(metadata);
      scheduleFlush();
    };

    window.addEventListener(
      "conclave:video-effects-frame-metadata",
      handleFrameMetadata,
    );
    return () => {
      window.removeEventListener(
        "conclave:video-effects-frame-metadata",
        handleFrameMetadata,
      );
      if (localVideoTrackingFlushTimerRef.current !== null) {
        window.clearTimeout(localVideoTrackingFlushTimerRef.current);
        localVideoTrackingFlushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isCameraOff && hasLiveVideo(localStream) && activeVideoEffectsCount > 0) {
      return;
    }
    if (localVideoTrackingFlushTimerRef.current !== null) {
      window.clearTimeout(localVideoTrackingFlushTimerRef.current);
      localVideoTrackingFlushTimerRef.current = null;
    }
    const emptyTracking = emptyLocalVideoTracking();
    localVideoTrackingRef.current = emptyTracking;
    setLocalVideoTracking((previousTracking) =>
      isLocalVideoTrackingRenderEquivalent(previousTracking, emptyTracking)
        ? previousTracking
        : emptyTracking,
    );
  }, [activeVideoEffectsCount, isCameraOff, localStream]);

  const allRemoteParticipants = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) =>
          !isSystemUserId(participant.userId) &&
          participant.userId !== currentUserId
      ),
    [currentUserId, participants]
  );

  const remoteInput = useMemo(
    () =>
      allRemoteParticipants.filter(
        (participant) =>
          !viewSettings.hideTilesWithoutVideo ||
          participantHasLiveVideo(participant) ||
          participant.userId === activeSpeakerId ||
          participant.userId === pinnedId
      ),
    [
      activeSpeakerId,
      allRemoteParticipants,
      pinnedId,
      viewSettings.hideTilesWithoutVideo,
    ]
  );
  const roomSpeakerParticipantIds = useMemo(
    () => [
      ...(canRenderSelfView ? [currentUserId] : []),
      ...remoteInput.map((participant) => participant.userId),
    ],
    [canRenderSelfView, currentUserId, remoteInput],
  );
  const featuredSpeakerId = useStableSpeakerId({
    primarySpeakerId: activeSpeakerId,
    participantIds: roomSpeakerParticipantIds,
    promoteDelayMs: ROOM_TILING_PROMOTE_DELAY_MS,
    minSwitchIntervalMs: ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
  });
  const requestedSelfViewMode = viewSettings.selfViewMode;
  const requestedSelfViewCorner = viewSettings.selfViewCorner;
  const autoSelfViewMode: ResolvedSelfViewMode =
    !hasPresentation && remoteInput.length === 1 ? "floating" : "tile";
  const detachedSelfViewMode: ResolvedSelfViewMode =
    requestedSelfViewMode === "auto"
      ? autoSelfViewMode
      : requestedSelfViewMode;
  const canDetachSelfView =
    canRenderSelfView && (remoteInput.length > 0 || hasPresentation);
  const effectiveSelfViewMode: ResolvedSelfViewMode = canDetachSelfView
    ? detachedSelfViewMode
    : "tile";
  const shouldShowSelfAsTile =
    canRenderSelfView && (effectiveSelfViewMode === "tile" || isLocalPinned);
  const isLocalFeaturedSpeaker = featuredSpeakerId === currentUserId;
  const featuredRemoteParticipant =
    featuredSpeakerId && featuredSpeakerId !== currentUserId
      ? remoteInput.find((participant) => participant.userId === featuredSpeakerId) ??
        null
      : null;
  const hasFeaturedVideoSpeaker =
    isLocalFeaturedSpeaker
      ? shouldShowSelfAsTile && !isCameraOff && hasLiveVideo(localStream)
      : Boolean(
          featuredRemoteParticipant &&
            participantHasLiveVideo(featuredRemoteParticipant),
        );
  const autoStageMode = chooseStageMode({
    count: remoteInput.length + (canRenderSelfView ? 1 : 0),
    presenting: hasPresentation,
    pinned: Boolean(pinnedId),
    hasActiveVideoSpeaker: hasFeaturedVideoSpeaker,
  });
  const effectiveViewMode: EffectiveMeetViewMode =
    viewSettings.mode === "auto"
      ? autoStageMode === "sidebar" ||
        autoStageMode === "spotlight" ||
        autoStageMode === "sideBySide"
        ? autoStageMode
        : "tiled"
      : viewSettings.mode;
  const renderedViewMode: EffectiveMeetViewMode =
    pinnedId && effectiveViewMode === "tiled" ? "spotlight" : effectiveViewMode;
  const usesAutoDynamicCrop =
    viewSettings.mode === "auto" && renderedViewMode === "tiled";
  const gridVideoObjectFit: "cover" | "contain" = usesAutoDynamicCrop
    ? "cover"
    : "contain";
  const getGridVideoObjectFit = useCallback(
    (tileId: string): "cover" | "contain" =>
      usesAutoDynamicCrop && fullVideoTileIds.has(tileId)
        ? "contain"
        : gridVideoObjectFit,
    [fullVideoTileIds, gridVideoObjectFit, usesAutoDynamicCrop],
  );
  const fullVideoTileIdList = useMemo(
    () => Array.from(fullVideoTileIds).sort(),
    [fullVideoTileIds],
  );

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setGridSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const prevReserveRef = useRef(sidePanelReserve);
  useLayoutEffect(() => {
    if (prevReserveRef.current === sidePanelReserve) return;
    prevReserveRef.current = sidePanelReserve;
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    setGridSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height }
    );
  }, [sidePanelReserve]);

  const requestedMaxTiles = clampMeetViewTiles(viewSettings.maxTiles);
  const autoGridTileLimit = useMemo(
    () =>
      viewSettings.mode === "auto" && renderedViewMode === "tiled"
        ? computeMeetAutoTileLimit(
            requestedMaxTiles,
            gridSize.width,
            gridSize.height,
            isMobile,
          )
        : requestedMaxTiles,
    [
      gridSize.height,
      gridSize.width,
      isMobile,
      renderedViewMode,
      requestedMaxTiles,
      viewSettings.mode,
    ],
  );
  const usesMeasuredAutoTileLimit =
    viewSettings.mode === "auto" && renderedViewMode === "tiled";
  const maxGridTiles =
    renderedViewMode === "spotlight"
      ? 1
      : renderedViewMode === "sidebar" || renderedViewMode === "sideBySide"
        ? Math.min(requestedMaxTiles, 8)
        : usesMeasuredAutoTileLimit
          ? autoGridTileLimit
          : requestedMaxTiles;
  const wantsStageLayout =
    renderedViewMode === "sidebar" ||
    renderedViewMode === "sideBySide" ||
    renderedViewMode === "spotlight" ||
    Boolean(pinnedId);
  const hasGridPresentationTile = hasPresentation && !wantsStageLayout;
  const gridReservedTiles =
    (shouldShowSelfAsTile ? 1 : 0) + (hasGridPresentationTile ? 1 : 0);
  const maxRemoteWithoutOverflow = Math.max(
    0,
    maxGridTiles - gridReservedTiles,
  );
  const maxVisibleRemoteParticipants = getVisibleRemoteParticipantLimit({
    remoteParticipantCount: remoteInput.length,
    maxRemoteWithoutOverflow,
    isOverflowOpen,
  });
  const orderedRemoteParticipants = useSmartParticipantOrder(
    remoteInput,
    activeSpeakerId,
    {
      promoteDelayMs: ROOM_TILING_PROMOTE_DELAY_MS,
      minSwitchIntervalMs: ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
      minParticipantsForReorder: maxRemoteWithoutOverflow + 1,
      visibleParticipantLimit: maxVisibleRemoteParticipants,
    },
  );
  const orderedRemoteParticipantIds = useMemo(
    () => new Set(orderedRemoteParticipants.map((participant) => participant.userId)),
    [orderedRemoteParticipants],
  );
  useEffect(() => {
    setFullVideoTileIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((tileId) => {
        if (tileId === "local" || orderedRemoteParticipantIds.has(tileId)) {
          next.add(tileId);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    setVideoAspectById((prev) => {
      const next = new Map(
        Array.from(prev).filter(
          ([tileId]) => tileId === "local" || orderedRemoteParticipantIds.has(tileId),
        ),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [orderedRemoteParticipantIds]);
  const pinnedParticipant =
    pinnedId && pinnedId !== LOCAL_STAGE_ID && pinnedId !== PRESENTATION_TILE_ID
      ? orderedRemoteParticipants.find((p) => p.userId === pinnedId) ?? null
      : null;
  useEffect(() => {
    if (
      pinnedId &&
      pinnedId !== LOCAL_STAGE_ID &&
      pinnedId !== PRESENTATION_TILE_ID &&
      !orderedRemoteParticipants.some((p) => p.userId === pinnedId)
    ) {
      setPinnedId(null);
    }
  }, [pinnedId, orderedRemoteParticipants]);
  useEffect(() => {
    if (pinnedId === PRESENTATION_TILE_ID && !hasPresentation) {
      setPinnedId(null);
    }
  }, [pinnedId, hasPresentation]);
  const isSolo = allRemoteParticipants.length === 0 && !hasPresentation;
  const visibleParticipants = useMemo(() => {
    if (maxVisibleRemoteParticipants <= 0) {
      return [];
    }

    return orderedRemoteParticipants.slice(0, maxVisibleRemoteParticipants);
  }, [orderedRemoteParticipants, maxVisibleRemoteParticipants]);

  const hiddenParticipants = useMemo(() => {
    const visibleIds = new Set(
      visibleParticipants.map((participant) => participant.userId)
    );
    return orderedRemoteParticipants.filter(
      (participant) => !visibleIds.has(participant.userId)
    );
  }, [orderedRemoteParticipants, visibleParticipants]);
  const stageMainKind: "presentation" | "local" | "remote" | null =
    isLocalPinned
      ? "local"
      : pinnedParticipant
        ? "remote"
        : hasPresentation
          ? "presentation"
          : isLocalFeaturedSpeaker && hasFeaturedVideoSpeaker
            ? "local"
            : featuredRemoteParticipant || orderedRemoteParticipants[0]
              ? "remote"
              : null;
  const stageMainParticipant =
    stageMainKind === "remote"
      ? pinnedParticipant ??
        featuredRemoteParticipant ??
        orderedRemoteParticipants[0] ??
        null
      : null;
  const usesStageLayout = Boolean(stageMainKind) && wantsStageLayout;
  const stageMainParticipantId = stageMainParticipant?.userId ?? null;

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;

    if (!localStream || isCameraOff) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== localStream) {
      video.srcObject = localStream;
    }

    let cancelled = false;
    const playVideo = () => {
      if (cancelled) return;
      video.play().catch((err) => {
        if (errorName(err) === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
          return;
        }
        if (errorName(err) !== "AbortError") {
          console.error("[Meets] Grid local video play error:", err);
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

    scheduleReplay();
    localVideoTrack?.addEventListener("unmute", scheduleReplay);
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      localVideoTrack?.removeEventListener("unmute", scheduleReplay);
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      playbackRecovery.clear();
      if (video.srcObject === localStream) {
        video.srcObject = null;
      }
    };
  }, [isCameraOff, localStream, localVideoTrack, usesStageLayout]);

  useEffect(() => {
    const reportAspect = getVideoAspectCallback("local");
    if (!localVideoTrack || isCameraOff) {
      reportAspect(null);
      return;
    }
    const video = localVideoRef.current;
    // The track settings give the shape before the first frame. After that
    // the frames on screen decide.
    const readAspect = () => {
      const { width = 0, height = 0 } = localVideoTrack.getSettings();
      reportAspect(
        video && video.videoWidth > 0
          ? readVideoAspect(video.videoWidth, video.videoHeight)
          : readVideoAspect(width, height),
      );
    };
    readAspect();
    video?.addEventListener("loadedmetadata", readAspect);
    video?.addEventListener("resize", readAspect);
    return () => {
      video?.removeEventListener("loadedmetadata", readAspect);
      video?.removeEventListener("resize", readAspect);
    };
  }, [
    getVideoAspectCallback,
    isCameraOff,
    localVideoTrack,
    shouldShowSelfAsTile,
    usesStageLayout,
  ]);

  const sideBySideFeaturedRemoteParticipant =
    featuredRemoteParticipant && participantHasLiveVideo(featuredRemoteParticipant)
      ? featuredRemoteParticipant
      : null;
  const sideBySideFirstVideoParticipant =
    orderedRemoteParticipants.find((participant) =>
      participantHasLiveVideo(participant),
    ) ?? null;
  const sideBySideCompanionKind: "local" | "remote" | null =
    renderedViewMode === "sideBySide" && hasPresentation
      ? shouldShowSelfAsTile &&
        isLocalFeaturedSpeaker &&
        !isCameraOff &&
        hasLiveVideo(localStream)
        ? "local"
        : sideBySideFeaturedRemoteParticipant || sideBySideFirstVideoParticipant
          ? "remote"
          : null
      : null;
  const sideBySideCompanionParticipant =
    sideBySideCompanionKind === "remote"
      ? sideBySideFeaturedRemoteParticipant ?? sideBySideFirstVideoParticipant
      : null;
  const sideBySideCompanionParticipantId =
    sideBySideCompanionParticipant?.userId ?? null;
  const usesSideBySideLayout =
    usesStageLayout &&
    renderedViewMode === "sideBySide" &&
    hasPresentation &&
    Boolean(sideBySideCompanionKind);
  const usesSpotlightLayout = usesStageLayout && renderedViewMode === "spotlight";
  const stageRailLocalTileCount =
    usesStageLayout &&
    !usesSpotlightLayout &&
    shouldShowSelfAsTile &&
    (usesSideBySideLayout
      ? sideBySideCompanionKind !== "local"
      : stageMainKind !== "local")
      ? 1
      : 0;
  const presentationRenderedAsPrimary =
    hasGridPresentationTile ||
    usesSideBySideLayout ||
    (usesStageLayout && stageMainKind === "presentation");
  const presentationRenderedInRail =
    usesStageLayout &&
    !usesSpotlightLayout &&
    !usesSideBySideLayout &&
    hasPresentation &&
    stageMainKind !== "presentation";
  const isPresentationRendered =
    hasPresentation &&
    (presentationRenderedAsPrimary || presentationRenderedInRail);
  const stageRailPresentationTileCount = presentationRenderedInRail ? 1 : 0;
  const stageRailFixedTileCount =
    stageRailLocalTileCount + stageRailPresentationTileCount;
  const stageBudgetCompanionTileCount =
    sideBySideCompanionKind === "remote" ? 1 : 0;
  const stageRailCandidateParticipants = useMemo(
    () =>
      usesStageLayout
        ? orderedRemoteParticipants.filter(
            (participant) =>
              participant.userId !== stageMainParticipantId &&
              participant.userId !== sideBySideCompanionParticipantId,
          )
        : [],
    [
      orderedRemoteParticipants,
      sideBySideCompanionParticipantId,
      stageMainParticipantId,
      usesStageLayout,
    ],
  );
  const stageRailViewportHeight = usesStageLayout && !usesSpotlightLayout
    ? Math.max(0, gridSize.height - GRID_PADDING * 2) *
      (usesSideBySideLayout ? SIDE_BY_SIDE_RAIL_HEIGHT_RATIO : 1)
    : 0;
  const stageRailLayout = useMemo(
    () =>
      computeStageRailLayout({
        candidateCount: stageRailCandidateParticipants.length,
        fixedTileCount:
          stageRailFixedTileCount + stageBudgetCompanionTileCount,
        maxTiles: Math.max(0, maxGridTiles - 1),
        railHeight: stageRailViewportHeight,
        tileHeight: STAGE_RAIL_TILE_HEIGHT,
        gap: GRID_GAP,
      }),
    [
      maxGridTiles,
      stageBudgetCompanionTileCount,
      stageRailCandidateParticipants.length,
      stageRailFixedTileCount,
      stageRailViewportHeight,
    ],
  );
  const stageSideRemoteCapacity = usesSpotlightLayout
    ? 0
    : stageRailLayout.remoteCapacity;
  const stageSideParticipants = useMemo(
    () =>
      usesStageLayout
        ? stageRailCandidateParticipants.slice(0, stageSideRemoteCapacity)
        : [],
    [
      stageRailCandidateParticipants,
      stageSideRemoteCapacity,
      usesStageLayout,
    ],
  );
  const stageSideParticipantIds = useMemo(
    () =>
      new Set(
        stageSideParticipants.map((participant) => participant.userId),
      ),
    [stageSideParticipants],
  );
  const stageHiddenParticipants = useMemo(
    () =>
      usesStageLayout
        ? orderedRemoteParticipants.filter(
            (participant) =>
              participant.userId !== stageMainParticipantId &&
              participant.userId !== sideBySideCompanionParticipantId &&
              !stageSideParticipantIds.has(participant.userId),
          )
        : hiddenParticipants,
    [
      hiddenParticipants,
      orderedRemoteParticipants,
      sideBySideCompanionParticipantId,
      stageMainParticipantId,
      stageSideParticipantIds,
      usesStageLayout,
    ],
  );
  const overflowParticipants = useMemo(
    () =>
      usesStageLayout ? stageHiddenParticipants : hiddenParticipants,
    [hiddenParticipants, stageHiddenParticipants, usesStageLayout],
  );
  const hiddenParticipantsCount = overflowParticipants.length;
  const showStageOverflowTile =
    usesStageLayout &&
    !usesSpotlightLayout &&
    stageRailLayout.overflowTile &&
    hiddenParticipantsCount > 0;
  const roomTilingRemoteVisibleIds = useMemo(() => {
    const ids: string[] = [];
    if (usesStageLayout) {
      if (stageMainKind === "remote" && stageMainParticipantId) {
        ids.push(stageMainParticipantId);
      }
      if (sideBySideCompanionParticipantId) {
        ids.push(sideBySideCompanionParticipantId);
      }
      stageSideParticipants.forEach((participant) => ids.push(participant.userId));
    } else {
      visibleParticipants.forEach((participant) => ids.push(participant.userId));
    }
    if (isOverflowOpen) {
      overflowParticipants.forEach((participant) => ids.push(participant.userId));
    }
    return Array.from(new Set(ids));
  }, [
    isOverflowOpen,
    overflowParticipants,
    sideBySideCompanionParticipantId,
    stageMainKind,
    stageMainParticipantId,
    stageSideParticipants,
    usesStageLayout,
    visibleParticipants,
  ]);
  const roomTilingRemoteVisibleIdSignature = useMemo(
    () => roomTilingRemoteVisibleIds.join(","),
    [roomTilingRemoteVisibleIds],
  );
  const orderedRemoteIdSignature = useMemo(
    () => orderedRemoteParticipants.map((participant) => participant.userId).join(","),
    [orderedRemoteParticipants],
  );
  const overflowParticipantIdSignature = useMemo(
    () => overflowParticipants.map((participant) => participant.userId).join(","),
    [overflowParticipants],
  );
  const recentlyVisibleWarmIdsRef = useRef<Map<string, number>>(new Map());
  const previousVisibleWarmIdsRef = useRef<Set<string>>(new Set());
  const [recentlyVisibleWarmRevision, setRecentlyVisibleWarmRevision] =
    useState(0);

  useEffect(() => {
    const now = performance.now();
    const visibleIds = new Set(
      roomTilingRemoteVisibleIdSignature.split(",").filter(Boolean),
    );
    const previousVisibleIds = previousVisibleWarmIdsRef.current;
    const orderedIds = new Set(
      orderedRemoteIdSignature.split(",").filter(Boolean),
    );
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
        const expiresAt = now + RECENTLY_VISIBLE_WARM_HOLD_MS;
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
    orderedRemoteIdSignature,
    overflowParticipantIdSignature,
    roomTilingRemoteVisibleIdSignature,
  ]);

  const { warmParticipants, warmReasonById } = useMemo(() => {
    const empty = {
      warmParticipants: [] as Participant[],
      warmReasonById: new Map<string, MeetRoomTilingWarmReason[]>(),
    };
    if (isOverflowOpen) return empty;

    const visibleSet = new Set(roomTilingRemoteVisibleIds);
    const warmById = new Map<string, Participant>();
    const reasonSets = new Map<string, Set<MeetRoomTilingWarmReason>>();
    const addWarm = (
      participant: Participant | undefined,
      reason: MeetRoomTilingWarmReason,
    ) => {
      if (!participant || visibleSet.has(participant.userId)) return;
      warmById.set(participant.userId, participant);
      const reasons = reasonSets.get(participant.userId) ?? new Set();
      reasons.add(reason);
      reasonSets.set(participant.userId, reasons);
    };
    const boundaryWarmLimit = hasPresentation
      ? PRESENTATION_WARM_BUFFER_TILES
      : WARM_BUFFER_TILES;
    const recentlyVisibleWarmLimit = hasPresentation
      ? PRESENTATION_RECENTLY_VISIBLE_WARM_BUFFER_TILES
      : RECENTLY_VISIBLE_WARM_BUFFER_TILES;
    const priorityWarmLimit = hasPresentation
      ? PRESENTATION_PRIORITY_WARM_BUFFER_TILES
      : PRIORITY_WARM_BUFFER_TILES;

    overflowParticipants
      .slice(0, boundaryWarmLimit)
      .forEach((participant) => addWarm(participant, "boundary"));

    const now = performance.now();
    const recentlyVisibleWarmIds = new Set(
      Array.from(recentlyVisibleWarmIdsRef.current.entries())
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([id]) => id),
    );
    overflowParticipants
      .filter((participant) => recentlyVisibleWarmIds.has(participant.userId))
      .slice(0, recentlyVisibleWarmLimit)
      .forEach((participant) => addWarm(participant, "recently-visible"));

    if (activeSpeakerId) {
      addWarm(
        overflowParticipants.find(
          (participant) => participant.userId === activeSpeakerId,
        ),
        "active-speaker",
      );
    }

    if (featuredSpeakerId) {
      addWarm(
        overflowParticipants.find(
          (participant) => participant.userId === featuredSpeakerId,
        ),
        "featured-speaker",
      );
    }

    overflowParticipants
      .filter((participant) => participant.isHandRaised)
      .slice(0, priorityWarmLimit)
      .forEach((participant) => addWarm(participant, "hand-raised"));

    return {
      warmParticipants: Array.from(warmById.values()),
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
    hasPresentation,
    isOverflowOpen,
    overflowParticipants,
    recentlyVisibleWarmRevision,
    roomTilingRemoteVisibleIds,
  ]);
  const showOverflowTile = usesStageLayout
    ? showStageOverflowTile
    : hiddenParticipantsCount > 0 && !usesSpotlightLayout;
  const showOverflowTileInGrid =
    showOverflowTile && !isOverflowOpen && !usesStageLayout;
  const stageRailTileCount = usesStageLayout
    ? stageRailLayout.renderedTileCount
    : 0;
  const totalParticipants =
    visibleParticipants.length +
    gridReservedTiles +
    (showOverflowTileInGrid ? 1 : 0);
  const overflowPreviewParticipants = overflowParticipants.slice(0, 4);
  const roomTilingPrimaryIds = useMemo(() => {
    const ids: string[] = [];
    if (usesStageLayout && stageMainKind) {
      ids.push(
        stageMainKind === "presentation"
          ? PRESENTATION_TILE_ID
          : stageMainKind === "local"
            ? "local"
            : stageMainParticipantId ?? "",
      );
      roomTilingRemoteVisibleIds.forEach((userId) => ids.push(userId));
      if (
        stageMainKind !== "local" &&
        stageRailLocalTileCount > 0
      ) {
        ids.push("local");
      }
    } else {
      if (hasGridPresentationTile) ids.push(PRESENTATION_TILE_ID);
      if (shouldShowSelfAsTile) ids.push("local");
      visibleParticipants.forEach((participant) => ids.push(participant.userId));
      if (showOverflowTileInGrid) ids.push("overflow");
    }
    return Array.from(new Set(ids.filter(Boolean)));
  }, [
    currentUserId,
    hasGridPresentationTile,
    roomTilingRemoteVisibleIds,
    showOverflowTileInGrid,
    stageMainKind,
    stageMainParticipantId,
    stageRailLocalTileCount,
    usesStageLayout,
    visibleParticipants,
  ]);
  const roomTilingFocusIds = useMemo(() => {
    const ids: string[] = [];
    if (usesStageLayout && stageMainKind === "remote" && stageMainParticipantId) {
      ids.push(stageMainParticipantId);
    }
    if (activeSpeakerId) {
      ids.push(activeSpeakerId);
    }
    if (featuredSpeakerId) {
      ids.push(featuredSpeakerId);
    }
    return Array.from(new Set(ids.filter(Boolean)));
  }, [
    activeSpeakerId,
    featuredSpeakerId,
    stageMainKind,
    stageMainParticipantId,
    usesStageLayout,
  ]);
  const roomTilingHiddenIds = useMemo(
    () =>
      isOverflowOpen
        ? []
        : overflowParticipants.map((participant) => participant.userId),
    [isOverflowOpen, overflowParticipants],
  );
  const roomTilingWarmIds = useMemo(
    () => warmParticipants.map((participant) => participant.userId),
    [warmParticipants],
  );
  const roomTilingWarmReasons = useMemo(
    () =>
      Object.fromEntries(
        warmReasonById.entries(),
      ) as Record<string, MeetRoomTilingWarmReason[]>,
    [warmReasonById],
  );
  const roomTilingWarmReasonsJson = useMemo(
    () => JSON.stringify(roomTilingWarmReasons),
    [roomTilingWarmReasons],
  );
  const roomTilingScores = useMemo<MeetRoomTilingScore[]>(() => {
    const visibleSet = new Set(roomTilingRemoteVisibleIds);
    const hiddenSet = new Set(roomTilingHiddenIds);
    const warmSet = new Set(roomTilingWarmIds);
    return orderedRemoteParticipants.map((participant, index) => {
      const hasVideo = participantHasLiveVideo(participant);
      const hasAudio = participantHasLiveAudio(participant);
      const active = participant.userId === activeSpeakerId;
      const featured = participant.userId === featuredSpeakerId;
      const raised = Boolean(participant.isHandRaised);
      const visible = visibleSet.has(participant.userId);
      const hidden = hiddenSet.has(participant.userId);
      const warm = warmSet.has(participant.userId);
      const warmReasons = warmReasonById.get(participant.userId) ?? [];
      const score =
        (featured ? 100 : active ? 18 : 0) +
        (raised ? 35 : 0) +
        (hasVideo ? 24 : hasAudio ? 12 : 0) +
        (visible ? 8 : 0) +
        (warm ? 3 : 0) -
        (hidden ? 4 : 0);

      return {
        id: participant.userId,
        rank: index,
        score,
        active,
        featured,
        raised,
        video: hasVideo,
        audio: hasAudio,
        visible,
        hidden,
        warm,
        warmReasons,
      };
    });
  }, [
    activeSpeakerId,
    featuredSpeakerId,
    orderedRemoteParticipants,
    roomTilingHiddenIds,
    roomTilingRemoteVisibleIds,
    roomTilingWarmIds,
    warmReasonById,
  ]);
  const roomTilingScoresJson = useMemo(
    () => JSON.stringify(roomTilingScores),
    [roomTilingScores],
  );

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

  const gridUsableWidth = Math.max(0, gridSize.width - GRID_PADDING * 2);
  const gridUsableHeight = Math.max(0, gridSize.height - GRID_PADDING * 2);
  const isMobilePortraitGrid = isMobilePortrait(
    isMobile,
    gridUsableWidth,
    gridUsableHeight,
  );
  const usesVideoShapedTiles = usesAutoDynamicCrop && !isMobilePortraitGrid;
  const tiledGridTileIds = useMemo(() => {
    if (usesStageLayout) return [];
    const ids: string[] = [];
    if (hasGridPresentationTile) ids.push(PRESENTATION_TILE_ID);
    if (shouldShowSelfAsTile) ids.push("local");
    visibleParticipants.forEach((participant) => ids.push(participant.userId));
    if (showOverflowTileInGrid) ids.push("overflow");
    return ids;
  }, [
    hasGridPresentationTile,
    shouldShowSelfAsTile,
    showOverflowTileInGrid,
    usesStageLayout,
    visibleParticipants,
  ]);
  const tileAspects = useMemo(
    () =>
      usesVideoShapedTiles
        ? tiledGridTileIds.map((id) =>
            resolveTileAspect(
              videoAspectById.get(id) ?? null,
              fullVideoTileIds.has(id),
            ),
          )
        : undefined,
    [fullVideoTileIds, tiledGridTileIds, usesVideoShapedTiles, videoAspectById],
  );
  const layout = useMemo(() => {
    if (isMobilePortraitGrid) {
      return computeMobilePortraitGridLayout(
        totalParticipants,
        gridUsableWidth,
        gridUsableHeight,
        GRID_GAP,
        maxGridTiles,
      );
    }
    const { maxCols, targetAspect } = getGridPackingParams(
      isMobile,
      gridUsableWidth,
    );
    return computeGridLayout(totalParticipants, gridUsableWidth, gridUsableHeight, {
      gap: GRID_GAP,
      maxCols,
      maxTilesPerPage: maxGridTiles,
      targetAspect,
      tileAspects,
    });
  }, [
    totalParticipants,
    gridUsableWidth,
    gridUsableHeight,
    isMobilePortraitGrid,
    maxGridTiles,
    isMobile,
    tileAspects,
  ]);
  const tileStyle =
    layout.tileWidth > 0
      ? { width: layout.tileWidth, height: layout.tileHeight }
      : undefined;
  const tiledGridPositionById = useMemo(() => {
    const positions = new Map<string, GridTilePosition>();
    tiledGridTileIds.forEach((id, index) => {
      const position = layout.positions[index];
      if (position) positions.set(id, position);
    });
    return positions;
  }, [layout.positions, tiledGridTileIds]);
  const tiledGridTileStyleById = useMemo(() => {
    const styles = new Map<string, CSSProperties>();
    tiledGridPositionById.forEach((position, id) => {
      styles.set(id, {
        left: GRID_PADDING + position.x,
        top: GRID_PADDING + position.y,
        width: position.width,
        height: position.height,
      });
    });
    return styles;
  }, [tiledGridPositionById]);
  const gridTilePlacements = useMemo(
    () =>
      Array.from(tiledGridPositionById, ([id, position]) => ({ ...position, id })),
    [tiledGridPositionById],
  );
  const getTiledGridTileStyle = useCallback(
    (id: string) => tiledGridTileStyleById.get(id) ?? tileStyle,
    [tileStyle, tiledGridTileStyleById],
  );
  const tileClass = layout.tileWidth > 0
    ? "absolute will-change-transform"
    : "relative h-full w-full will-change-transform";
  const usesMobileScrollGrid = !usesStageLayout && isMobilePortraitGrid;
  const layoutSignature = `${renderedViewMode}-${layout.cols}x${layout.rows}-${layout.tileWidth}x${layout.tileHeight}-${layout.offsetX}x${layout.offsetY}-${gridSize.width}x${gridSize.height}`;
  const hasMeasuredGrid = gridSize.width > 0 && gridSize.height > 0;

  const localSpeakerHighlight = isLocalActiveSpeaker ? "speaking" : "";
  const localHandRaisedHighlight = isHandRaised ? "!border-amber-400/60" : "";
  const localGridVideoObjectFit = getGridVideoObjectFit("local");
  const isLocalFullVideoShown = fullVideoTileIds.has("local");
  const localFullVideoToggleLabel = isLocalFullVideoShown
    ? "Crop this video"
    : "Show the full video";
  const localTrackingObjectPosition =
    usesAutoDynamicCrop && !isLocalFullVideoShown
      ? localVideoTracking.objectPosition
      : null;
  const localVideoStyle: CSSProperties | undefined = localTrackingObjectPosition
    ? { objectPosition: localTrackingObjectPosition }
    : undefined;
  const showFloatingSelfView =
    !isLocalPinned &&
    stageMainKind !== "local" &&
    (effectiveSelfViewMode === "floating" ||
      (usesSpotlightLayout && shouldShowSelfAsTile));
  const showMinimizedSelfView =
    !isLocalPinned &&
    stageMainKind !== "local" &&
    effectiveSelfViewMode === "minimized";
  const actualSelfViewPlacement = stageMainKind === "local"
    ? "stage"
    : shouldShowSelfAsTile && !usesSpotlightLayout
      ? "tile"
      : showFloatingSelfView
        ? "floating"
        : showMinimizedSelfView
          ? "minimized"
          : "none";
  const roomTilingFallbackLevel = !hasMeasuredGrid
    ? 2
    : usesStageLayout &&
        !usesSpotlightLayout &&
        stageRailCandidateParticipants.length > 0 &&
        stageRailLayout.slotCount <= stageRailFixedTileCount
      ? 1
      : usesMeasuredAutoTileLimit && autoGridTileLimit < requestedMaxTiles
        ? 1
        : 0;
  const roomTilingSequenceRef = useRef(0);
  const roomTilingMetadataRef = useRef<MeetRoomTilingMetadata | null>(null);
  const roomTilingHistoryRef = useRef<MeetRoomTilingMetadata[]>([]);
  const lastPublishedRoomTilingSignatureRef = useRef<string | null>(null);
  const latestRoomTilingMetadataBaseRef =
    useRef<MeetRoomTilingMetadataBase | null>(null);
  const latestRoomTilingMetadataSignatureRef = useRef("");
  const roomTilingMetadataBase = useMemo<MeetRoomTilingMetadataBase>(
    () => ({
      source: "client",
      intervalMs: ROOM_TILING_METADATA_INTERVAL_MS,
      promoteDelayMs: ROOM_TILING_PROMOTE_DELAY_MS,
      minSwitchIntervalMs: ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
      activeSpeakerId,
      featuredSpeakerId,
      requestedMode: viewSettings.mode,
      renderedMode: renderedViewMode,
      effectiveMode: effectiveViewMode,
      autoStageMode,
      dynamicCrop: usesAutoDynamicCrop,
      presenting: hasPresentation,
      presentation: {
        tileId: PRESENTATION_TILE_ID,
        presenterId: presentationPresenterId,
        producerId: presentationProducerId,
        visible: isPresentationRendered,
        primary: presentationRenderedAsPrimary,
        focus: presentationRenderedAsPrimary,
      },
      pinnedId,
      primaryIds: roomTilingPrimaryIds,
      focusIds: roomTilingFocusIds,
      visibleRemoteIds: roomTilingRemoteVisibleIds,
      hiddenIds: roomTilingHiddenIds,
      warmIds: roomTilingWarmIds,
      warmReasons: roomTilingWarmReasons,
      fallbackLevel: roomTilingFallbackLevel,
      orderedRemoteIds: orderedRemoteParticipants.map(
        (participant) => participant.userId,
      ),
      scores: roomTilingScores,
      counts: {
        orderedRemote: orderedRemoteParticipants.length,
        visible: usesStageLayout
          ? stageSideParticipants.length
          : visibleParticipants.length,
        hidden: hiddenParticipantsCount,
        warm: warmParticipants.length,
        totalGrid: totalParticipants,
        stageRail: stageRailTileCount,
        maxTiles: maxGridTiles,
        requestedMaxTiles,
        autoTileLimit: autoGridTileLimit,
        recentlyVisibleWarm: Object.values(roomTilingWarmReasons).filter(
          (reasons) => reasons.includes("recently-visible"),
        ).length,
        priorityWarm: Object.values(roomTilingWarmReasons).filter((reasons) =>
          reasons.some(
            (reason) =>
              reason === "active-speaker" ||
              reason === "featured-speaker" ||
              reason === "hand-raised",
          ),
        ).length,
        handRaisedWarm: Object.values(roomTilingWarmReasons).filter((reasons) =>
          reasons.includes("hand-raised"),
        ).length,
        featuredSpeakerWarm: Object.values(roomTilingWarmReasons).filter(
          (reasons) => reasons.includes("featured-speaker"),
        ).length,
        stageRailCapacity: usesStageLayout ? stageRailLayout.slotCount : 0,
        stageRailRemoteCapacity: usesStageLayout
          ? stageRailLayout.remoteCapacity
          : 0,
      },
      stage: {
        mainKind: usesStageLayout ? stageMainKind ?? "none" : "none",
        candidateMainKind: stageMainKind ?? "none",
        mainParticipantId: usesStageLayout ? stageMainParticipantId : null,
        sideCompanionKind: usesSideBySideLayout
          ? sideBySideCompanionKind ?? "none"
          : "none",
        sideCompanionId:
          usesSideBySideLayout && sideBySideCompanionKind === "local"
            ? currentUserId
            : usesSideBySideLayout
              ? sideBySideCompanionParticipantId
              : null,
        sideBySide: usesSideBySideLayout,
        spotlight: usesSpotlightLayout,
      },
      selfView: {
        requested: requestedSelfViewMode,
        effective: effectiveSelfViewMode,
        placement: actualSelfViewPlacement,
        corner: requestedSelfViewCorner,
      },
      layout: {
        width: gridSize.width,
        height: gridSize.height,
        cols: layout.cols,
        rows: layout.rows,
        tileWidth: layout.tileWidth,
        tileHeight: layout.tileHeight,
        contentWidth: layout.contentWidth,
        contentHeight: layout.contentHeight,
        offsetX: layout.offsetX,
        offsetY: layout.offsetY,
        positions: gridTilePlacements,
        gridVideoFit: gridVideoObjectFit,
        fullVideoTileIds: fullVideoTileIdList,
      },
      localVideo: localVideoTracking,
    }),
    [
      activeSpeakerId,
      featuredSpeakerId,
      actualSelfViewPlacement,
      autoGridTileLimit,
      autoStageMode,
      currentUserId,
      effectiveSelfViewMode,
      effectiveViewMode,
      fullVideoTileIdList,
      gridSize.height,
      gridSize.width,
      gridVideoObjectFit,
      hasGridPresentationTile,
      hasPresentation,
      hiddenParticipantsCount,
      isPresentationRendered,
      gridTilePlacements,
      layout.cols,
      layout.contentHeight,
      layout.contentWidth,
      layout.offsetX,
      layout.offsetY,
      layout.rows,
      layout.tileHeight,
      layout.tileWidth,
      localVideoTracking,
      maxGridTiles,
      orderedRemoteParticipants,
      presentationPresenterId,
      presentationProducerId,
      presentationRenderedAsPrimary,
      pinnedId,
      renderedViewMode,
      requestedMaxTiles,
      requestedSelfViewCorner,
      requestedSelfViewMode,
      roomTilingHiddenIds,
      roomTilingFallbackLevel,
      roomTilingPrimaryIds,
      roomTilingFocusIds,
      roomTilingRemoteVisibleIds,
      roomTilingWarmReasons,
      roomTilingScores,
      roomTilingWarmIds,
      sideBySideCompanionKind,
      sideBySideCompanionParticipantId,
      stageRailLayout.remoteCapacity,
      stageRailLayout.slotCount,
      stageMainKind,
      stageMainParticipantId,
      stageRailTileCount,
      stageSideParticipants.length,
      totalParticipants,
      usesAutoDynamicCrop,
      usesSideBySideLayout,
      usesSpotlightLayout,
      usesStageLayout,
      viewSettings.mode,
      visibleParticipants.length,
      warmParticipants.length,
    ],
  );
  const roomTilingMetadataSignature = useMemo(
    () => JSON.stringify(roomTilingMetadataBase),
    [roomTilingMetadataBase],
  );

  useEffect(() => {
    latestRoomTilingMetadataBaseRef.current = roomTilingMetadataBase;
    latestRoomTilingMetadataSignatureRef.current = roomTilingMetadataSignature;
  }, [roomTilingMetadataBase, roomTilingMetadataSignature]);

  useEffect(() => {
    const getSnapshot = (): MeetRoomTilingDebugSnapshot => ({
      current: roomTilingMetadataRef.current,
      history: roomTilingHistoryRef.current,
      sequence: roomTilingSequenceRef.current,
      intervalMs: ROOM_TILING_METADATA_INTERVAL_MS,
    });
    const publish = ({
      force = false,
      heartbeat = false,
    }: {
      force?: boolean;
      heartbeat?: boolean;
    } = {}) => {
      const base = latestRoomTilingMetadataBaseRef.current;
      const signature = latestRoomTilingMetadataSignatureRef.current;
      if (!base || !signature) return;
      if (
        lastPublishedRoomTilingSignatureRef.current === signature &&
        !heartbeat &&
        (!force || roomTilingMetadataRef.current)
      ) {
        return;
      }

      const metadata: MeetRoomTilingMetadata = {
        ...base,
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
      lastPublishedRoomTilingSignatureRef.current = signature;
      window.__conclaveMeetRoomTilingDebug = getSnapshot();
      window.dispatchEvent(
        new CustomEvent("conclave:meet-room-tiling", { detail: metadata }),
      );
    };

    window.__conclaveGetMeetRoomTilingDebug = getSnapshot;
    publish({ force: true });
    const interval = window.setInterval(
      () => publish({ heartbeat: true }),
      ROOM_TILING_METADATA_INTERVAL_MS,
    );

    return () => {
      window.clearInterval(interval);
      if (window.__conclaveGetMeetRoomTilingDebug === getSnapshot) {
        delete window.__conclaveGetMeetRoomTilingDebug;
      }
      delete window.__conclaveMeetRoomTilingDebug;
    };
  }, []);
  const setSelfViewMode = useCallback(
    (selfViewMode: MeetSelfViewMode) => {
      onViewSettingsChange?.((current) => ({ ...current, selfViewMode }));
    },
    [onViewSettingsChange],
  );
  const setSelfViewCorner = useCallback(
    (selfViewCorner: MeetSelfViewCorner) => {
      onViewSettingsChange?.((current) => ({ ...current, selfViewCorner }));
    },
    [onViewSettingsChange],
  );
  const resolveSelfViewCornerFromPoint = useCallback(
    (clientX: number, clientY: number): MeetSelfViewCorner => {
      const rect = stageRootRef.current?.getBoundingClientRect();
      const midpointX = (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2;
      const midpointY = (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2;
      const vertical = clientY < midpointY ? "top" : "bottom";
      const horizontal = clientX < midpointX ? "left" : "right";
      return `${vertical}-${horizontal}` as MeetSelfViewCorner;
    },
    [],
  );
  const getSelfViewDragPoint = useCallback((clientX: number, clientY: number) => {
    const rect = stageRootRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: Math.min(Math.max(clientX - rect.left, 24), Math.max(24, rect.width - 24)),
      y: Math.min(Math.max(clientY - rect.top, 24), Math.max(24, rect.height - 24)),
    };
  }, []);
  const beginSelfViewDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!onViewSettingsChange) return;
      event.preventDefault();
      event.stopPropagation();
      setSelfViewDragPoint(
        getSelfViewDragPoint(event.clientX, event.clientY),
      );

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        setSelfViewDragPoint(
          getSelfViewDragPoint(pointerEvent.clientX, pointerEvent.clientY),
        );
      };
      const handlePointerEnd = (pointerEvent: PointerEvent) => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
        setSelfViewDragPoint(null);
        setSelfViewCorner(
          resolveSelfViewCornerFromPoint(
            pointerEvent.clientX,
            pointerEvent.clientY,
          ),
        );
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerEnd);
      window.addEventListener("pointercancel", handlePointerEnd);
    },
    [
      getSelfViewDragPoint,
      onViewSettingsChange,
      resolveSelfViewCornerFromPoint,
      setSelfViewCorner,
    ],
  );
  const selfViewCornerClass =
    requestedSelfViewCorner === "top-left"
      ? "left-4 top-4"
      : requestedSelfViewCorner === "top-right"
        ? "right-4 top-4"
        : requestedSelfViewCorner === "bottom-left"
          ? "bottom-4 left-4"
          : "bottom-4 right-4";
  const selfViewDragStyle = selfViewDragPoint
    ? {
        left: selfViewDragPoint.x,
        top: selfViewDragPoint.y,
        right: "auto",
        bottom: "auto",
        transform: "translate(-50%, -50%)",
      }
    : undefined;

  const flipSignature = tiledGridTileIds
    .map((id, index) => {
      const aspect = tileAspects?.[index] ?? GRID_TILE_ASPECT;
      return aspect === GRID_TILE_ASPECT ? id : `${id}@${aspect}`;
    })
    .join("~");
  const registerTile = useFlip(
    flipSignature,
    layoutSignature,
    hasMeasuredGrid,
    sidePanelReserve,
  );

  const tileRefCbs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const getTileRef = useCallback(
    (key: string) => {
      const cache = tileRefCbs.current;
      let cb = cache.get(key);
      if (!cb) {
        cb = (node: HTMLElement | null) => registerTile(key, node);
        cache.set(key, cb);
      }
      return cb;
    },
    [registerTile],
  );

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
    } catch {
      return;
    }
    inviteTimeoutRef.current = window.setTimeout(() => {
      setInviteStatus("idle");
    }, 2400);
  };

  return (
    <div
      ref={stageRootRef}
      className="relative flex flex-1 min-h-0 flex-col"
      style={{ fontFamily: FONT_SANS }}
    >
      <div
        className="pointer-events-none h-0 w-0 overflow-hidden"
        aria-hidden={true}
      >
        {allRemoteParticipants.map((participant) => (
          <ParticipantAudio
            key={`audio-${participant.userId}`}
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
            onAudioAutoplayBlocked={onAudioAutoplayBlocked}
            onAudioPlaybackStarted={onAudioPlaybackStarted}
            audioPlaybackAttemptToken={audioPlaybackAttemptToken}
          />
        ))}
      </div>

      <div
        ref={gridRef}
        data-meet-view-layout={usesStageLayout ? renderedViewMode : "tiled"}
        data-meet-view-requested={viewSettings.mode}
        data-meet-view-effective={renderedViewMode}
        data-meet-view-base-effective={effectiveViewMode}
        data-meet-view-pinned-spotlight={
          pinnedId && effectiveViewMode === "tiled" ? "true" : "false"
        }
        data-meet-view-dynamic-crop={
          usesAutoDynamicCrop ? "true" : "false"
        }
        data-meet-view-local-tracking={
          localVideoTracking.active ? "true" : "false"
        }
        data-meet-view-local-tracking-source={localVideoTracking.source}
        data-meet-view-local-crop-position={localTrackingObjectPosition ?? ""}
        data-meet-view-self-view-requested={requestedSelfViewMode}
        data-meet-view-self-view-effective={effectiveSelfViewMode}
        data-meet-view-self-view-placement={actualSelfViewPlacement}
        data-meet-view-self-view-corner={requestedSelfViewCorner}
        data-meet-view-self-view-tile={shouldShowSelfAsTile ? "true" : "false"}
        data-meet-view-floating-self-view={
          showFloatingSelfView ? "true" : "false"
        }
        data-meet-view-minimized-self-view={
          showMinimizedSelfView ? "true" : "false"
        }
        data-meet-view-grid-video-fit={gridVideoObjectFit}
        data-meet-view-full-video-tiles={fullVideoTileIdList.join(",")}
        data-meet-view-auto-mode={
          viewSettings.mode === "auto" ? autoStageMode : undefined
        }
        data-meet-view-presenting={hasPresentation ? "true" : "false"}
        data-meet-view-presentation-presenter={presentationPresenterId ?? ""}
        data-meet-view-grid-presentation={
          hasGridPresentationTile ? "true" : "false"
        }
        data-meet-view-stage-main-kind={
          usesStageLayout ? stageMainKind ?? "none" : "none"
        }
        data-meet-view-stage-candidate-kind={stageMainKind ?? "none"}
        data-meet-view-side-companion-kind={
          usesSideBySideLayout ? sideBySideCompanionKind ?? "none" : "none"
        }
        data-meet-view-side-companion={
          usesSideBySideLayout
            ? sideBySideCompanionKind === "local"
              ? currentUserId
              : sideBySideCompanionParticipant?.userId ?? "none"
            : "none"
        }
        data-meet-view-ordered-count={orderedRemoteParticipants.length}
        data-meet-view-visible-count={
          usesStageLayout
            ? stageSideParticipants.length
            : visibleParticipants.length
        }
        data-meet-view-hidden-count={hiddenParticipantsCount}
        data-meet-view-warm-count={warmParticipants.length}
        data-meet-view-grid-count={totalParticipants}
        data-meet-view-stage-rail-count={stageRailTileCount}
        data-meet-view-stage-rail-capacity={
          usesStageLayout ? stageRailLayout.slotCount : 0
        }
        data-meet-view-stage-rail-remote-capacity={
          usesStageLayout ? stageRailLayout.remoteCapacity : 0
        }
        data-meet-view-stage-rail-fixed-count={stageRailFixedTileCount}
        data-meet-view-stage-rail-overflow={
          showStageOverflowTile ? "true" : "false"
        }
        data-meet-view-max-tiles={maxGridTiles}
        data-meet-view-requested-max-tiles={requestedMaxTiles}
        data-meet-view-auto-tile-limit={autoGridTileLimit}
        data-meet-view-auto-tile-limit-active={
          usesMeasuredAutoTileLimit && autoGridTileLimit < requestedMaxTiles
            ? "true"
            : "false"
        }
        data-meet-view-auto-tile-min={
          `${AUTO_GRID_MIN_TILE_WIDTH}x${AUTO_GRID_MIN_TILE_HEIGHT}`
        }
        data-meet-view-grid-size={`${gridSize.width}x${gridSize.height}`}
        data-meet-view-hide-empty={
          viewSettings.hideTilesWithoutVideo ? "true" : "false"
        }
        data-meet-view-overflow-open={isOverflowOpen ? "true" : "false"}
        data-meet-view-overflow-tile={showOverflowTile ? "true" : "false"}
        data-meet-room-tiling-source="client"
        data-meet-room-tiling-metadata-interval={
          ROOM_TILING_METADATA_INTERVAL_MS
        }
        data-meet-room-tiling-promote-delay={ROOM_TILING_PROMOTE_DELAY_MS}
        data-meet-room-tiling-min-switch-interval={
          ROOM_TILING_MIN_SWITCH_INTERVAL_MS
        }
        data-meet-room-tiling-fallback-level={roomTilingFallbackLevel}
        data-meet-room-tiling-active-speaker={activeSpeakerId ?? ""}
        data-meet-room-tiling-featured-speaker={featuredSpeakerId ?? ""}
        data-meet-room-tiling-presentation-presenter={
          presentationPresenterId ?? ""
        }
        data-meet-room-tiling-primary-ids={roomTilingPrimaryIds.join(",")}
        data-meet-room-tiling-visible-ids={roomTilingRemoteVisibleIds.join(",")}
        data-meet-room-tiling-hidden-ids={roomTilingHiddenIds.join(",")}
        data-meet-room-tiling-warm-ids={roomTilingWarmIds.join(",")}
        data-meet-room-tiling-warm-hold={RECENTLY_VISIBLE_WARM_HOLD_MS}
        data-meet-room-tiling-warm-reasons={roomTilingWarmReasonsJson}
        data-meet-room-tiling-scores={roomTilingScoresJson}
        className={`relative flex flex-1 min-h-0 p-4 ${
          usesMobileScrollGrid
            ? "overflow-y-auto overflow-x-hidden"
            : "overflow-hidden"
        } ${
          usesStageLayout ? "flex-wrap content-center justify-center" : ""
        } ${
          hasMeasuredGrid ? "opacity-100" : "opacity-0"
        }`}
        style={{ gap: GRID_GAP }}
      >
        {usesSideBySideLayout && presentationStream ? (
          <div
            className="flex h-full w-full min-w-0 flex-col gap-3 sm:flex-row"
            data-meet-side-by-side
            data-meet-side-by-side-companion-kind={sideBySideCompanionKind}
            data-meet-side-by-side-companion={
              sideBySideCompanionKind === "local"
                ? currentUserId
                : sideBySideCompanionParticipant?.userId ?? "none"
            }
          >
            <div
              className="relative min-w-0 flex-1 sm:flex-[1.7]"
              data-meet-stage-main={PRESENTATION_TILE_ID}
            >
              <PresentationVideoTile
                stream={presentationStream}
                presenterName={presenterName}
                presenterId={presentationPresenterId}
                size="stage"
                selfView={presentationSelfView}
                captureControl={presentationCaptureControl}
                isPinned={pinnedId === PRESENTATION_TILE_ID}
                onTogglePin={() => togglePin(PRESENTATION_TILE_ID)}
              />
            </div>

            <div className="flex h-40 w-full shrink-0 flex-row gap-3 sm:h-auto sm:w-[min(32vw,28rem)] sm:min-w-[17rem] sm:max-w-[28rem] sm:flex-col">
              <div className="relative min-h-0 min-w-0 flex-[1.15]">
                {sideBySideCompanionKind === "local" ? (
                  <LocalVideoTile
                    stream={localStream}
                    isCameraOff={isCameraOff}
                    isMuted={isMuted}
                    isHandRaised={isHandRaised}
                    isMirrorCamera={isMirrorCamera}
                    displayName={localDisplayName}
                    userEmail={userEmail}
                    isActiveSpeaker={isLocalActiveSpeaker}
                    isPinned={isLocalPinned}
                    onTogglePin={toggleLocalPin}
                    tracking={localVideoTracking}
                    cropPosition={localTrackingObjectPosition}
                    size="stage"
                  />
                ) : sideBySideCompanionParticipant ? (
                  <ParticipantVideo
                    key={sideBySideCompanionParticipant.userId}
                    participant={sideBySideCompanionParticipant}
                    displayName={getDisplayName(
                      sideBySideCompanionParticipant.userId,
                    )}
                    isActiveSpeaker={
                      activeSpeakerId === sideBySideCompanionParticipant.userId
                    }
                    audioOutputDeviceId={audioOutputDeviceId}
                    disableAudio
                    isAdmin={isAdmin}
                    onAdminClick={onParticipantClick}
                    isPinned={
                      pinnedId === sideBySideCompanionParticipant.userId
                    }
                    onTogglePin={togglePin}
                    isFullVideoShown={fullVideoTileIds.has(
                      sideBySideCompanionParticipant.userId,
                    )}
                    onToggleFullVideo={toggleFullVideoTile}
                  />
                ) : null}
              </div>

              <div
                className="flex h-full min-w-0 flex-1 flex-row gap-3 overflow-x-auto pb-1 sm:h-auto sm:max-h-[35%] sm:min-h-[7rem] sm:flex-none sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:pb-0 sm:pr-1"
                data-meet-stage-rail
              >
                {shouldShowSelfAsTile && sideBySideCompanionKind !== "local" ? (
                  <div className="relative h-full w-28 shrink-0 sm:h-28 sm:w-auto">
                    <LocalVideoTile
                      stream={localStream}
                      isCameraOff={isCameraOff}
                      isMuted={isMuted}
                      isHandRaised={isHandRaised}
                      isMirrorCamera={isMirrorCamera}
                      displayName={localDisplayName}
                      userEmail={userEmail}
                      isActiveSpeaker={isLocalActiveSpeaker}
                      isPinned={isLocalPinned}
                      onTogglePin={toggleLocalPin}
                      tracking={localVideoTracking}
                      cropPosition={localTrackingObjectPosition}
                      size="rail"
                    />
                  </div>
                ) : null}

                {stageSideParticipants.map((participant) => (
                  <div
                    key={participant.userId}
                    className="relative h-full w-28 shrink-0 sm:h-28 sm:w-auto"
                    data-userid={participant.userId}
                  >
                    <ParticipantVideo
                      participant={participant}
                      displayName={getDisplayName(participant.userId)}
                      isActiveSpeaker={activeSpeakerId === participant.userId}
                      audioOutputDeviceId={audioOutputDeviceId}
                      disableAudio
                      isAdmin={isAdmin}
                      onAdminClick={onParticipantClick}
                      isPinned={pinnedId === participant.userId}
                      onTogglePin={togglePin}
                    />
                  </div>
                ))}

                {showOverflowTile ? (
                  <button
                    type="button"
                    onClick={() => setIsOverflowOpen((prev) => !prev)}
                    aria-expanded={isOverflowOpen}
                    aria-label={`Show ${hiddenParticipantsCount} more participants`}
                    title={`Show ${hiddenParticipantsCount} more participants`}
                    className="acm-video-tile group relative flex h-full w-28 shrink-0 flex-col items-center justify-center bg-[#131316] text-[#fafafa] transition-colors hover:border-[#fafafa]/15 sm:h-28 sm:w-auto"
                  >
                    <div className="absolute inset-2 grid grid-cols-2 grid-rows-2 gap-1 opacity-30 transition-opacity duration-200 group-hover:opacity-50">
                      {overflowPreviewParticipants.map((participant) => (
                        <OverflowPreviewTile
                          key={participant.userId}
                          participant={participant}
                          displayName={getDisplayName(participant.userId)}
                        />
                      ))}
                    </div>
                    <div className="relative z-10 flex flex-col items-center gap-2 px-4 text-center">
                      <span className="text-[24px] font-semibold leading-none text-[#fafafa]">
                        +{hiddenParticipantsCount}
                      </span>
                      <span className="flex items-center gap-1.5 rounded-full border border-[#fafafa]/12 bg-[#0a0a0b]/70 px-2.5 py-1 text-[12.5px] font-medium text-[#fafafa]/85 transition-colors group-hover:text-[#fafafa]">
                        <Users size={16} strokeWidth={1.75} />
                        Show all
                      </span>
                    </div>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : usesStageLayout && stageMainKind ? (
          <div className="flex h-full w-full min-w-0 flex-col gap-3 sm:flex-row">
            <div
              className="relative min-w-0 flex-1"
              data-meet-stage-main={
                stageMainKind === "presentation"
                  ? PRESENTATION_TILE_ID
                  : stageMainKind === "local"
                    ? currentUserId
                    : stageMainParticipant?.userId
              }
            >
              {stageMainKind === "presentation" && presentationStream ? (
                <PresentationVideoTile
                  stream={presentationStream}
                  presenterName={presenterName}
                  presenterId={presentationPresenterId}
                  size="stage"
                  selfView={presentationSelfView}
                  captureControl={presentationCaptureControl}
                  isPinned={pinnedId === PRESENTATION_TILE_ID}
                  onTogglePin={() => togglePin(PRESENTATION_TILE_ID)}
                />
              ) : stageMainKind === "local" ? (
                <LocalVideoTile
                  stream={localStream}
                  isCameraOff={isCameraOff}
                  isMuted={isMuted}
                  isHandRaised={isHandRaised}
                  isMirrorCamera={isMirrorCamera}
                  displayName={localDisplayName}
                  userEmail={userEmail}
                  isActiveSpeaker={isLocalActiveSpeaker}
                  isPinned={isLocalPinned}
                  onTogglePin={toggleLocalPin}
                  tracking={localVideoTracking}
                  videoObjectFit="contain"
                  size="stage"
                />
              ) : stageMainParticipant ? (
                <ParticipantVideo
                  key={stageMainParticipant.userId}
                  participant={stageMainParticipant}
                  displayName={getDisplayName(stageMainParticipant.userId)}
                  isActiveSpeaker={
                    activeSpeakerId === stageMainParticipant.userId
                  }
                  audioOutputDeviceId={audioOutputDeviceId}
                  disableAudio
                  videoObjectFit="contain"
                  isAdmin={isAdmin}
                  onAdminClick={onParticipantClick}
                  isPinned={pinnedId === stageMainParticipant.userId}
                  onTogglePin={togglePin}
                  isFullVideoShown={fullVideoTileIds.has(
                    stageMainParticipant.userId,
                  )}
                  onToggleFullVideo={toggleFullVideoTile}
                />
              ) : null}

            </div>

            {/* Omit an empty rail (for example two people with the self view
                detached) so the stage fills the space instead. */}
            {!usesSpotlightLayout && stageRailTileCount > 0 ? (
              <div
                className="flex h-32 w-full shrink-0 flex-row gap-3 overflow-x-auto pb-1 sm:h-auto sm:w-[min(22vw,15rem)] sm:min-w-[10rem] sm:max-w-[15rem] sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:pb-0 sm:pr-1"
                data-meet-stage-rail
              >
                {shouldShowSelfAsTile && stageMainKind !== "local" ? (
                  <div className="relative h-full w-28 shrink-0 sm:h-28 sm:w-auto">
                    <LocalVideoTile
                      stream={localStream}
                      isCameraOff={isCameraOff}
                      isMuted={isMuted}
                      isHandRaised={isHandRaised}
                      isMirrorCamera={isMirrorCamera}
                      displayName={localDisplayName}
                      userEmail={userEmail}
                      isActiveSpeaker={isLocalActiveSpeaker}
                      isPinned={isLocalPinned}
                      onTogglePin={toggleLocalPin}
                      tracking={localVideoTracking}
                      cropPosition={localTrackingObjectPosition}
                      size="rail"
                    />
                  </div>
                ) : null}

                {hasPresentation &&
                stageMainKind !== "presentation" &&
                presentationStream ? (
                  <div className="relative h-full w-28 shrink-0 sm:h-28 sm:w-auto">
                    <PresentationVideoTile
                      stream={presentationStream}
                      presenterName={presenterName}
                      presenterId={presentationPresenterId}
                      size="rail"
                      captureControl={presentationCaptureControl}
                      isPinned={pinnedId === PRESENTATION_TILE_ID}
                      onTogglePin={() => togglePin(PRESENTATION_TILE_ID)}
                    />
                  </div>
                ) : null}

                {stageSideParticipants.map((participant) => (
                  <div
                    key={participant.userId}
                    className="relative h-full w-28 shrink-0 sm:h-28 sm:w-auto"
                    data-userid={participant.userId}
                  >
                    <ParticipantVideo
                      participant={participant}
                      displayName={getDisplayName(participant.userId)}
                      isActiveSpeaker={activeSpeakerId === participant.userId}
                      audioOutputDeviceId={audioOutputDeviceId}
                      disableAudio
                      isAdmin={isAdmin}
                      onAdminClick={onParticipantClick}
                      isPinned={pinnedId === participant.userId}
                      onTogglePin={togglePin}
                    />
                  </div>
                ))}

                {showOverflowTile ? (
                  <button
                    type="button"
                    onClick={() => setIsOverflowOpen((prev) => !prev)}
                    aria-expanded={isOverflowOpen}
                    aria-label={`Show ${hiddenParticipantsCount} more participants`}
                    title={`Show ${hiddenParticipantsCount} more participants`}
                    className="acm-video-tile group relative flex h-full w-28 shrink-0 flex-col items-center justify-center bg-[#131316] text-[#fafafa] transition-colors hover:border-[#fafafa]/15 sm:h-28 sm:w-auto"
                  >
                    <div className="absolute inset-2 grid grid-cols-2 grid-rows-2 gap-1 opacity-30 transition-opacity duration-200 group-hover:opacity-50">
                      {overflowPreviewParticipants.map((participant) => (
                        <OverflowPreviewTile
                          key={participant.userId}
                          participant={participant}
                          displayName={getDisplayName(participant.userId)}
                        />
                      ))}
                    </div>
                    <div className="relative z-10 flex flex-col items-center gap-2 px-4 text-center">
                      <span className="text-[24px] font-semibold leading-none text-[#fafafa]">
                        +{hiddenParticipantsCount}
                      </span>
                      <span className="flex items-center gap-1.5 rounded-full border border-[#fafafa]/12 bg-[#0a0a0b]/70 px-2.5 py-1 text-[12.5px] font-medium text-[#fafafa]/85 transition-colors group-hover:text-[#fafafa]">
                        <Users size={16} strokeWidth={1.75} />
                        Show all
                      </span>
                    </div>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <>
        {hasGridPresentationTile && presentationStream ? (
          <div
            ref={getTileRef(PRESENTATION_TILE_ID)}
            className={tileClass}
            style={getTiledGridTileStyle(PRESENTATION_TILE_ID)}
          >
            <PresentationVideoTile
              stream={presentationStream}
              presenterName={presenterName}
              presenterId={presentationPresenterId}
              size="grid"
              selfView={presentationSelfView}
              captureControl={presentationCaptureControl}
              isPinned={pinnedId === PRESENTATION_TILE_ID}
              onTogglePin={() => togglePin(PRESENTATION_TILE_ID)}
            />
          </div>
        ) : null}

        {shouldShowSelfAsTile ? (
          <div
            ref={getTileRef("local")}
            className={tileClass}
            style={getTiledGridTileStyle("local")}
          >
            <div
              ref={localGridTileRef}
              className={`acm-video-tile group h-full w-full ${localSpeakerHighlight} ${localHandRaisedHighlight}`}
            >
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                data-meet-tile-video="true"
                data-video-object-fit={localGridVideoObjectFit}
                data-meet-local-tracking={
                  localVideoTracking.active ? "true" : "false"
                }
                data-meet-local-tracking-source={localVideoTracking.source}
                data-meet-local-crop-position={localTrackingObjectPosition ?? ""}
                style={localVideoStyle}
                className={`w-full h-full ${
                  localGridVideoObjectFit === "contain"
                    ? "object-contain bg-black"
                    : "object-cover"
                } ${
                  isCameraOff ? "hidden" : ""
                } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
              />
              {isCameraOff && (
                <div
                  data-meet-local-camera-placeholder="true"
                  className="absolute inset-0 flex items-center justify-center bg-[#18181b]"
                >
                  <div
                    style={
                      localTileChrome.avatarLift > 0
                        ? {
                            transform: `translateY(-${localTileChrome.avatarLift}px)`,
                          }
                        : undefined
                    }
                  >
                    <Avatar
                      className="text-3xl"
                      id={userEmail}
                      name={localDisplayName || userEmail}
                      size={localTileChrome.avatarSize}
                    />
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleLocalPin();
                }}
                className={`absolute inline-flex items-center justify-center rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
                  localTileChrome.dense
                    ? "right-1.5 top-1.5 h-7 w-7"
                    : "right-3 top-3 h-9 w-9"
                } ${
                  isLocalPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                title={isLocalPinned ? "Unpin" : "Pin to spotlight"}
                aria-label={isLocalPinned ? "Unpin" : "Pin to spotlight"}
                aria-pressed={isLocalPinned}
              >
                {isLocalPinned ? (
                  <PinOff size={localTileChrome.dense ? 14 : 18} strokeWidth={1.75} />
                ) : (
                  <Pin size={localTileChrome.dense ? 14 : 18} strokeWidth={1.75} />
                )}
              </button>
              {usesAutoDynamicCrop && !isCameraOff && hasLiveVideo(localStream) ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleFullVideoTile("local");
                  }}
                  data-meet-tile-crop-toggle="local"
                  data-meet-tile-crop-state={
                    isLocalFullVideoShown ? "full" : "cropped"
                  }
                  className={`absolute inline-flex items-center justify-center rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 opacity-0 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] group-hover:opacity-100 focus-visible:opacity-100 ${
                    localTileChrome.dense
                      ? "right-[2.5rem] top-1.5 h-7 w-7"
                      : "right-14 top-3 h-9 w-9"
                  }`}
                  title={localFullVideoToggleLabel}
                  aria-label={localFullVideoToggleLabel}
                  aria-pressed={isLocalFullVideoShown}
                >
                  {isLocalFullVideoShown ? (
                    <Crop size={localTileChrome.dense ? 14 : 18} strokeWidth={1.75} />
                  ) : (
                    <Maximize2 size={localTileChrome.dense ? 14 : 18} strokeWidth={1.75} />
                  )}
                </button>
              ) : null}
              {isHandRaised && (
                <div
                  className={`absolute flex items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300 ${
                    localTileChrome.dense
                      ? "left-1.5 top-1.5 h-6 w-6"
                      : "left-3 top-3 h-8 w-8"
                  }`}
                  title="Hand raised"
                  aria-label="Hand raised"
                >
                  <Hand size={localTileChrome.dense ? 14 : 18} strokeWidth={1.75} />
                </div>
              )}
              <div
                className={`absolute flex max-w-[80%] items-center rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 ${
                  localTileChrome.dense
                    ? "bottom-1.5 left-1.5 gap-1 px-2 py-0.5"
                    : "bottom-3 left-3 gap-1.5 px-3 py-1.5"
                }`}
              >
                <span
                  className={`truncate font-medium text-[#fafafa] ${
                    localTileChrome.dense ? "text-[10px]" : "text-[13px]"
                  }`}
                >
                  {localDisplayName}
                </span>
                <span
                  className={`font-medium text-[#F95F4A] ${
                    localTileChrome.dense ? "text-[9px]" : "text-[11px]"
                  }`}
                >
                  You
                </span>
                {isLocalActiveSpeaker && !isMuted ? (
                  <span className="acm-voice-activity" aria-label="Speaking">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : null}
                {isMuted && (
                  <MicOff
                    size={localTileChrome.dense ? 11 : 14}
                    strokeWidth={1.75}
                    className="shrink-0 text-[#F95F4A]"
                  />
                )}
              </div>
              {isSolo && (isMobile || !isCameraOff) ? (
              <button
                type="button"
                onClick={handleInvite}
                className={
                  "absolute z-10 flex items-center gap-2 rounded-full border border-[#fafafa]/14 bg-[#18181b]/90 px-3.5 py-2 text-[13px] font-medium text-[#fafafa] backdrop-blur transition-colors hover:bg-[#232327] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F95F4A]/40 " +
                  (isMobile
                    ? "left-1/2 top-3 -translate-x-1/2"
                    : "bottom-3 left-3")
                }
              >
                <UserPlus size={16} strokeWidth={1.75} className="text-[#F95F4A]" />
                {inviteStatus === "shared"
                  ? "Invite sent"
                  : inviteStatus === "copied"
                  ? "Link copied"
                  : "Invite people"}
              </button>
              ) : isSolo ? (
              <div className="absolute left-3 top-3 w-[19rem] max-w-[calc(100%-1.5rem)] rounded-xl border border-[#fafafa]/12 bg-[#18181b] p-4 text-[#fafafa]">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-[#fafafa]">
                    <Users size={18} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold leading-tight">
                      You are the only one here
                    </p>
                    <p className="mt-0.5 text-[12.5px] leading-snug text-[#fafafa]/66">
                      Invite people to join this room.
                    </p>
                  </div>
                </div>
                <div className="mt-3.5 flex gap-2">
                  <button
                    type="button"
                    onClick={handleInvite}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#F95F4A] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#fa6e5b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F95F4A]/40"
                  >
                    <UserPlus size={18} strokeWidth={1.75} />
                    {inviteStatus === "shared"
                      ? "Invite sent"
                      : inviteStatus === "copied"
                      ? "Link copied"
                      : "Invite people"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[#fafafa]/14 bg-transparent px-3 py-2 text-[13px] font-medium text-[#fafafa]/85 transition-colors hover:bg-white/[0.05] hover:text-[#fafafa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fafafa]/20"
                  >
                    <Link2 size={18} strokeWidth={1.75} />
                    {copyStatus === "copied" ? "Copied" : "Copy link"}
                  </button>
                </div>
              </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {visibleParticipants.map((participant) => (
          <div
            key={participant.userId}
            ref={getTileRef(participant.userId)}
            data-userid={participant.userId}
            className={tileClass}
            style={getTiledGridTileStyle(participant.userId)}
          >
            <ParticipantVideo
              participant={participant}
              displayName={getDisplayName(participant.userId)}
              isActiveSpeaker={activeSpeakerId === participant.userId}
              audioOutputDeviceId={audioOutputDeviceId}
              disableAudio
              isAdmin={isAdmin}
              onAdminClick={onParticipantClick}
              isPinned={pinnedId === participant.userId}
              onTogglePin={togglePin}
              videoObjectFit={getGridVideoObjectFit(participant.userId)}
              isDynamicCropEnabled={usesAutoDynamicCrop}
              isFullVideoShown={fullVideoTileIds.has(participant.userId)}
              onToggleFullVideo={toggleFullVideoTile}
              isTileShapedToVideo={usesVideoShapedTiles}
              onVideoAspectChange={getVideoAspectCallback(participant.userId)}
              tileWidth={
                tiledGridPositionById.get(participant.userId)?.width || undefined
              }
              tileHeight={
                tiledGridPositionById.get(participant.userId)?.height || undefined
              }
            />
          </div>
        ))}

        {showOverflowTileInGrid ? (
          <div
            key="overflow"
            ref={getTileRef("overflow")}
            className={tileClass}
            style={getTiledGridTileStyle("overflow")}
          >
            <button
              type="button"
              onClick={() => setIsOverflowOpen((prev) => !prev)}
              aria-expanded={isOverflowOpen}
              aria-label={`Show ${hiddenParticipantsCount} more participants`}
              title={`Show ${hiddenParticipantsCount} more participants`}
              className="acm-video-tile group relative flex h-full w-full flex-col items-center justify-center bg-[#131316] text-[#fafafa] transition-colors hover:border-[#fafafa]/15"
            >
              <div className="absolute inset-3 grid grid-cols-2 grid-rows-2 gap-1.5 opacity-30 transition-opacity duration-200 group-hover:opacity-50">
                {overflowPreviewParticipants.map((participant) => (
                  <OverflowPreviewTile
                    key={participant.userId}
                    participant={participant}
                    displayName={getDisplayName(participant.userId)}
                  />
                ))}
              </div>
              <div className="relative z-10 flex flex-col items-center gap-2 px-4 text-center">
                <span className="text-[28px] font-semibold leading-none text-[#fafafa]">
                  +{hiddenParticipantsCount}
                </span>
                <span className="flex items-center gap-1.5 rounded-full border border-[#fafafa]/12 bg-[#0a0a0b]/70 px-2.5 py-1 text-[12.5px] font-medium text-[#fafafa]/85 transition-colors group-hover:text-[#fafafa]">
                  <Users size={18} strokeWidth={1.75} />
                  Show all
                </span>
              </div>
            </button>
          </div>
        ) : null}

        {warmParticipants.map((participant) => (
          <div
            key={participant.userId}
            aria-hidden
            className="pointer-events-none absolute overflow-hidden opacity-0"
            style={{ ...(tileStyle ?? {}), left: -99999, top: 0 }}
          >
            <ParticipantVideo
              participant={participant}
              displayName={getDisplayName(participant.userId)}
              isActiveSpeaker={false}
              audioOutputDeviceId={audioOutputDeviceId}
              disableAudio
              isAdmin={isAdmin}
              isPinned={false}
              videoObjectFit={getGridVideoObjectFit(participant.userId)}
              tileWidth={layout.tileWidth || undefined}
              tileHeight={layout.tileHeight || undefined}
              onTogglePin={undefined}
            />
          </div>
        ))}
          </>
        )}
      </div>

      {showOverflowTile ? (
        <div
          className={`overflow-hidden transition-[max-height,opacity] duration-200 ease-out ${
            isOverflowOpen
              ? "mt-3 max-h-64 opacity-100 pointer-events-auto"
              : "mt-0 max-h-0 opacity-0 pointer-events-none"
          }`}
        >
          <div className="relative w-full overflow-hidden rounded-xl border border-[#fafafa]/10 bg-[#18181b]">
            <div className="flex items-center justify-between border-b border-[#fafafa]/10 px-4 py-3">
              <span className="flex items-center gap-2 text-[15px] font-semibold text-[#fafafa]">
                <Users size={18} strokeWidth={1.75} className="text-[#fafafa]/70" />
                More participants
                <span className="text-[13px] font-medium text-[#fafafa]/55">
                  {hiddenParticipantsCount}
                </span>
              </span>
              <div className="flex items-center gap-2">
                {onOpenParticipantsPanel ? (
                  <button
                    type="button"
                    onClick={() => {
                      setIsOverflowOpen(false);
                      onOpenParticipantsPanel();
                    }}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#fafafa]/70 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                  >
                    View all
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setIsOverflowOpen(false)}
                  className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#fafafa]/70 transition-colors hover:bg-white/[0.06] hover:text-[#fafafa]"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="relative">
              <div className="grid auto-cols-[11rem] grid-flow-col gap-3 overflow-x-scroll scroll-smooth snap-x snap-mandatory px-4 pb-4 pt-4 no-scrollbar">
                {isOverflowOpen &&
                  overflowParticipants.map((participant) => (
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
        </div>
      ) : null}

      {showFloatingSelfView ? (
        <div
          className={`group absolute z-20 w-[min(15rem,32vw)] min-w-[10rem] overflow-hidden rounded-2xl shadow-[0_16px_42px_rgba(0,0,0,0.38)] ${
            selfViewDragPoint ? "" : selfViewCornerClass
          }`}
          style={selfViewDragStyle}
          data-meet-floating-self-view="true"
          data-meet-detached-self-view="floating"
          data-meet-self-view-corner={requestedSelfViewCorner}
          data-meet-self-view-dragging={selfViewDragPoint ? "true" : "false"}
        >
          <LocalVideoTile
            stream={localStream}
            isCameraOff={isCameraOff}
            isMuted={isMuted}
            isHandRaised={isHandRaised}
            isMirrorCamera={isMirrorCamera}
            displayName={localDisplayName}
            userEmail={userEmail}
            isActiveSpeaker={isLocalActiveSpeaker}
            isPinned={isLocalPinned}
            onTogglePin={toggleLocalPin}
            tracking={localVideoTracking}
            cropPosition={localTrackingObjectPosition}
            size="rail"
          />
          <div className="absolute left-2 top-2 z-10 flex gap-1.5 opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onPointerDown={beginSelfViewDrag}
              aria-label="Move self-view"
              title="Move self-view"
              className="inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-full border border-[#fafafa]/12 bg-black/65 text-[#fafafa]/82 shadow-[0_8px_20px_rgba(0,0,0,0.3)] transition-colors hover:bg-black/80 hover:text-[#fafafa] active:cursor-grabbing"
            >
              <Move size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => setSelfViewMode("minimized")}
              aria-label="Minimize self-view"
              title="Minimize self-view"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#fafafa]/12 bg-black/65 text-[#fafafa]/82 shadow-[0_8px_20px_rgba(0,0,0,0.3)] transition-colors hover:bg-black/80 hover:text-[#fafafa]"
            >
              <Minimize2 size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ) : null}

      {showMinimizedSelfView ? (
        <MinimizedSelfViewPill
          displayName={localDisplayName}
          userEmail={userEmail}
          isMuted={isMuted}
          isHandRaised={isHandRaised}
          corner={requestedSelfViewCorner}
          cornerClass={selfViewCornerClass}
          dragStyle={selfViewDragStyle}
          isDragging={Boolean(selfViewDragPoint)}
          onDragStart={beginSelfViewDrag}
          onRestore={() => setSelfViewMode("floating")}
        />
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
  const cellRef = useRef<HTMLDivElement>(null);
  const cellSize = useElementSize(cellRef);
  const { avatarSize } = computeTileChrome(cellSize, {
    maxAvatar: 48,
    hasLabel: false,
  });
  return (
    <div
      ref={cellRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg border border-[#fafafa]/10 text-[13px] font-semibold text-white"
    >
      <Avatar id={participant.userId} name={displayName} size={avatarSize} />
    </div>
  );
});

const PresentationVideoTile = memo(function PresentationVideoTile({
  stream,
  presenterName,
  presenterId,
  size,
  selfView,
  captureControl,
  isPinned = false,
  onTogglePin,
}: {
  stream: MediaStream;
  presenterName: string;
  presenterId?: string | null;
  size: "stage" | "grid" | "rail";
  selfView?: {
    mode: SelfPresentationView;
    onModeChange: (mode: SelfPresentationView) => void;
  };
  captureControl?: {
    controller: CaptureControllerLike | null;
    state: CapturedSurfaceControlState;
  };
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wheelForwardTargetRef = useRef<HTMLDivElement>(null);
  const forwardedWheelElementRef = useRef<Element | null>(null);
  const wheelForwardPromiseRef = useRef<Promise<void> | null>(null);
  const videoTrack = stream.getVideoTracks()[0] ?? null;
  const compact = size === "rail";
  const showChooser = Boolean(selfView) && selfView?.mode !== "preview";
  const captureController = captureControl?.controller ?? null;
  const showCaptureControls = Boolean(
    captureController && captureControl?.state.available && !compact && !showChooser,
  );
  const [captureZoomLevel, setCaptureZoomLevel] = useState<number | null>(null);
  const [captureZoomLevels, setCaptureZoomLevels] = useState<number[]>([]);

  const syncCaptureZoom = useCallback(() => {
    setCaptureZoomLevel(readCapturedSurfaceZoomLevel(captureController));
    setCaptureZoomLevels(readCapturedSurfaceZoomLevels(captureController));
  }, [captureController]);

  useEffect(() => {
    if (!showCaptureControls || !captureController) {
      setCaptureZoomLevel(null);
      setCaptureZoomLevels([]);
      return;
    }

    syncCaptureZoom();
    captureController.addEventListener("zoomlevelchange", syncCaptureZoom);

    return () => {
      captureController.removeEventListener("zoomlevelchange", syncCaptureZoom);
    };
  }, [captureController, showCaptureControls, syncCaptureZoom]);

  const startForwardingWheel = useCallback(() => {
    const element = wheelForwardTargetRef.current;
    if (
      !showCaptureControls ||
      !captureController?.forwardWheel ||
      !element
    ) {
      return Promise.resolve();
    }
    if (forwardedWheelElementRef.current === element) {
      return Promise.resolve();
    }
    if (wheelForwardPromiseRef.current) {
      return wheelForwardPromiseRef.current;
    }

    const forwardPromise = captureController
      .forwardWheel(element)
      .then(() => {
        forwardedWheelElementRef.current = element;
      })
      .catch((error) => {
        console.warn("[Meets] Failed to enable captured tab scrolling:", error);
      })
      .finally(() => {
        wheelForwardPromiseRef.current = null;
      });

    wheelForwardPromiseRef.current = forwardPromise;
    return forwardPromise;
  }, [captureController, showCaptureControls]);

  useEffect(() => {
    if (!showCaptureControls || !captureController?.forwardWheel) return;

    void startForwardingWheel();

    return () => {
      forwardedWheelElementRef.current = null;
      wheelForwardPromiseRef.current = null;
      void captureController.forwardWheel?.(null).catch(() => {});
    };
  }, [captureController, showCaptureControls, startForwardingWheel]);

  const runCaptureZoomAction = useCallback(
    async (action?: () => Promise<void>) => {
      if (!action) return;
      try {
        await action();
      } catch (error) {
        console.warn("[Meets] Failed to update captured tab zoom:", error);
      } finally {
        syncCaptureZoom();
      }
    },
    [syncCaptureZoom],
  );

  const zoomMinimum = captureZoomLevels[0] ?? null;
  const zoomMaximum =
    captureZoomLevels.length > 0
      ? captureZoomLevels[captureZoomLevels.length - 1]
      : null;
  const canZoomOut =
    showCaptureControls &&
    (zoomMinimum === null ||
      captureZoomLevel === null ||
      captureZoomLevel > zoomMinimum);
  const canZoomIn =
    showCaptureControls &&
    (zoomMaximum === null ||
      captureZoomLevel === null ||
      captureZoomLevel < zoomMaximum);
  const captureZoomLabel =
    captureZoomLevel === null ? "Tab" : `${Math.round(captureZoomLevel)}%`;
  const captureControlButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-full text-[#fafafa]/82 transition-colors duration-100 hover:bg-white/[0.1] hover:text-[#fafafa] disabled:cursor-not-allowed disabled:text-[#fafafa]/28 disabled:hover:bg-transparent";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (showChooser) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    let cancelled = false;
    const playVideo = () => {
      if (cancelled) return;
      video.play().catch((err) => {
        if (errorName(err) === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
          return;
        }
        if (errorName(err) !== "AbortError") {
          console.error("[Meets] Presentation video play error:", err);
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
    const handleWindowChange = () => {
      scheduleReplay();
    };

    scheduleReplay();
    videoTrack?.addEventListener("unmute", scheduleReplay);
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    video.addEventListener("waiting", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowChange);
    window.addEventListener("pageshow", handleWindowChange);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("orientationchange", handleWindowChange);

    return () => {
      cancelled = true;
      videoTrack?.removeEventListener("unmute", scheduleReplay);
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      video.removeEventListener("waiting", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowChange);
      window.removeEventListener("pageshow", handleWindowChange);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("orientationchange", handleWindowChange);
      playbackRecovery.clear();
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [showChooser, stream, videoTrack]);

  return (
    <div
      ref={wheelForwardTargetRef}
      onWheelCapture={
        showCaptureControls ? () => void startForwardingWheel() : undefined
      }
      onPointerDownCapture={
        showCaptureControls ? () => void startForwardingWheel() : undefined
      }
      className={`acm-video-tile group relative flex overflow-hidden bg-[#131316] ${
        compact ? "h-28 shrink-0" : "h-full w-full"
      }`}
      data-meet-presentation-tile
      data-meet-presentation-presenter-id={presenterId ?? undefined}
      data-meet-presentation-size={size}
      data-meet-captured-surface-control={
        showCaptureControls ? "available" : "unavailable"
      }
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-meet-presentation-video="true"
        data-meet-video-stream-type="screen"
        className={`h-full w-full bg-black object-contain ${
          showChooser ? "opacity-0" : ""
        }`}
      />
      {showChooser && selfView && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#131316] p-4 text-center">
          <MonitorUp
            size={size === "stage" ? 32 : 22}
            strokeWidth={1.75}
            className="text-[#F95F4A]"
          />
          <p
            className={`font-medium text-[#fafafa] ${
              size === "stage" ? "text-[14px]" : "text-[11.5px]"
            }`}
          >
            You&rsquo;re sharing your screen
          </p>
          {size === "stage" && (
            <p className="max-w-[20rem] text-[12px] leading-snug text-[#fafafa]/56">
              Everyone in the call can already see it — this is just what you
              see on your end.
            </p>
          )}
          <button
            type="button"
            onClick={() => selfView.onModeChange("preview")}
            className={`mt-1 rounded-full border border-[#fafafa]/14 bg-[#18181b] font-medium text-[#fafafa]/82 transition-colors duration-100 hover:bg-[#232327] hover:text-[#fafafa] ${
              size === "stage"
                ? "px-4 py-2 text-[13px]"
                : "px-3 py-1.5 text-[11.5px]"
            }`}
          >
            Preview my screen
          </button>
        </div>
      )}
      {!showChooser && (
        <div
          className={`absolute flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 ${
            compact
              ? "bottom-2 left-2 px-2.5 py-1"
              : "left-3 top-3 px-3 py-1.5"
          }`}
        >
          <MonitorUp
            size={compact ? 15 : 18}
            strokeWidth={1.75}
            className="shrink-0 text-[#F95F4A]"
          />
          <span
            className={`truncate font-medium text-[#fafafa] ${
              compact ? "text-[12.5px]" : "text-[13px]"
            }`}
          >
            {compact ? "Presenting" : formatPresentingLabel(presenterName)}
          </span>
          {selfView && !compact && (
            <>
              <span className="h-3 w-px shrink-0 bg-[#fafafa]/14" />
              <button
                type="button"
                onClick={() => selfView.onModeChange("placeholder")}
                className="shrink-0 text-[12px] font-medium text-[#fafafa]/70 transition-colors duration-100 hover:text-[#fafafa]"
              >
                Hide preview
              </button>
            </>
          )}
        </div>
      )}
      {showCaptureControls && (
        <div
          className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-[#fafafa]/10 bg-black/65 p-1 shadow-[0_10px_24px_rgba(0,0,0,0.35)] backdrop-blur-md"
          data-meet-captured-surface-controls
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void runCaptureZoomAction(
                captureController?.decreaseZoomLevel?.bind(captureController),
              );
            }}
            className={captureControlButtonClass}
            title="Zoom out shared tab"
            aria-label="Zoom out shared tab"
            disabled={!canZoomOut}
          >
            <Minus size={16} strokeWidth={1.75} />
          </button>
          <span className="min-w-12 px-1 text-center text-[12px] font-medium tabular-nums text-[#fafafa]/78">
            {captureZoomLabel}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void runCaptureZoomAction(
                captureController?.increaseZoomLevel?.bind(captureController),
              );
            }}
            className={captureControlButtonClass}
            title="Zoom in shared tab"
            aria-label="Zoom in shared tab"
            disabled={!canZoomIn}
          >
            <Plus size={16} strokeWidth={1.75} />
          </button>
          <span className="mx-0.5 h-4 w-px bg-[#fafafa]/12" />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void runCaptureZoomAction(
                captureController?.resetZoomLevel?.bind(captureController),
              );
            }}
            className={captureControlButtonClass}
            title="Reset shared tab zoom"
            aria-label="Reset shared tab zoom"
          >
            <RotateCcw size={15} strokeWidth={1.75} />
          </button>
        </div>
      )}
      {onTogglePin && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          className={`absolute right-3 top-3 inline-flex items-center justify-center rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
            compact ? "h-7 w-7" : "h-9 w-9"
          } ${isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-pressed={isPinned}
        >
          {isPinned ? (
            <PinOff size={compact ? 14 : 18} strokeWidth={1.75} />
          ) : (
            <Pin size={compact ? 14 : 18} strokeWidth={1.75} />
          )}
        </button>
      )}
    </div>
  );
});

const LocalVideoTile = memo(function LocalVideoTile({
  stream,
  isCameraOff,
  isMuted,
  isHandRaised,
  isMirrorCamera,
  displayName,
  userEmail,
  isActiveSpeaker = false,
  isPinned = false,
  onTogglePin,
  tracking,
  cropPosition = null,
  videoObjectFit = "cover",
  size = "rail",
}: {
  stream: MediaStream | null;
  isCameraOff: boolean;
  isMuted: boolean;
  isHandRaised: boolean;
  isMirrorCamera: boolean;
  displayName: string;
  userEmail: string;
  isActiveSpeaker?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  tracking?: MeetLocalVideoTracking;
  cropPosition?: string | null;
  videoObjectFit?: "cover" | "contain";
  size?: "rail" | "stage";
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrack = stream?.getVideoTracks()[0] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!stream || isCameraOff) {
      if (video.srcObject) {
        video.srcObject = null;
      }
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    const playVideo = () => {
      video.play().catch(() => {});
    };

    playVideo();
    videoTrack?.addEventListener("unmute", playVideo);

    return () => {
      videoTrack?.removeEventListener("unmute", playVideo);
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [isCameraOff, stream, videoTrack]);

  const compact = size === "rail";
  const speakerHighlight = isActiveSpeaker ? "speaking" : "";
  const handRaisedHighlight = isHandRaised ? "!border-amber-400/60" : "";
  const videoStyle: CSSProperties | undefined = cropPosition
    ? { objectPosition: cropPosition }
    : undefined;

  return (
    <div
      className={`acm-video-tile group relative flex overflow-hidden bg-[#18181b] ${
        compact ? "h-28 shrink-0" : "h-full w-full"
      } ${speakerHighlight} ${handRaisedHighlight}`}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        data-meet-local-tracking={tracking?.active ? "true" : "false"}
        data-meet-local-tracking-source={tracking?.source ?? "none"}
        data-meet-local-crop-position={cropPosition ?? ""}
        style={videoStyle}
        className={`h-full w-full ${
          videoObjectFit === "contain" ? "object-contain bg-black" : "object-cover"
        } ${
          isCameraOff ? "hidden" : ""
        } ${isMirrorCamera ? "scale-x-[-1]" : ""}`}
      />
      {isCameraOff ? (
        <div
          data-meet-local-camera-placeholder="true"
          className="absolute inset-0 flex items-center justify-center bg-[#18181b]"
        >
          <Avatar
            className={compact ? "text-xl" : "text-3xl"}
            id={userEmail}
            name={displayName || userEmail}
            size={compact ? 48 : 80}
          />
        </div>
      ) : null}
      {isHandRaised ? (
        <div
          className={`absolute flex items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300 ${
            compact ? "left-2 top-2 h-7 w-7" : "left-3 top-3 h-8 w-8"
          }`}
          title="Hand raised"
          aria-label="Hand raised"
        >
          <Hand size={compact ? 16 : 18} strokeWidth={1.75} />
        </div>
      ) : null}
      {onTogglePin ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          className={`absolute rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
            compact ? "right-2 top-2 p-1.5" : "right-3 top-3 p-2"
          } ${isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          title={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-label={isPinned ? "Unpin" : "Pin to spotlight"}
          aria-pressed={isPinned}
        >
          {isPinned ? (
            <PinOff className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          ) : (
            <Pin className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          )}
        </button>
      ) : null}
      <div
        className={`absolute flex max-w-[85%] items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 ${
          compact ? "bottom-2 left-2 px-2.5 py-1" : "bottom-3 left-3 px-3 py-1.5"
        }`}
      >
        <span
          className={`truncate font-medium text-[#fafafa] ${
            compact ? "text-[12.5px]" : "text-[13px]"
          }`}
        >
          {truncateDisplayName(displayName, compact ? 18 : 24)}
        </span>
        <span className="text-[10.5px] font-medium text-[#F95F4A]">You</span>
        {isActiveSpeaker && !isMuted ? (
          <span className="acm-voice-activity" aria-label="Speaking">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {isMuted ? (
          <MicOff
            size={compact ? 13 : 14}
            strokeWidth={1.75}
            className="shrink-0 text-[#F95F4A]"
          />
        ) : null}
      </div>
      <GameTileOverlay compact={compact} />
    </div>
  );
});

const MinimizedSelfViewPill = memo(function MinimizedSelfViewPill({
  displayName,
  userEmail,
  isMuted,
  isHandRaised,
  corner,
  cornerClass,
  dragStyle,
  isDragging,
  onDragStart,
  onRestore,
}: {
  displayName: string;
  userEmail: string;
  isMuted: boolean;
  isHandRaised: boolean;
  corner: MeetSelfViewCorner;
  cornerClass: string;
  dragStyle?: CSSProperties;
  isDragging: boolean;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onRestore: () => void;
}) {
  return (
    <div
      className={`absolute z-20 flex max-w-[min(19rem,44vw)] items-center gap-2 rounded-full border border-[#fafafa]/12 bg-[#111114]/92 px-2.5 py-2 text-[#fafafa] shadow-[0_14px_36px_rgba(0,0,0,0.36)] ${
        isDragging ? "" : cornerClass
      }`}
      style={dragStyle}
      data-meet-minimized-self-view="true"
      data-meet-detached-self-view="minimized"
      data-meet-self-view-corner={corner}
      data-meet-self-view-dragging={isDragging ? "true" : "false"}
      aria-label="Minimized self-view"
    >
      <button
        type="button"
        onPointerDown={onDragStart}
        aria-label="Move minimized self-view"
        title="Move self-view"
        className="inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-full bg-white/[0.08] text-[#fafafa]/76 transition-colors hover:bg-white/[0.14] hover:text-[#fafafa] active:cursor-grabbing"
      >
        <Move size={14} strokeWidth={1.8} />
      </button>
      <Avatar id={userEmail} name={displayName || userEmail} size={32} />
      <span className="min-w-0 truncate text-[13px] font-medium">
        {truncateDisplayName(displayName, 20)}
      </span>
      <span className="text-[11px] font-medium text-[#F95F4A]">You</span>
      {isMuted ? (
        <MicOff size={14} strokeWidth={1.75} className="shrink-0 text-[#F95F4A]" />
      ) : null}
      {isHandRaised ? (
        <Hand size={14} strokeWidth={1.75} className="shrink-0 text-amber-300" />
      ) : null}
      <button
        type="button"
        onClick={onRestore}
        aria-label="Restore self-view"
        title="Restore self-view"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[#fafafa]/76 transition-colors hover:bg-white/[0.14] hover:text-[#fafafa]"
      >
        <Maximize2 size={14} strokeWidth={1.8} />
      </button>
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
  const videoStream = getRenderableParticipantVideoStream(participant);
  const isRenderingScreenShare = isRenderingParticipantScreenShare(
    participant,
    videoStream,
  );
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
    const stopPresentationObservation = observeRemoteVideoPresentation(
      video,
      videoStream,
    );

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
    const handleWindowChange = () => {
      scheduleReplay();
    };

    scheduleReplay();

    if (videoTrack) {
      videoTrack.addEventListener("unmute", scheduleReplay);
    }
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("orientationchange", handleWindowChange);

    return () => {
      cancelled = true;
      if (videoTrack) {
        videoTrack.removeEventListener("unmute", scheduleReplay);
      }
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("orientationchange", handleWindowChange);
      playbackRecovery.clear();
      stopPresentationObservation();
      if (video.srcObject === videoStream) {
        video.srcObject = null;
      }
    };
  }, [videoStream, videoTrack]);

  const showPlaceholder = !videoStream;
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
      className={`acm-video-tile group relative flex h-28 w-44 shrink-0 snap-start flex-col overflow-hidden text-left ${
        isActiveSpeaker ? "speaking" : ""
      } ${isClickable ? "cursor-pointer hover:border-[#F95F4A]/40" : "cursor-default opacity-85"}`}
      data-meet-video-adaptively-paused={
        participant.isVideoAdaptivelyPaused ? "true" : "false"
      }
    >
      <div className="relative h-full w-full">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          data-meet-tile-video="true"
          data-meet-video-stream-type={
            isRenderingScreenShare ? "screen" : "webcam"
          }
          className={`h-full w-full object-cover ${
            showPlaceholder ? "hidden" : ""
          } ${isReconnecting ? "opacity-75 saturate-90" : ""}`}
        />
        {showPlaceholder && (
          <div
            className={`absolute inset-0 flex items-center justify-center bg-[#18181b] ${
              isReconnecting ? "opacity-90" : ""
            }`}
          >
            <Avatar id={participant.userId} name={tileLabel} size={56} />
          </div>
        )}
        <ParticipantConnectionOverlay status={connectionStatus} compact />
        {participant.isHandRaised && (
          <div className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300">
            <Hand size={18} strokeWidth={1.75} />
          </div>
        )}
        <div className="absolute bottom-2 left-2 flex max-w-[85%] items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 px-2.5 py-1">
          <span className="truncate text-[12.5px] font-medium text-[#fafafa]">
            {tileLabel}
          </span>
          {participant.isMuted && (
            <MicOff size={14} strokeWidth={1.75} className="shrink-0 text-[#F95F4A]" />
          )}
        </div>
      </div>
    </button>
  );
});

export default memo(GridLayout);
