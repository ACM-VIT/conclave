import type { StageRect } from "./stage-overlay";
import { STAGE_GAP, STAGE_MAIN_MIN, type StageSize } from "./stage-split";

export type SoloInviteForm = "panel" | "notice";

export type SoloInviteArrangement = "below" | "above";

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

const INVITE_PANEL_HEIGHT = 184;
const INVITE_NOTICE_HEIGHT = 44;
const INVITE_ROW_MIN_STAGE_WIDTH = 736;
const INVITE_ROW_MIN_STAGE_HEIGHT = 216;
const INVITE_BELOW_MIN_WIDTH = 288;

const isMeasured = (size: StageSize) => size.width > 0 && size.height > 0;

const reserve = (
  size: StageSize,
  form: SoloInviteForm,
  arrangement: SoloInviteArrangement,
  slotSize: number,
): SoloInviteReservation | null => {
  const tileHeight = size.height - STAGE_GAP - slotSize;
  if (tileHeight < STAGE_MAIN_MIN.height) return null;
  return { form, arrangement, tileBox: { width: size.width, height: tileHeight }, slotSize };
};

export function reserveSoloInvite(
  size: StageSize,
  form: SoloInviteForm,
): SoloInviteReservation | null {
  if (!isMeasured(size)) return null;
  if (form === "panel") {
    const below = size.width < INVITE_ROW_MIN_STAGE_WIDTH
      ? reserve(size, "panel", "below", INVITE_PANEL_HEIGHT)
      : size.height >= INVITE_ROW_MIN_STAGE_HEIGHT
        ? reserve(size, "notice", "below", INVITE_NOTICE_HEIGHT)
        : null;
    if (below) return below;
  }
  return reserve(size, "notice", "above", INVITE_NOTICE_HEIGHT);
}

const centerOn = (start: number, length: number, span: number, bound: number) =>
  Math.min(Math.max(0, start + (length - span) / 2), Math.max(0, bound - span));

export function placeSoloInvite(
  size: StageSize,
  reservation: SoloInviteReservation,
  tileInBox: StageRect,
): SoloInvitePlacement {
  const { form, arrangement, slotSize } = reservation;
  const below = arrangement === "below";
  const y = Math.max(0, (size.height - tileInBox.height - STAGE_GAP - slotSize) / 2);
  const width = below
    ? Math.min(size.width, Math.max(tileInBox.width, INVITE_BELOW_MIN_WIDTH))
    : size.width;
  return {
    form,
    arrangement,
    tile: { ...tileInBox, y: below ? y : y + slotSize + STAGE_GAP },
    invite: {
      x: centerOn(tileInBox.x, tileInBox.width, width, size.width),
      y: below ? y + tileInBox.height + STAGE_GAP : y,
      width,
      height: slotSize,
    },
  };
}
