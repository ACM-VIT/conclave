import { computeStageRailLayout } from "@conclave/meeting-core";
import type { Participant } from "./types";
import {
  COMPANION_RAIL,
  PARTICIPANT_RAIL,
  STAGE_GAP,
  chooseStageSplit,
  type StageSize,
} from "./stage-split";

type CameraTile =
  | { kind: "local" }
  | { kind: "remote"; participant: Participant };

export type MeetingStageTile = CameraTile | { kind: "presentation" };

interface MeetingStageLayoutInput {
  size: StageSize;
  participants: readonly Participant[];
  preferredCamera: CameraTile | null;
  pinnedCamera: CameraTile | null;
  companionCamera: CameraTile | null;
  presenting: boolean;
  spotlight: boolean;
  tileSelfView: boolean;
  maxTiles: number;
}

const RAIL_TILE_SIZE = 112;
const COMPANION_HEIGHT_RATIO = 0.35;
const COMPANION_STACK_WEIGHT = 1.15;

export function resolveMeetingStageLayout({
  size,
  participants,
  preferredCamera,
  pinnedCamera,
  companionCamera,
  presenting,
  spotlight,
  tileSelfView,
  maxTiles,
}: MeetingStageLayoutInput) {
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
    railLength >= RAIL_TILE_SIZE * (requiredCount + 1) + STAGE_GAP * requiredCount;
  const fixedCount = requiredCount + Number(localInRail);
  const capacity = computeStageRailLayout({
    candidateCount: candidates.length,
    fixedTileCount: fixedCount,
    maxTiles: railBudget,
    railHeight: railLength,
    tileHeight: RAIL_TILE_SIZE,
    gap: STAGE_GAP,
  });
  const rail = [
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
