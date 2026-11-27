import { computeStageRailLayout } from "@conclave/meeting-core";
import { DEFAULT_MEET_VIEW_SETTINGS, type MeetSelfViewCorner } from "./meet-view";
import type { Participant } from "./types";
import {
  placeStageOverlay,
  type StageOverlayForm,
  type StageRect,
  type StageSurface,
} from "./stage-overlay";
import {
  COMPANION_RAIL,
  PARTICIPANT_RAIL,
  STAGE_GAP,
  chooseStageSplit,
  type StageSize,
  type StageSplit,
} from "./stage-split";

export const PRESENTATION_TILE_ID = "__presentation__";
export const LOCAL_TILE_ID = "local";
export const OVERFLOW_TILE_ID = "overflow";

type CameraTile =
  | { kind: "local" }
  | { kind: "remote"; participant: Participant };

export type MeetingStageTile = CameraTile | { kind: "presentation" };

export interface SelfViewRequest {
  mode: "tile" | "floating" | "minimized";
  corner: MeetSelfViewCorner;
}

export interface SelfViewPlacement {
  placement: "stage" | "tile" | "floating" | "minimized" | "none";
  corner: MeetSelfViewCorner;
  rect: StageRect | null;
}

export interface StageHints {
  visibleRemoteIds: string[];
  primaryIds: string[];
  hiddenIds: string[];
  presentation: { visible: boolean; primary: boolean };
}

export interface StagePlacement {
  selfView: SelfViewPlacement;
  hints: StageHints;
}

interface MeetingStageLayoutInput {
  size: StageSize;
  participants: readonly Participant[];
  preferredCamera: CameraTile | null;
  pinnedCamera: CameraTile | null;
  companionCamera: CameraTile | null;
  presenting: boolean;
  spotlight: boolean;
  selfView: SelfViewRequest;
  galleryOpen: boolean;
  maxTiles: number;
}

export const RAIL_TILE_SIZE = 112;
const RAIL_STACK_PADDING = 4;
const COMPANION_RAIL_INSET = 4;
const COMPANION_HEIGHT_RATIO = 0.35;
const COMPANION_STACK_WEIGHT = 1.15;
const COMPACT_PIN_MAX: StageSize = { width: 112, height: 72 };
const COMPACT_PIN_RATIO: StageSize = { width: 0.48, height: 0.6 };

const isMeasured = (size: StageSize) => size.width > 0 && size.height > 0;

const tileId = (tile: MeetingStageTile) =>
  tile.kind === "presentation"
    ? PRESENTATION_TILE_ID
    : tile.kind === "local"
      ? LOCAL_TILE_ID
      : tile.participant.userId;

const remoteIds = (tiles: readonly MeetingStageTile[]) =>
  tiles.flatMap((tile) => (tile.kind === "remote" ? [tile.participant.userId] : []));

function placeStageTiles(
  {
    size,
    participants,
    preferredCamera,
    pinnedCamera,
    companionCamera,
    presenting,
    spotlight,
    maxTiles,
  }: MeetingStageLayoutInput,
  tileSelfView: boolean,
) {
  const split = chooseStageSplit(size, companionCamera ? COMPANION_RAIL : PARTICIPANT_RAIL);
  const railAvailable = !spotlight && split.mode !== "main-only";
  const presentation = { kind: "presentation" } as const;
  const main = presenting && (!pinnedCamera || split.mode !== "side" || !railAvailable)
    ? presentation
    : pinnedCamera ?? preferredCamera;

  if (!main) return null;

  const companion = railAvailable ? companionCamera : null;
  const displacedPin = main.kind === "presentation" ? pinnedCamera : null;
  const requiredRailTile = railAvailable
    ? displacedPin ?? (presenting && main.kind !== "presentation" ? presentation : null)
    : null;
  const compactPin = railAvailable ? null : displacedPin;
  const placedTiles = [main, companion, requiredRailTile, compactPin];
  const placedRemoteIds = new Set(placedTiles.flatMap((tile) =>
    tile?.kind === "remote" ? [tile.participant.userId] : [],
  ));
  const candidates = participants.filter((participant) => !placedRemoteIds.has(participant.userId));
  const railLength = !railAvailable
    ? 0
    : split.mode === "stack"
      ? companion
        ? (size.width - STAGE_GAP) / (1 + COMPANION_STACK_WEIGHT)
        : size.width
      : companion
        ? size.height * COMPANION_HEIGHT_RATIO
        : size.height;
  const railBudget = Math.max(0, maxTiles - 1 - Number(Boolean(companion)));
  const requiredCount = Number(Boolean(requiredRailTile));
  const localInRail = railAvailable &&
    tileSelfView &&
    !placedTiles.some((tile) => tile?.kind === "local") &&
    railBudget > requiredCount &&
    (!isMeasured(size) || railLength >= RAIL_TILE_SIZE * (requiredCount + 1) + STAGE_GAP * requiredCount);
  const fixedCount = requiredCount + Number(localInRail);
  const capacity = computeStageRailLayout({
    candidateCount: candidates.length,
    fixedTileCount: fixedCount,
    maxTiles: railBudget,
    railHeight: railLength,
    tileHeight: RAIL_TILE_SIZE,
    gap: STAGE_GAP,
  });
  const rail: MeetingStageTile[] = [
    ...(requiredRailTile ? [requiredRailTile] : []),
    ...(localInRail ? [{ kind: "local" } as const] : []),
    ...candidates.slice(0, capacity.remoteCapacity).map((participant) => ({ kind: "remote" as const, participant })),
  ];
  const hiddenParticipants = candidates.slice(capacity.remoteCapacity);
  const tiles = [main, companion, ...rail, compactPin].filter((tile) => tile !== null);

  return {
    main,
    split,
    companion,
    rail,
    compactPin,
    tiles,
    hiddenParticipants,
    overflow: capacity.overflowTile,
    railSlots: capacity.slotCount,
    fixedRailCount: fixedCount,
    remoteRailCount: rail.filter((tile) => tile.kind === "remote").length,
  };
}

type PlacedStageTiles = NonNullable<ReturnType<typeof placeStageTiles>>;

export interface StageRects {
  main: StageRect;
  companion: StageRect | null;
  railBox: StageRect | null;
  rail: StageRect[];
  overflow: StageRect | null;
  compactPin: StageRect | null;
}

function measureStage(size: StageSize, placed: PlacedStageTiles): StageRects {
  const { split, companion, compactPin } = placed;
  const railTileCount = placed.rail.length + Number(placed.overflow);
  const hasSideSurface = split.mode !== "main-only" && (companion !== null || railTileCount > 0);
  const side = split.mode === "side";
  const main: StageRect = !hasSideSurface
    ? { x: 0, y: 0, ...size }
    : side
      ? { x: 0, y: 0, width: size.width - STAGE_GAP - split.railSize, height: size.height }
      : { x: 0, y: 0, width: size.width, height: size.height - STAGE_GAP - split.railSize };
  const sideBox: StageRect | null = !hasSideSurface
    ? null
    : side
      ? { x: size.width - split.railSize, y: 0, width: split.railSize, height: size.height }
      : { x: 0, y: size.height - split.railSize, width: size.width, height: split.railSize };
  const pinRect = compactPin
    ? {
        width: Math.min(COMPACT_PIN_MAX.width, main.width * COMPACT_PIN_RATIO.width),
        height: Math.min(COMPACT_PIN_MAX.height, main.height * COMPACT_PIN_RATIO.height),
      }
    : null;
  const rects: StageRects = {
    main,
    companion: null,
    railBox: null,
    rail: [],
    overflow: null,
    compactPin: pinRect && { x: 0, y: main.height - pinRect.height, ...pinRect },
  };
  if (!sideBox) return rects;

  const railRun = railTileCount * RAIL_TILE_SIZE + Math.max(0, railTileCount - 1) * STAGE_GAP;
  let railBox = sideBox;
  if (companion) {
    if (railTileCount === 0) {
      rects.companion = sideBox;
      return rects;
    }
    if (side) {
      const railHeight = Math.min(railRun, sideBox.height * COMPANION_HEIGHT_RATIO);
      rects.companion = { ...sideBox, height: sideBox.height - STAGE_GAP - railHeight };
      railBox = { ...sideBox, y: sideBox.y + sideBox.height - railHeight, height: railHeight };
    } else {
      const companionWidth =
        ((sideBox.width - STAGE_GAP) * COMPANION_STACK_WEIGHT) / (1 + COMPANION_STACK_WEIGHT);
      rects.companion = { ...sideBox, width: companionWidth };
      railBox = {
        ...sideBox,
        x: sideBox.x + companionWidth + STAGE_GAP,
        width: sideBox.width - STAGE_GAP - companionWidth,
      };
    }
  }
  rects.railBox = railBox;
  const tileRect = (index: number): StageRect =>
    side
      ? {
          x: railBox.x,
          y: railBox.y + index * (RAIL_TILE_SIZE + STAGE_GAP),
          width: railBox.width - (companion ? COMPANION_RAIL_INSET : 0),
          height: Math.min(RAIL_TILE_SIZE, railBox.height),
        }
      : {
          x: railBox.x + index * (RAIL_TILE_SIZE + STAGE_GAP),
          y: railBox.y,
          width: RAIL_TILE_SIZE,
          height: railBox.height - RAIL_STACK_PADDING,
        };
  rects.rail = placed.rail.map((_tile, index) => tileRect(index));
  rects.overflow = placed.overflow ? tileRect(placed.rail.length) : null;
  return rects;
}

function stageSurfaces(placed: PlacedStageTiles, rects: StageRects): StageSurface[] {
  const surface = (tile: MeetingStageTile, rect: StageRect): StageSurface => ({
    rect,
    cover: tile.kind === "presentation" ? "never" : "body",
  });
  return [
    surface(placed.main, rects.main),
    ...(placed.companion && rects.companion ? [surface(placed.companion, rects.companion)] : []),
    ...placed.rail.map((tile, index) => surface(tile, rects.rail[index])),
    ...(rects.overflow ? [{ rect: rects.overflow, cover: "body" } satisfies StageSurface] : []),
    ...(rects.compactPin ? [{ rect: rects.compactPin, cover: "never" } satisfies StageSurface] : []),
  ];
}

function placeDetachedSelfView(
  form: StageOverlayForm,
  { size, selfView }: Pick<MeetingStageLayoutInput, "size" | "selfView">,
  surfaces: readonly StageSurface[],
): SelfViewPlacement {
  if (!isMeasured(size)) return { placement: form, corner: selfView.corner, rect: null };
  const overlay = placeStageOverlay({ bounds: size, surfaces, corner: selfView.corner, form });
  return overlay
    ? { placement: form, ...overlay }
    : { placement: "none", corner: selfView.corner, rect: null };
}

export function resolveMeetingStageLayout(input: MeetingStageLayoutInput) {
  const { size, selfView, spotlight, galleryOpen } = input;
  const docked = placeStageTiles(input, selfView.mode === "tile");
  if (!docked) return null;

  const settle = (placed: PlacedStageTiles, self: SelfViewPlacement) => {
    const hidden = placed.hiddenParticipants.map((participant) => participant.userId);
    const galleryShown = galleryOpen && placed.overflow;
    const hints: StageHints = {
      visibleRemoteIds: [...remoteIds(placed.tiles), ...(galleryShown ? hidden : [])],
      primaryIds: placed.tiles
        .filter((tile) => tile.kind !== "presentation" || tile === placed.main)
        .map(tileId),
      hiddenIds: galleryShown ? [] : hidden,
      presentation: {
        visible: placed.tiles.some((tile) => tile.kind === "presentation"),
        primary: placed.main.kind === "presentation",
      },
    };
    return {
      arrangement: "stage" as const,
      ...placed,
      rects: measureStage(size, placed),
      selfView: self,
      hints,
    };
  };
  const fixed = (placement: SelfViewPlacement["placement"]): SelfViewPlacement => ({
    placement,
    corner: selfView.corner,
    rect: null,
  });

  if (docked.main.kind === "local") return settle(docked, fixed("stage"));
  if (docked.tiles.some((tile) => tile.kind === "local")) return settle(docked, fixed("tile"));

  const surfaces = stageSurfaces(docked, measureStage(size, docked));
  if (selfView.mode === "minimized") {
    return settle(docked, placeDetachedSelfView("minimized", input, surfaces));
  }
  if (selfView.mode === "tile" && !spotlight) return settle(docked, fixed("none"));

  const floating = placeDetachedSelfView("floating", input, surfaces);
  if (floating.placement === "floating") return settle(docked, floating);
  const railed = placeStageTiles(input, true);
  const takesFreeSlot =
    railed !== null &&
    railed.tiles.some((tile) => tile.kind === "local") &&
    railed.overflow === docked.overflow &&
    railed.hiddenParticipants.length === docked.hiddenParticipants.length;
  return takesFreeSlot ? settle(railed, fixed("tile")) : settle(docked, floating);
}

export type MeetingStageLayout = NonNullable<ReturnType<typeof resolveMeetingStageLayout>>;

export interface TiledGridTile {
  id: string;
  rect: StageRect | null;
}

export interface TiledGridPlacement extends StagePlacement {
  arrangement: "grid";
}

export function resolveTiledGridPlacement({
  size,
  tiles,
  hiddenIds,
  galleryOpen,
  selfView,
}: {
  size: StageSize;
  tiles: readonly TiledGridTile[];
  hiddenIds: readonly string[];
  galleryOpen: boolean;
  selfView: SelfViewRequest;
}): TiledGridPlacement {
  const ids = tiles.map((tile) => tile.id);
  const presenting = ids.includes(PRESENTATION_TILE_ID);
  const galleryShown = galleryOpen && hiddenIds.length > 0;
  const hints: StageHints = {
    visibleRemoteIds: [
      ...ids.filter((id) => id !== PRESENTATION_TILE_ID && id !== LOCAL_TILE_ID && id !== OVERFLOW_TILE_ID),
      ...(galleryShown ? hiddenIds : []),
    ],
    primaryIds: ids,
    hiddenIds: galleryShown ? [] : [...hiddenIds],
    presentation: { visible: presenting, primary: presenting },
  };
  if (ids.includes(LOCAL_TILE_ID) || selfView.mode === "tile") {
    return {
      arrangement: "grid",
      selfView: {
        placement: ids.includes(LOCAL_TILE_ID) ? "tile" : "none",
        corner: selfView.corner,
        rect: null,
      },
      hints,
    };
  }
  const surfaces = tiles.flatMap(({ id, rect }): StageSurface[] =>
    rect ? [{ rect, cover: id === PRESENTATION_TILE_ID ? "never" : "body" }] : [],
  );
  const measured = isMeasured(size) && surfaces.length === tiles.length;
  return {
    arrangement: "grid",
    selfView: placeDetachedSelfView(
      selfView.mode,
      { size: measured ? size : { width: 0, height: 0 }, selfView },
      surfaces,
    ),
    hints,
  };
}

export function resolveContentStagePlacement({
  size,
  participants,
  railAllowed,
  railWindow,
}: {
  size: StageSize | null;
  participants: readonly Participant[];
  railAllowed: boolean;
  railWindow: { first: number; last: number } | null;
}) {
  const split: StageSplit = railAllowed
    ? chooseStageSplit(size, PARTICIPANT_RAIL)
    : { mode: "main-only", railSize: 0 };
  const railShown = split.mode !== "main-only";
  const rail: CameraTile[] = railShown
    ? [{ kind: "local" }, ...participants.map((participant) => ({ kind: "remote" as const, participant }))]
    : [];
  const inView = rail.filter(
    (_tile, index) => !railWindow || (index >= railWindow.first && index <= railWindow.last),
  );
  const visibleRemoteIds = remoteIds(inView);
  return {
    arrangement: "content" as const,
    split,
    rail,
    selfView: {
      placement: railShown ? "tile" : "none",
      corner: DEFAULT_MEET_VIEW_SETTINGS.selfViewCorner,
      rect: null,
    } satisfies SelfViewPlacement,
    hints: {
      visibleRemoteIds,
      primaryIds: inView.map(tileId),
      hiddenIds: participants
        .map((participant) => participant.userId)
        .filter((id) => !visibleRemoteIds.includes(id)),
      presentation: { visible: false, primary: false },
    } satisfies StageHints,
  };
}

export type ContentStagePlacement = ReturnType<typeof resolveContentStagePlacement>;
