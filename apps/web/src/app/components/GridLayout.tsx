"use client";

import {
  Crop,
  Ghost,
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
import { getRenderableParticipantVideoStream } from "../lib/participant-media";
import { isRemoteParticipantVisible } from "../lib/participant-visibility";
import type { Participant } from "../lib/types";
import { isSystemUserId, truncateDisplayName } from "../lib/utils";
import {
  GhostParticipantOverlay,
  GHOST_ACCENT_CLASS,
} from "./GhostParticipantChrome";
import ParticipantAudio from "./ParticipantAudio";
import ParticipantConnectionOverlay from "./ParticipantConnectionOverlay";
import ParticipantVideo from "./ParticipantVideo";
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
  activeVideoEffectsCount?: number;
  isVideoFramingEnabled?: boolean;
  onToggleVideoFraming?: () => void;
  viewSettings?: MeetViewSettings;
  onViewSettingsChange?: Dispatch<SetStateAction<MeetViewSettings>>;
  presentationStream?: MediaStream | null;
  presenterName?: string;
  /** True when the presentation stream above is YOUR own screen share —
   *  the stage tile defaults to a chooser instead of mirroring it back. */
  isLocalPresenter?: boolean;
  screenShareControlState?: CapturedSurfaceControlState;
  screenShareCaptureController?: CaptureControllerLike | null;
  getDisplayName: (userId: string) => string;
  /** px the stage reserves on the right for a docked side panel (0 when none).
   *  Drives the one-shot reflow glide: when this changes, the grid re-measures
   *  synchronously and FLIPs every tile to its new size/position. */
  sidePanelReserve?: number;
  /** Phone-width layout: stage-rail layouts (side-by-side, sidebar) stack
   * vertically and the companion/thumbnail rail becomes a horizontal strip
   * instead of a fixed-width side column. */
  isMobile?: boolean;
}

// Keep this many just-past-the-cutoff participants' <video> mounted (hidden but
// still decoding) as SIBLINGS of the visible grid tiles. When the active-speaker
// sort promotes one of them across the overflow boundary, React reconciles it by
// key within the same parent — the tile REPOSITIONS in place instead of
// unmount+remounting, so the decoder isn't reset and the tile doesn't black-flash.
const WARM_BUFFER_TILES = 4;
const RECENTLY_VISIBLE_WARM_BUFFER_TILES = 4;
const RECENTLY_VISIBLE_WARM_HOLD_MS = 3500;
const PRIORITY_WARM_BUFFER_TILES = 4;
// Spacing of the measured stage. GRID_PADDING mirrors `p-4`; GRID_GAP is the
// inter-tile gap fed to the Meet packer so it reserves the same gutters we draw.
const GRID_PADDING = 16;
const GRID_GAP = 12;
const GRID_MAX_COLS = 6;
const STAGE_RAIL_TILE_HEIGHT = 112;
const SIDE_BY_SIDE_RAIL_HEIGHT_RATIO = 0.35;
const AUTO_GRID_MIN_TILE_WIDTH = 176;
const AUTO_GRID_MIN_TILE_HEIGHT = 99;
// On a portrait phone the desktop "fit everyone into the viewport" packer is the
// wrong model: with many people it either squashes tiles into short 16:9
// "capsules" (wasted height) or shrinks square tiles to nothing (wasted width).
// Phones instead get a fixed-size, vertically-SCROLLING 2-up gallery — the
// standard mobile video-call layout (Meet/Zoom). Tiles fill the column width,
// stay a usable size, and you scroll when there are more than fit. See
// computeMobilePortraitGridLayout below. A landscape phone keeps the 16:9
// packer but with a lower column cap.
const MOBILE_PORTRAIT_COLS = 2;
// Tiles are square by default; for small calls that fit on screen they grow
// taller (up to this width-multiple) to fill the viewport instead of leaving a
// gap below.
const MOBILE_PORTRAIT_MAX_TILE_ASPECT = 1.5; // height up to 1.5× width
const MOBILE_LANDSCAPE_MAX_COLS = 4;

/**
 * Device-/orientation-aware packing parameters for the desktop/landscape Meet
 * grid (the 16:9 optimal packer). Portrait phones bypass this entirely and use
 * computeMobilePortraitGridLayout instead.
 */
const getGridPackingParams = (isMobile: boolean) => ({
  maxCols: isMobile ? MOBILE_LANDSCAPE_MAX_COLS : GRID_MAX_COLS,
  targetAspect: 16 / 9,
  minTileWidth: AUTO_GRID_MIN_TILE_WIDTH,
  minTileHeight: AUTO_GRID_MIN_TILE_HEIGHT,
});

const isMobilePortrait = (isMobile: boolean, width: number, height: number) =>
  isMobile && height >= width;

/**
 * Fixed-size, vertically-scrolling 2-column gallery for portrait phones.
 *
 * Unlike the desktop packer (computeGridLayout), this does NOT shrink tiles to
 * cram everyone into the viewport. Each tile fills half the width; height is
 * square by default. When the whole grid fits with room to spare (small calls)
 * tiles grow taller to fill the screen; when it doesn't (many people) tiles keep
 * their size and the grid overflows so the container scrolls. Returns the same
 * GridLayoutResult shape the renderer/FLIP already consume.
 */
const computeMobilePortraitGridLayout = (
  count: number,
  width: number,
  height: number,
  gap: number,
  maxTilesPerPage: number,
): GridLayoutResult => {
  const total = Math.max(1, Math.floor(count));
  // Solo fills the whole stage (Meet/FaceTime self-view) instead of a centered
  // letterboxed tile with dead black space above and below.
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

  // Square by default; grow to fill the viewport height only if the whole grid
  // already fits, capped so tiles never become absurdly tall.
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
  // Center vertically when it fits; pin to the top when it overflows (scroll).
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
const ROOM_TILING_PROMOTE_DELAY_MS = 220;
const ROOM_TILING_MIN_SWITCH_INTERVAL_MS = 2200;
const FLIP_DURATION_MS = 220;
// Discrete side-panel reflow glides over the SAME duration/easing as the panel
// slide (meet-panel-in) so the stage and the panel move together.
const REFLOW_DURATION_MS = 280;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const FONT_SANS = "'PolySans Trial', system-ui, sans-serif";
const LOCAL_STAGE_ID = "__local__";
const PRESENTATION_TILE_ID = "__presentation__";

type EffectiveMeetViewMode = MeetViewMode | "sideBySide";
type ResolvedSelfViewMode = Exclude<MeetSelfViewMode, "auto">;
// "placeholder" = the flat "you're presenting" card (default); "preview" =
// an actual mirror of your share. This is a LOCAL-ONLY viewing choice — other
// participants can always see your share either way, regardless of this mode.
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

  // Portrait phones use a fixed-size scrolling gallery — tiles never shrink to
  // fit, so the cram-to-fit reduction doesn't apply. Show up to the requested
  // cap and let the rest spill into the overflow tile / scroll.
  if (isMobilePortrait(isMobile, usableWidth, usableHeight)) {
    return requestedMaxTiles;
  }

  const { maxCols, targetAspect, minTileWidth, minTileHeight } =
    getGridPackingParams(isMobile);

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

/**
 * No-dependency FLIP. Keeps every tile gliding smoothly (position AND size)
 * when the grid reflows — both from participant identity/order changes
 * (join/leave, active-speaker reorder) AND from a discrete side-panel toggle —
 * WITHOUT remounting the tiles or resizing the live <video> every frame.
 *
 * The whole point: a tile's LAYOUT box (width/height) is set to its FINAL value
 * exactly once (so the <video> surface layout-resizes once, never per frame),
 * and the visual delta is animated purely as a GPU-composited transform —
 * `translate3d(dx,dy,0) scale(sx,sy)` easing to identity, transform-origin 0 0.
 * Per codex/browser-engineering: transform-scaling a composited <video> is GPU
 * RESAMPLING of the already-decoded texture, NOT a per-frame re-raster — it does
 * not flicker. The flicker we saw earlier came from animating layout width/height
 * (the padding transition driving computeGridLayout every frame), not from scale.
 *
 * `reflowNonce` is a value that changes ONLY on a discrete reflow we want to
 * animate (a side-panel open/close). A continuous window-drag resize changes the
 * layout but NOT the nonce, so it just snaps (no per-frame transform thrash).
 */
function useFlip(
  flipKeys: string[],
  layoutSignature: string,
  enabled: boolean,
  reflowNonce: number,
) {
  const nodeMap = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const prevIdentitySignature = useRef<string | null>(null);
  const prevReflowNonce = useRef(reflowNonce);
  // Steady-state "first" rects captured the instant a panel toggle is detected,
  // held until the new layout settles (a frame later) so the glide starts from
  // the pre-reflow geometry, never the half-resized intermediate.
  const pendingReflowFirst = useRef<Map<string, DOMRect> | null>(null);
  const frameIds = useRef<number[]>([]);
  const signature = flipKeys.join("~");

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

    // One rect read per node — reused for the delta diff and the next snapshot.
    const next = new Map<string, DOMRect>();
    nodes.forEach((node, key) => next.set(key, node.getBoundingClientRect()));

    // --- discrete panel-toggle reflow: stash steady-state rects, defer play ---
    if (prevReflowNonce.current !== reflowNonce) {
      prevReflowNonce.current = reflowNonce;
      // The final tile sizes land in the NEXT (synchronous, pre-paint) commit —
      // capture the geometry from BEFORE the reflow now, and play once it lands.
      pendingReflowFirst.current = prevRects.current;
      prevRects.current = next;
      // If no size/position actually changes (e.g. height-constrained grid), the
      // settle commit never fires — drop the stale pending next frame.
      const dropId = requestAnimationFrame(() => {
        pendingReflowFirst.current = null;
      });
      frameIds.current.push(dropId);
      return cancelPendingFrames;
    }

    const identityChanged =
      prevIdentitySignature.current !== null &&
      prevIdentitySignature.current !== signature;

    // Pick the FLIP source: a settled panel reflow, or an identity/order change.
    let firstRects: Map<string, DOMRect> | null = null;
    let duration = FLIP_DURATION_MS;
    if (pendingReflowFirst.current) {
      // Prefer the steady-state pre-reflow rects even when identity ALSO changed
      // this commit (a join mid-reflow) — `prevRects` currently holds the
      // half-resized intermediate, which would make tiles glide from the wrong
      // start. New tiles (no pending rect) simply skip and appear in place.
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
        // Skip imperceptible deltas (sub-pixel jitter).
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
        // 1. Invert: place the tile at its OLD box via a GPU transform. Origin
        //    0 0 (top-left) — FLIP math requires it. translate THEN scale.
        node.style.transition = "none";
        node.style.transformOrigin = "0 0";
        node.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`;
        // 2. Play: next frame, ease the transform back to identity. Only the
        //    composited transform animates — the <video> layout box does not.
        const frameId = requestAnimationFrame(() => {
          node.style.transition = `transform ${duration}ms ${FLIP_EASING}`;
          node.style.transform = "translate3d(0, 0, 0) scale(1, 1)";
        });
        frameIds.current.push(frameId);
      });
    } else {
      // First paint / pure window resize / reduced motion: snap, no animation.
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
  activeVideoEffectsCount = 0,
  viewSettings = DEFAULT_MEET_VIEW_SETTINGS,
  onViewSettingsChange,
  presentationStream = null,
  presenterName = "Someone",
  isLocalPresenter = false,
  screenShareControlState,
  screenShareCaptureController = null,
  getDisplayName,
  sidePanelReserve = 0,
  isMobile = false,
}: GridLayoutProps) {
  const stageRootRef = useRef<HTMLDivElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
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
  const canRenderSelfView = !isGhost;
  const isLocalActiveSpeaker =
    canRenderSelfView && activeSpeakerId === currentUserId;
  const isLocalPinned = canRenderSelfView && pinnedId === LOCAL_STAGE_ID;
  const hasPresentation = hasLiveVideo(presentationStream);
  useEffect(() => {
    if (!isGhost) return;
    setPinnedId((current) => (current === LOCAL_STAGE_ID ? null : current));
    setFullVideoTileIds((current) => {
      if (!current.has("local")) return current;
      const next = new Set(current);
      next.delete("local");
      return next;
    });
  }, [isGhost]);
  // Default to the placeholder (not your own mirrored screen) each time a
  // new share session starts; reset happens the moment sharing stops so the
  // NEXT share starts fresh rather than carrying over the last choice.
  const [selfPresentationView, setSelfPresentationView] =
    useState<SelfPresentationView>("placeholder");
  useEffect(() => {
    if (!isLocalPresenter) {
      setSelfPresentationView("placeholder");
    } else if (screenShareControlState?.available) {
      setSelfPresentationView("preview");
    }
  }, [isLocalPresenter, screenShareControlState?.available]);
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

  // Memoize the filtered input so it only changes identity when `participants`
  // actually changes — otherwise a fresh array every render defeats
  // useSmartParticipantOrder's internal memoization (new sorted array each tick).
  const remoteInput = useMemo(
    () =>
      Array.from(participants.values()).filter(
        (participant) =>
          !isSystemUserId(participant.userId) &&
          participant.userId !== currentUserId &&
          isRemoteParticipantVisible(participant, isGhost, currentUserId) &&
          (!viewSettings.hideTilesWithoutVideo ||
            participantHasLiveVideo(participant) ||
            participant.userId === activeSpeakerId ||
            participant.userId === pinnedId)
      ),
    [
      activeSpeakerId,
      currentUserId,
      isGhost,
      participants,
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

  // Measure the stage so the Meet packer can size tiles to the actual viewport.
  // We track the border-box and subtract padding ourselves (one source of truth
  // with the rendered `p-4`), so initial sync measurement + observer agree.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Round to integers so sub-pixel ResizeObserver jitter never re-keys the
      // layout memo / FLIP signature (computeGridLayout floors anyway).
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

  // When a side panel toggles, the stage's reserved width changes INSTANTLY (the
  // pane's padding snaps). Re-measure SYNCHRONOUSLY here — in the same commit,
  // before the browser paints — so the tiles reach their final size this frame
  // (no half-resized intermediate flash) and the FLIP's first/last capture is
  // clean. The async ResizeObserver above would otherwise land a frame later.
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
  const orderedRemoteParticipants = useSmartParticipantOrder(
    remoteInput,
    activeSpeakerId,
    {
      promoteDelayMs: ROOM_TILING_PROMOTE_DELAY_MS,
      minSwitchIntervalMs: ROOM_TILING_MIN_SWITCH_INTERVAL_MS,
      minParticipantsForReorder: maxRemoteWithoutOverflow + 1,
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
  const hasOverflow = orderedRemoteParticipants.length > maxRemoteWithoutOverflow;
  const isSolo = orderedRemoteParticipants.length === 0 && !hasPresentation;
  const maxVisibleRemoteParticipants = hasOverflow
    ? isOverflowOpen
      ? maxRemoteWithoutOverflow
      : Math.max(0, maxGridTiles - gridReservedTiles - 1)
    : maxRemoteWithoutOverflow;
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
        if (err.name === "NotAllowedError") {
          video.muted = true;
          video.play().catch(() => {});
          return;
        }
        if (err.name !== "AbortError") {
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
  const stageRailPresentationTileCount =
    usesStageLayout &&
    !usesSpotlightLayout &&
    !usesSideBySideLayout &&
    hasPresentation &&
    stageMainKind !== "presentation"
      ? 1
      : 0;
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
    return Array.from(new Set(ids));
  }, [
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

  // The few hidden participants just past the visible cutoff that we keep warm
  // (mounted + decoding, but visually hidden) so they cross the boundary without
  // a remount. Empty while the overflow gallery is open — it already renders
  // every hidden participant, so warming them too would double-mount the tile.
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

    overflowParticipants
      .slice(0, WARM_BUFFER_TILES)
      .forEach((participant) => addWarm(participant, "boundary"));

    const now = performance.now();
    const recentlyVisibleWarmIds = new Set(
      Array.from(recentlyVisibleWarmIdsRef.current.entries())
        .filter(([, expiresAt]) => expiresAt > now)
        .map(([id]) => id),
    );
    overflowParticipants
      .filter((participant) => recentlyVisibleWarmIds.has(participant.userId))
      .slice(0, RECENTLY_VISIBLE_WARM_BUFFER_TILES)
      .forEach((participant) => addWarm(participant, "recently-visible"));

    // Also warm the active speaker even if they're hidden BEYOND the buffer —
    // useSmartParticipantOrder will promote them into the grid after the debounce
    // and we don't want that to mount a cold <video>.
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
      .slice(0, PRIORITY_WARM_BUFFER_TILES)
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
    () => overflowParticipants.map((participant) => participant.userId),
    [overflowParticipants],
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

  // Optimal-packing grid (shared @conclave/meeting-core engine — same logic web,
  // RN, and the Swift port use). Tiles are sized and placed exactly by the core
  // packer so every renderer gets the same centered rows and group offsets.
  const layout = useMemo(() => {
    const usableWidth = Math.max(0, gridSize.width - GRID_PADDING * 2);
    const usableHeight = Math.max(0, gridSize.height - GRID_PADDING * 2);
    if (isMobilePortrait(isMobile, usableWidth, usableHeight)) {
      return computeMobilePortraitGridLayout(
        totalParticipants,
        usableWidth,
        usableHeight,
        GRID_GAP,
        maxGridTiles,
      );
    }
    const { maxCols, targetAspect } = getGridPackingParams(isMobile);
    return computeGridLayout(totalParticipants, usableWidth, usableHeight, {
      gap: GRID_GAP,
      maxCols,
      maxTilesPerPage: maxGridTiles,
      targetAspect,
    });
  }, [totalParticipants, gridSize.width, gridSize.height, maxGridTiles, isMobile]);
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
  const tileStyle =
    layout.tileWidth > 0
      ? { width: layout.tileWidth, height: layout.tileHeight }
      : undefined;
  const tiledGridTileStyleById = useMemo(() => {
    const styles = new Map<string, CSSProperties>();
    tiledGridTileIds.forEach((id, index) => {
      const position = layout.positions[index];
      if (!position) return;
      styles.set(id, {
        left: GRID_PADDING + position.x,
        top: GRID_PADDING + position.y,
        width: position.width,
        height: position.height,
      });
    });
    return styles;
  }, [layout.positions, tiledGridTileIds]);
  const gridTilePlacements = useMemo(
    () =>
      tiledGridTileIds
        .map((id, index) => {
          const position = layout.positions[index];
          return position ? { ...position, id } : null;
        })
        .filter(
          (position): position is GridTilePosition & { id: string } =>
            position !== null,
        ),
    [layout.positions, tiledGridTileIds],
  );
  const getTiledGridTileStyle = useCallback(
    (id: string) => tiledGridTileStyleById.get(id) ?? tileStyle,
    [tileStyle, tiledGridTileStyleById],
  );
  const tileClass = layout.tileWidth > 0
    ? "absolute will-change-transform"
    : "relative h-full w-full will-change-transform";
  // Portrait-phone tiled view is a fixed-size, vertically-scrolling gallery
  // (see computeMobilePortraitGridLayout) — let the grid container scroll when
  // the tiles overflow instead of clipping them.
  const usesMobileScrollGrid =
    !usesStageLayout &&
    isMobilePortrait(
      isMobile,
      Math.max(0, gridSize.width - GRID_PADDING * 2),
      Math.max(0, gridSize.height - GRID_PADDING * 2),
    );
  // Include the measured stage size so a panel toggle that shifts tile POSITION
  // (the centered group re-centers) WITHOUT changing tile SIZE still re-runs the
  // FLIP effect on the settle commit — otherwise the pending reflow would be
  // dropped and the tiles would snap instead of glide.
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
      hasPresentation,
      hiddenParticipantsCount,
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

  // Stable FLIP keys, in render order. Identity/order changes animate; pure
  // layout size changes only refresh the FLIP snapshot, so panel/window resizes
  // never run every tile through a transform animation.
  const flipKeys = tiledGridTileIds;
  const registerTile = useFlip(
    flipKeys,
    layoutSignature,
    hasMeasuredGrid,
    sidePanelReserve,
  );

  // Stable per-key ref callbacks. Inline `ref={(node) => registerTile(key, node)}`
  // creates a NEW function every render, so React detaches+reattaches the ref
  // (registerTile(null) then registerTile(node)) on every grid re-render — pure
  // churn on the hot video-tile path. Caching one callback per key makes the ref
  // identity stable so React leaves it alone unless the node actually changes.
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
    } catch (error) {
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
        {orderedRemoteParticipants.map((participant) => (
          <ParticipantAudio
            key={`audio-${participant.userId}`}
            participant={participant}
            audioOutputDeviceId={audioOutputDeviceId}
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
                    isGhost={isGhost}
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
                    isSelected={
                      selectedParticipantId ===
                      sideBySideCompanionParticipant.userId
                    }
                    onAdminClick={onParticipantClick}
                    isPinned={
                      pinnedId === sideBySideCompanionParticipant.userId
                    }
                    onTogglePin={togglePin}
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
                      isGhost={isGhost}
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
                      isSelected={selectedParticipantId === participant.userId}
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
                  isGhost={isGhost}
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
                  isSelected={
                    selectedParticipantId === stageMainParticipant.userId
                  }
                  onAdminClick={onParticipantClick}
                  isPinned={pinnedId === stageMainParticipant.userId}
                  onTogglePin={togglePin}
                />
              ) : null}

            </div>

            {!usesSpotlightLayout ? (
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
                      isGhost={isGhost}
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
                      isSelected={selectedParticipantId === participant.userId}
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
              size="grid"
              selfView={presentationSelfView}
              captureControl={presentationCaptureControl}
              isPinned={pinnedId === PRESENTATION_TILE_ID}
              onTogglePin={() => togglePin(PRESENTATION_TILE_ID)}
            />
          </div>
        ) : null}

        {/* Local tile — wrapped in a stable FLIP node so the <video> never
            re-attaches when the grid reflows. */}
        {shouldShowSelfAsTile ? (
          <div
            ref={getTileRef("local")}
            className={tileClass}
            style={getTiledGridTileStyle("local")}
          >
            <div
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
                  <Avatar
                    className="text-3xl"
                    id={userEmail}
                    name={localDisplayName || userEmail}
                    size={80}
                  />
                </div>
              )}
              {isGhost && <GhostParticipantOverlay label="Ghost mode" />}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleLocalPin();
                }}
                className={`absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] focus-visible:opacity-100 ${
                  isLocalPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                title={isLocalPinned ? "Unpin" : "Pin to spotlight"}
                aria-label={isLocalPinned ? "Unpin" : "Pin to spotlight"}
                aria-pressed={isLocalPinned}
              >
                {isLocalPinned ? (
                  <PinOff size={18} strokeWidth={1.75} />
                ) : (
                  <Pin size={18} strokeWidth={1.75} />
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
                  className="absolute right-14 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#fafafa]/10 bg-black/60 text-[#fafafa]/82 opacity-0 transition-[border-color,color,opacity] duration-[120ms] hover:border-[#F95F4A]/40 hover:text-[#fafafa] group-hover:opacity-100 focus-visible:opacity-100"
                  title={localFullVideoToggleLabel}
                  aria-label={localFullVideoToggleLabel}
                  aria-pressed={isLocalFullVideoShown}
                >
                  {isLocalFullVideoShown ? (
                    <Crop size={18} strokeWidth={1.75} />
                  ) : (
                    <Maximize2 size={18} strokeWidth={1.75} />
                  )}
                </button>
              ) : null}
              {isHandRaised && (
                <div
                  className="absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 text-amber-300"
                  title="Hand raised"
                  aria-label="Hand raised"
                >
                  <Hand size={18} strokeWidth={1.75} />
                </div>
              )}
              <div className="absolute bottom-3 left-3 flex max-w-[80%] items-center gap-1.5 rounded-full border border-[#fafafa]/10 bg-[#0a0a0b]/70 px-3 py-1.5">
                <span className="truncate text-[13px] font-medium text-[#fafafa]">
                  {localDisplayName}
                </span>
                <span className="text-[11px] font-medium text-[#F95F4A]">You</span>
                {isLocalActiveSpeaker && !isMuted ? (
                  <span className="acm-voice-activity" aria-label="Speaking">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : null}
                {isMuted && (
                  <MicOff size={14} strokeWidth={1.75} className="shrink-0 text-[#F95F4A]" />
                )}
              </div>
              {isSolo && (isMobile || !isCameraOff) ? (
              // On mobile, or when the camera is on, don't cover the stage with
              // the full card — show a slim invite pill. Mobile pins it to the
              // top-center (clear of the bottom-left name plate); desktop keeps
              // it in the bottom-left corner next to the live self-view.
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
              isSelected={selectedParticipantId === participant.userId}
              onAdminClick={onParticipantClick}
              isPinned={pinnedId === participant.userId}
              onTogglePin={togglePin}
              videoObjectFit={getGridVideoObjectFit(participant.userId)}
              isDynamicCropEnabled={usesAutoDynamicCrop}
              isFullVideoShown={fullVideoTileIds.has(participant.userId)}
              onToggleFullVideo={toggleFullVideoTile}
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

        {/* Warm buffer — mounted but hidden (off-screen, still decoding) as
            SIBLINGS of the visible grid tiles. Stable key={userId} + same parent
            means a participant promoted across the overflow boundary by the
            active-speaker sort REPOSITIONS in place (React preserves the element
            by key) instead of unmount+remounting — no decoder reset / black
            flash. Skipped while the overflow gallery is open (it already renders
            every hidden tile). */}
        {warmParticipants.map((participant) => (
          <div
            key={participant.userId}
            aria-hidden
            className="pointer-events-none absolute overflow-hidden opacity-0"
            // Keep the warm wrapper at the SAME size it'll be in the grid (not
            // h-px w-px) — otherwise crossing the boundary forces a huge
            // compositor/video-layer resize from 1px → full tile. Just park it
            // far off-screen.
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
              // No interactive controls on a warm (off-screen, aria-hidden) tile
              // — passing onTogglePin would render a focusable pin button that a
              // keyboard / screen reader could still reach inside aria-hidden.
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
                {/* Only MOUNT the gallery <video>s while the tray is actually
                    open. The wrapper above merely collapses them with max-h-0,
                    so without this guard every hidden participant kept decoding
                    video while the tray was closed — wasteful and a duplicate of
                    the warm buffer. Cold-mounting on open is fine (explicit
                    user action); the warm buffer covers the grid boundary. */}
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
            isGhost={isGhost}
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
          isGhost={isGhost}
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
  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg border border-[#fafafa]/10 text-[13px] font-semibold text-white"
    >
      <Avatar id={participant.userId} name={displayName} size={48} />
    </div>
  );
});

const PresentationVideoTile = memo(function PresentationVideoTile({
  stream,
  presenterName,
  size,
  selfView,
  captureControl,
  isPinned = false,
  onTogglePin,
}: {
  stream: MediaStream;
  presenterName: string;
  size: "stage" | "grid" | "rail";
  /** Only set when this presentation IS your own screen share — lets the
   *  presenter choose between a flat "you're presenting" placeholder and an
   *  actual mirror of their share, right where the share would render. */
  selfView?: {
    mode: SelfPresentationView;
    onModeChange: (mode: SelfPresentationView) => void;
  };
  captureControl?: {
    controller: CaptureControllerLike | null;
    state: CapturedSurfaceControlState;
  };
  isPinned?: boolean;
  /** Pins/unpins the share to the main stage — same spotlight mechanism as
   *  participant tiles, so it works from a small grid/rail tile too. */
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

    if (video.srcObject !== stream) {
      video.srcObject = stream;
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

    scheduleReplay();
    videoTrack?.addEventListener("unmute", scheduleReplay);
    video.addEventListener("loadedmetadata", scheduleReplay);
    video.addEventListener("loadeddata", scheduleReplay);
    video.addEventListener("canplay", scheduleReplay);
    video.addEventListener("stalled", scheduleReplay);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      videoTrack?.removeEventListener("unmute", scheduleReplay);
      video.removeEventListener("loadedmetadata", scheduleReplay);
      video.removeEventListener("loadeddata", scheduleReplay);
      video.removeEventListener("canplay", scheduleReplay);
      video.removeEventListener("stalled", scheduleReplay);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      playbackRecovery.clear();
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream, videoTrack]);

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
  isGhost,
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
  isGhost: boolean;
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
      {isGhost ? <GhostParticipantOverlay compact /> : null}
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
    </div>
  );
});

const MinimizedSelfViewPill = memo(function MinimizedSelfViewPill({
  displayName,
  userEmail,
  isMuted,
  isHandRaised,
  isGhost,
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
  isGhost: boolean;
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
      {isGhost ? (
        <Ghost size={14} strokeWidth={1.75} className={`shrink-0 ${GHOST_ACCENT_CLASS}`} />
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
        {participant.isGhost && <GhostParticipantOverlay compact />}
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
