import type { StageRect } from "./stage-overlay";
import {
  STAGE_GAP,
  STAGE_MAIN_MIN,
  chooseStageSplit,
  type StageRailSpec,
  type StageSize,
} from "./stage-split";

export type SoloInviteForm = "panel" | "notice";

export type SoloInviteArrangement = "beside" | "below" | "above";

export interface SoloInviteReservation {
  form: SoloInviteForm;
  arrangement: SoloInviteArrangement;
  tileBox: StageSize;
  slotSize: number;
}

export interface SoloInvitePlacement {
  form: SoloInviteForm;
  arrangement: SoloInviteArrangement;
  tile: StageRect;
  invite: StageRect;
}

export const INVITE_RAIL: StageRailSpec = {
  sideRatio: 0.3,
  sideMin: 288,
  sideMax: 352,
  stackMin: 184,
  stackMax: 184,
};

export const INVITE_PANEL_MIN_HEIGHT = 216;
export const INVITE_NOTICE_HEIGHT = 44;
const INVITE_BELOW_MIN_WIDTH = 288;

const isMeasured = (size: StageSize) => size.width > 0 && size.height > 0;

export function reserveSoloInvite(
  size: StageSize,
  form: SoloInviteForm,
): SoloInviteReservation | null {
  if (!isMeasured(size)) return null;
  if (form === "panel") {
    const split = chooseStageSplit(size, INVITE_RAIL);
    if (split.mode === "side" && size.height >= INVITE_PANEL_MIN_HEIGHT) {
      return {
        form,
        arrangement: "beside",
        tileBox: { width: size.width - STAGE_GAP - split.railSize, height: size.height },
        slotSize: split.railSize,
      };
    }
    if (split.mode === "stack") {
      return {
        form,
        arrangement: "below",
        tileBox: { width: size.width, height: size.height - STAGE_GAP - split.railSize },
        slotSize: split.railSize,
      };
    }
  }
  const tileHeight = size.height - STAGE_GAP - INVITE_NOTICE_HEIGHT;
  if (tileHeight < STAGE_MAIN_MIN.height) return null;
  return {
    form: "notice",
    arrangement: "above",
    tileBox: { width: size.width, height: tileHeight },
    slotSize: INVITE_NOTICE_HEIGHT,
  };
}

const centerOn = (start: number, length: number, span: number, bound: number) =>
  Math.min(Math.max(0, start + (length - span) / 2), Math.max(0, bound - span));

export function placeSoloInvite(
  size: StageSize,
  reservation: SoloInviteReservation,
  tileInBox: StageRect,
): SoloInvitePlacement {
  const { form, arrangement, slotSize } = reservation;
  if (arrangement === "beside") {
    const groupWidth = tileInBox.width + STAGE_GAP + slotSize;
    const x = Math.max(0, (size.width - groupWidth) / 2);
    const height = Math.min(size.height, Math.max(tileInBox.height, INVITE_PANEL_MIN_HEIGHT));
    return {
      form,
      arrangement,
      tile: { ...tileInBox, x },
      invite: {
        x: x + tileInBox.width + STAGE_GAP,
        y: centerOn(tileInBox.y, tileInBox.height, height, size.height),
        width: slotSize,
        height,
      },
    };
  }
  const groupHeight = tileInBox.height + STAGE_GAP + slotSize;
  const y = Math.max(0, (size.height - groupHeight) / 2);
  const width = arrangement === "below"
    ? Math.min(size.width, Math.max(tileInBox.width, INVITE_BELOW_MIN_WIDTH))
    : size.width;
  const invite: StageRect = {
    x: centerOn(tileInBox.x, tileInBox.width, width, size.width),
    y: arrangement === "below" ? y + tileInBox.height + STAGE_GAP : y,
    width,
    height: slotSize,
  };
  return {
    form,
    arrangement,
    tile: { ...tileInBox, y: arrangement === "below" ? y : y + slotSize + STAGE_GAP },
    invite,
  };
}
