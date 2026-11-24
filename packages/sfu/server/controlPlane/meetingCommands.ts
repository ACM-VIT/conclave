import type {
  CreateScheduledMeetingRequest,
  ScheduledMeeting,
  UpdateScheduledMeetingRequest,
} from "../../types.js";
import { clientIdCandidates } from "../clientIds.js";
import {
  advanceScheduledMeeting,
  applyScheduledMeetingUpdate,
  buildScheduledMeeting,
  filterScheduledMeetings,
  type CreateScheduledMeetingOptions,
  type ScheduledMeetingFilter,
} from "../scheduledMeetings.js";
import { done, fail, tags, uniqueKeys, type Outcome } from "./model.js";
import type { Command, Query, Tx, TxRead } from "./tx.js";

export type MeetingAccess = { email: string | null; isAdmin: boolean };

export const MEETING_NOT_FOUND = "Scheduled meeting not found";

const activeOwner =
  (view: TxRead) =>
  (clientId: string, roomCode: string): string | null =>
    view.owner("meetingCode", uniqueKeys.meetingCode(clientId, roomCode));

const meetingWithCode = (
  view: TxRead,
  clientId: string,
  roomCode: string,
): ScheduledMeeting | null => {
  const active = view.lookup("meeting", "meetingCode", uniqueKeys.meetingCode(clientId, roomCode));
  if (active) return active.value;
  const latest = view
    .tagged("meeting", tags.meetingCode(clientId, roomCode))
    .map((stored) => stored.value)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  return latest ?? null;
};

export const meetingById =
  (id: string): Query<ScheduledMeeting | null> =>
  (view) =>
    view.get("meeting", id)?.value ?? null;

export const meetingByRoomCode =
  (clientId: string, roomCode: string): Query<ScheduledMeeting | null> =>
  (view) => {
    for (const candidate of clientIdCandidates(clientId)) {
      const meeting = meetingWithCode(view, candidate, roomCode);
      if (meeting) return meeting;
    }
    return null;
  };

export const listMeetings =
  (filter: ScheduledMeetingFilter & { clientId: string }): Query<ScheduledMeeting[]> =>
  (view) => {
    const all = view.all("meeting").map((stored) => stored.value);
    const byId = new Map<string, ScheduledMeeting>();
    const seenRoomCodes = new Set<string>();
    for (const candidate of clientIdCandidates(filter.clientId)) {
      for (const meeting of filterScheduledMeetings(all, { ...filter, clientId: candidate })) {
        if (seenRoomCodes.has(meeting.roomCode)) continue;
        seenRoomCodes.add(meeting.roomCode);
        byId.set(meeting.id, meeting);
      }
    }
    return [...byId.values()].sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);
  };

export const allMeetings: Query<ScheduledMeeting[]> = (view) =>
  view.all("meeting").map((stored) => stored.value);

const withAccess = <T>(
  tx: Tx,
  id: string,
  access: MeetingAccess,
  run: (meeting: ScheduledMeeting) => Outcome<T>,
): Outcome<T> => {
  const current = tx.get("meeting", id);
  if (!current) return fail("not_found", MEETING_NOT_FOUND);
  if (!access.isAdmin && (!access.email || current.value.hostEmail !== access.email)) {
    return fail("forbidden", "Not authorized for this meeting");
  }
  return run(current.value);
};

export const meetingForHost =
  (id: string, access: MeetingAccess): Command<ScheduledMeeting> =>
  (tx) =>
    withAccess(tx, id, access, (meeting) => done(meeting));

export const createMeeting =
  (
    request: CreateScheduledMeetingRequest,
    options: CreateScheduledMeetingOptions,
  ): Command<ScheduledMeeting> =>
  (tx) => {
    const meeting = buildScheduledMeeting(request, options, {
      id: tx.entropy.uuid(),
      now: tx.now,
      random: tx.entropy.float,
      activeOwner: activeOwner(tx),
    });
    tx.put("meeting", meeting);
    return done(meeting);
  };

export const updateMeeting =
  (
    id: string,
    request: UpdateScheduledMeetingRequest,
    access: MeetingAccess,
  ): Command<ScheduledMeeting> =>
  (tx) =>
    withAccess(tx, id, access, (meeting) => {
      const next = applyScheduledMeetingUpdate(meeting, request, {
        now: tx.now,
        activeOwner: activeOwner(tx),
      });
      tx.put("meeting", next);
      return done(next);
    });

export const deleteMeeting =
  (id: string, access: MeetingAccess): Command<ScheduledMeeting> =>
  (tx) =>
    withAccess(tx, id, access, (meeting) => {
      tx.remove("meeting", id);
      return done(meeting);
    });

export const advanceMeetings: Command<ScheduledMeeting[]> = (tx) => {
  const changed: ScheduledMeeting[] = [];
  for (const stored of tx.tagged("meeting", tags.activeMeetings)) {
    const next = advanceScheduledMeeting(stored.value, tx.now);
    if (!next) continue;
    tx.put("meeting", next);
    changed.push(next);
  }
  return done(changed);
};
