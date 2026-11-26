import type { ScheduledMeeting } from "../../types.js";
import { defaultAppOrigin } from "../appOrigin.js";
import { isCalendarUsable } from "../scheduling.js";
import { done, fail, isActiveMeeting, tags, type CalendarTask, type Entropy } from "./model.js";
import type { Command, Query, Tx, TxRead } from "./tx.js";

export const CALENDAR_TASK_LEASE_MS = 60_000;

export const CALENDAR_TASK_RETRY_DELAYS_MS: readonly number[] = [
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  21_600_000,
];

export const CALENDAR_CHANGED = "Google Calendar was reconnected or disconnected meanwhile.";
export const CALENDAR_NOT_CONNECTED = "Google Calendar is not connected.";
export const BOOKING_MOVED = "The booking moved after its calendar event was created.";

const TASK_GONE = "This calendar task is finished or no longer exists.";
const NOT_DUE = "This calendar task is not due or another SFU is running it.";
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export const googleEventIdFrom = (entropy: Entropy): string => {
  const bytes = entropy.bytes(20);
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `cv${id}`;
};

export type CreateTaskInput = {
  meeting: ScheduledMeeting;
  profileId: string;
  grantId: string;
  appOrigin: string;
  timeZone: string;
  claimedForMs: number | null;
};

export const putCreateTask = (tx: Tx, input: CreateTaskInput): CalendarTask => {
  const task: CalendarTask = {
    id: googleEventIdFrom(tx.entropy),
    action: "create",
    state: "open",
    meetingId: input.meeting.id,
    profileId: input.profileId,
    grantId: input.grantId,
    eventId: "",
    startAt: input.meeting.scheduledStartAt,
    endAt: input.meeting.scheduledEndAt,
    appOrigin: input.appOrigin,
    timeZone: input.timeZone,
    attempts: input.claimedForMs === null ? 0 : 1,
    nextAttemptAt: tx.now + (input.claimedForMs ?? 0),
    lastError: null,
    createdAt: tx.now,
    updatedAt: tx.now,
  };
  task.eventId = task.id;
  tx.put("calendarTask", task);
  return task;
};

const toDelete = (tx: Tx, task: CalendarTask, awaitingCreate: boolean): CalendarTask => {
  const next: CalendarTask = {
    ...task,
    action: "delete",
    state: "open",
    awaitingCreate,
    attempts: 0,
    nextAttemptAt: tx.now,
    lastError: null,
    updatedAt: tx.now,
  };
  tx.put("calendarTask", next);
  return next;
};

const abandonCreate = (tx: Tx, task: CalendarTask): CalendarTask | null => {
  if (task.attempts > 1) return toDelete(tx, task, true);
  tx.remove("calendarTask", task.id);
  return null;
};

const profileOfBooking = (tx: TxRead, meeting: ScheduledMeeting): string | null => {
  const eventType = meeting.eventTypeId ? tx.get("eventType", meeting.eventTypeId)?.value : null;
  if (eventType) return eventType.profileId;
  const host = meeting.hostEmail.trim().toLowerCase();
  return (
    tx
      .all("profile")
      .map((stored) => stored.value)
      .find((profile) => profile.clientId === meeting.clientId && profile.email.trim().toLowerCase() === host)?.id ?? null
  );
};

export const retireMeetingEvent = (tx: Tx, meeting: ScheduledMeeting): CalendarTask | null => {
  const tracked = tx.tagged("calendarTask", tags.meetingCalendarTasks(meeting.id)).map(({ value }) => value)
    .find((task) => task.action === "create");
  if (tracked?.state === "failed") return toDelete(tx, tracked, true);
  if (tracked?.state === "linked") return toDelete(tx, tracked, false);
  if (tracked) return null;
  const eventId = meeting.googleCalendarEventId;
  if (!eventId) return null;
  const id = `delete-${eventId}`;
  const existing = tx.get("calendarTask", id)?.value ?? null;
  if (existing) return existing;
  const profileId = profileOfBooking(tx, meeting);
  if (!profileId) return null;
  const task: CalendarTask = {
    id,
    action: "delete",
    state: "open",
    meetingId: meeting.id,
    profileId,
    grantId: tx.get("calendar", profileId)?.value.grantId ?? "",
    eventId,
    startAt: meeting.scheduledStartAt,
    endAt: meeting.scheduledEndAt,
    appOrigin: "",
    timeZone: "UTC",
    attempts: 0,
    nextAttemptAt: tx.now,
    lastError: null,
    createdAt: tx.now,
    updatedAt: tx.now,
  };
  tx.put("calendarTask", task);
  return task;
};

export const restoreMeetingEvent = (tx: Tx, meeting: ScheduledMeeting): ScheduledMeeting => {
  if (!isActiveMeeting(meeting) || meeting.calendarSyncStatus === "not_required" || meeting.googleCalendarEventId) {
    return meeting;
  }
  const tracked = tx.tagged("calendarTask", tags.meetingCalendarTasks(meeting.id)).map(({ value }) => value);
  if (tracked.some((task) => task.action === "create")) return meeting;
  const profileId = profileOfBooking(tx, meeting);
  const profile = profileId ? tx.get("profile", profileId)?.value ?? null : null;
  const calendar = profile ? tx.get("calendar", profile.id)?.value ?? null : null;
  if (!profile || !isCalendarUsable(calendar)) {
    return { ...meeting, calendarSyncStatus: "failed", calendarSyncError: CALENDAR_NOT_CONNECTED };
  }
  putCreateTask(tx, {
    meeting,
    profileId: profile.id,
    grantId: calendar.grantId,
    appOrigin: tracked.find((task) => task.appOrigin)?.appOrigin ?? defaultAppOrigin(),
    timeZone: profile.timeZone,
    claimedForMs: null,
  });
  return { ...meeting, calendarSyncStatus: "pending", calendarSyncError: null };
};

const openTask = (tx: TxRead, id: string): CalendarTask | null => {
  const task = tx.get("calendarTask", id)?.value ?? null;
  return task && task.state === "open" ? task : null;
};

type CalendarAttempt = Pick<CalendarTask, "id" | "action" | "attempts">;

const heldAttempt = (tx: TxRead, attempt: CalendarAttempt): CalendarTask | null => {
  const task = openTask(tx, attempt.id);
  return task?.action === attempt.action && task.attempts === attempt.attempts ? task : null;
};

export const claimCalendarTask =
  (id: string, leaseMs: number): Command<CalendarTask> =>
  (tx) => {
    const task = openTask(tx, id);
    if (!task) return fail("not_found", TASK_GONE);
    if (task.nextAttemptAt > tx.now) return fail("conflict", NOT_DUE);
    const next: CalendarTask = { ...task, attempts: task.attempts + 1, nextAttemptAt: tx.now + leaseMs, updatedAt: tx.now };
    tx.put("calendarTask", next);
    return done(next);
  };

const createStillWanted = (tx: TxRead, task: CalendarTask): ScheduledMeeting | null => {
  const meeting = tx.get("meeting", task.meetingId)?.value ?? null;
  return meeting && meeting.status !== "cancelled" ? meeting : null;
};

export type CreateCheck =
  | { wanted: true; meeting: ScheduledMeeting }
  | { wanted: false; booking: ScheduledMeeting | null; removal: CalendarTask | null };

export const checkCalendarCreate =
  (attempt: CalendarAttempt): Command<CreateCheck> =>
  (tx) => {
    const task = heldAttempt(tx, attempt);
    if (!task || task.action !== "create") return fail("not_found", TASK_GONE);
    const meeting = createStillWanted(tx, task);
    if (meeting && tx.get("calendar", task.profileId)?.value.grantId === task.grantId) {
      return done({ wanted: true, meeting });
    }
    const booking = meeting ? failMeetingSync(tx, meeting, CALENDAR_CHANGED) : null;
    return done({ wanted: false, booking, removal: abandonCreate(tx, task) });
  };

export type CreateSettlement = { meeting: ScheduledMeeting | null; removal: CalendarTask | null };

export const settleCalendarCreate =
  (attempt: CalendarAttempt): Command<CreateSettlement> =>
  (tx) => {
    const task = heldAttempt(tx, attempt);
    if (!task || task.action !== "create") return fail("not_found", TASK_GONE);
    const meeting = createStillWanted(tx, task);
    if (!meeting) return done({ meeting: null, removal: toDelete(tx, task, false) });
    const grantHeld = tx.get("calendar", task.profileId)?.value.grantId === task.grantId;
    if (!grantHeld) {
      return done({ meeting: failMeetingSync(tx, meeting, CALENDAR_CHANGED), removal: toDelete(tx, task, false) });
    }
    const moved = meeting.scheduledStartAt !== task.startAt || meeting.scheduledEndAt !== task.endAt;
    const next: ScheduledMeeting = {
      ...meeting,
      googleCalendarEventId: task.eventId,
      calendarSyncStatus: moved ? "failed" : "synced",
      calendarSyncError: moved ? BOOKING_MOVED : null,
      updatedAt: tx.now,
    };
    tx.put("meeting", next);
    tx.put("calendarTask", { ...task, state: "linked", lastError: null, updatedAt: tx.now });
    return done({ meeting: next, removal: null });
  };

const failMeetingSync = (tx: Tx, meeting: ScheduledMeeting, message: string): ScheduledMeeting => {
  const next: ScheduledMeeting = {
    ...meeting,
    calendarSyncStatus: "failed",
    calendarSyncError: message.slice(0, 512),
    updatedAt: tx.now,
  };
  tx.put("meeting", next);
  return next;
};

export type Deferral = { task: CalendarTask; meeting: ScheduledMeeting | null; gaveUp: boolean };

export const deferCalendarTask =
  (attempt: CalendarAttempt, message: string, delays: readonly number[]): Command<Deferral> =>
  (tx) => {
    const task = heldAttempt(tx, attempt);
    if (!task) return fail("not_found", TASK_GONE);
    if (task.action === "create" && !createStillWanted(tx, task)) {
      return done({ task: toDelete(tx, task, true), meeting: null, gaveUp: false });
    }
    const error = message.slice(0, 512);
    const gaveUp = task.attempts > delays.length;
    const next: CalendarTask = gaveUp
      ? { ...task, state: "failed", lastError: error, updatedAt: tx.now }
      : { ...task, lastError: error, nextAttemptAt: tx.now + delays[task.attempts - 1], updatedAt: tx.now };
    tx.put("calendarTask", next);
    const meeting = task.action === "create" ? createStillWanted(tx, task) : null;
    if (!meeting) return done({ task: next, meeting: null, gaveUp });
    if (gaveUp) return done({ task: next, meeting: failMeetingSync(tx, meeting, error), gaveUp });
    const pending: ScheduledMeeting = { ...meeting, calendarSyncStatus: "pending", calendarSyncError: error, updatedAt: tx.now };
    tx.put("meeting", pending);
    return done({ task: next, meeting: pending, gaveUp });
  };

export const finishCalendarDelete =
  (attempt: CalendarAttempt): Command<CalendarTask> =>
  (tx) => {
    const task = heldAttempt(tx, attempt);
    if (!task || task.action !== "delete") return fail("not_found", TASK_GONE);
    tx.remove("calendarTask", task.id);
    return done(task);
  };

export const dueCalendarTasks: Query<CalendarTask[]> = (view) =>
  view
    .tagged("calendarTask", tags.openCalendarTasks)
    .map((stored) => stored.value)
    .filter((task) => task.nextAttemptAt <= view.now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

export const failedCalendarTasks: Query<CalendarTask[]> = (view) =>
  view.tagged("calendarTask", tags.failedCalendarTasks).map((stored) => stored.value);

export const calendarTaskById =
  (id: string): Query<CalendarTask | null> =>
  (view) =>
    view.get("calendarTask", id)?.value ?? null;
