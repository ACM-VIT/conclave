import type { ScheduledMeeting } from "../../types.js";
import {
  emptyInviteeState,
  mergeInviteeState,
  removedInvitees,
  type InviteeState,
} from "./inviteeState.js";
import { meetingByRoomCode } from "./meetingCommands.js";
import { done, fail } from "./model.js";
import type { Command, Query, TxRead } from "./tx.js";

type MeetingRef = Pick<ScheduledMeeting, "id" | "clientId" | "roomCode" | "createdAt">;
type InvitationChange =
  | { kind: "fence"; generation: number; held?: number }
  | { kind: "decide"; email: string; removed: boolean; at: number; generation?: number }
  | { kind: "end"; at: number; generation?: number };

export type RoomBooking = {
  meeting: ScheduledMeeting;
  removed: string[];
};

const stateOf = (view: TxRead, meetingId: string): InviteeState =>
  view.get("inviteeState", meetingId)?.value ?? emptyInviteeState(meetingId);

export const roomBooking = (clientId: string, roomCode: string): Query<RoomBooking | null> => (view) => {
  const meeting = meetingByRoomCode(clientId, roomCode)(view);
  return meeting && { meeting, removed: removedInvitees(stateOf(view, meeting.id)) };
};

export const roomInviteeDecision = (clientId: string, roomCode: string, email: string): Query<{
  meeting: ScheduledMeeting;
  at: number | undefined;
} | null> => (view) => {
  const meeting = meetingByRoomCode(clientId, roomCode)(view);
  if (!meeting || !isInvitee(meeting, email)) return null;
  const decisions = stateOf(view, meeting.id).decisions;
  return { meeting, at: Object.hasOwn(decisions, email) ? decisions[email].at : undefined };
};

const isInvitee = (meeting: ScheduledMeeting, email: string): boolean =>
  email !== "" && (meeting.hostEmail === email || meeting.attendeeEmail === email);

export const bookingInvites = (booking: RoomBooking | null, email: string): boolean =>
  booking !== null &&
  booking.meeting.status !== "cancelled" &&
  !booking.removed.includes(email) &&
  isInvitee(booking.meeting, email);

export const updateRoomInvitation = (ref: MeetingRef, change: InvitationChange): Command<void> => (tx) => {
  const meeting = tx.get("meeting", ref.id)?.value;
  if (!meeting || meeting.clientId !== ref.clientId || meeting.roomCode !== ref.roomCode ||
      meeting.createdAt !== ref.createdAt || meetingByRoomCode(ref.clientId, ref.roomCode)(tx)?.id !== ref.id) {
    return change.kind === "fence" ? fail("conflict") : done(undefined);
  }
  const current = stateOf(tx, ref.id);
  const { generation } = change;
  if (generation !== undefined && current.generation !== null && current.generation > generation) {
    return fail("conflict");
  }
  if (change.kind === "fence" && change.held !== undefined &&
      current.generation !== null && current.generation !== change.held && current.generation !== generation) {
    return fail("conflict");
  }
  if (change.kind === "decide" && !isInvitee(meeting, change.email)) return done(undefined);
  const next = mergeInviteeState(current, {
    meetingId: ref.id,
    decisions: change.kind === "decide" ? { [change.email]: { removed: change.removed, at: change.at } } : {},
    endedAt: change.kind === "end" ? change.at : null,
    generation: generation ?? null,
  });
  if (change.kind !== "fence" || next.generation !== current.generation) tx.put("inviteeState", next);
  return done(undefined);
};
