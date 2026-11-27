import { Logger } from "../utilities/loggers.js";
import {
  CALENDAR_TASK_LEASE_MS,
  CALENDAR_TASK_RETRY_DELAYS_MS,
  CALENDAR_CHANGED,
  CALENDAR_NOT_CONNECTED,
  calendarTaskById,
  checkCalendarCreate,
  claimCalendarTask,
  deferCalendarTask,
  dueCalendarTasks,
  failedCalendarTasks,
  finishCalendarDelete,
  settleCalendarCreate,
  type CreateSettlement,
} from "./controlPlane/calendarTaskCommands.js";
import type { CalendarTask } from "./controlPlane/model.js";
import { hostCalendar } from "./controlPlane/schedulingCommands.js";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  GOOGLE_EVENT_DEADLINE_MS,
  refreshGoogleAccessToken,
} from "./googleCalendar.js";
import { isCalendarUsable } from "./scheduling.js";
import { buildSchedulingMeetingLink } from "./schedulingLinks.js";
import type { SfuState } from "./state.js";
import type { ScheduledMeeting } from "../types.js";

export type CalendarTaskOptions = { leaseMs?: number; retryDelaysMs?: readonly number[] };

export type CalendarTaskRun =
  | { booking: "gone" }
  | { booking: "kept"; meeting: ScheduledMeeting | null; error: string | null };

const CREATE_NOT_CONFIRMED = "Google did not find the event and a previous insert may still complete.";

const idle = (): CalendarTaskRun => ({ booking: "kept", meeting: null, error: null });
const gone = (): CalendarTaskRun => ({ booking: "gone" });
const kept = (meeting: ScheduledMeeting | null, error: string | null): CalendarTaskRun => ({ booking: "kept", meeting, error });
const syncErrorOf = (meeting: ScheduledMeeting): string | null =>
  meeting.calendarSyncStatus === "failed" ? meeting.calendarSyncError ?? null : null;

const messageOf = (error: unknown): string => (error instanceof Error && error.message) || "Google Calendar request failed.";

const finishCreateWork = async (
  state: SfuState,
  { meeting, removal, replacement }: CreateSettlement,
  options: CalendarTaskOptions,
): Promise<CalendarTaskRun> => {
  if (removal) await runCalendarTask(state, removal.id, options);
  if (replacement) return runCalendarTask(state, replacement.id, options);
  return meeting ? kept(meeting, syncErrorOf(meeting)) : gone();
};

const defer = async (
  state: SfuState,
  task: CalendarTask,
  message: string,
  options: CalendarTaskOptions,
): Promise<CalendarTaskRun> => {
  const deferred = await state.controlPlane.commit(
    deferCalendarTask(task, message, options.retryDelaysMs ?? CALENDAR_TASK_RETRY_DELAYS_MS),
  );
  if (!deferred.ok) return idle();
  if (deferred.value.task.action !== task.action) {
    return finishCreateWork(state, { ...deferred.value, removal: deferred.value.task }, options);
  }
  if (deferred.value.gaveUp) {
    Logger.error(
      `[ControlPlane] gave up on calendar task ${task.id} (${task.action} the event of booking ${task.meetingId}) after ${deferred.value.task.attempts} attempts: ${message}`,
    );
  }
  return kept(deferred.value.meeting, message);
};

const taskConnection = async (state: SfuState, task: CalendarTask) => {
  const connection = await state.controlPlane.read(hostCalendar(task.profileId));
  if (!isCalendarUsable(connection)) return { connection: null, error: CALENDAR_NOT_CONNECTED };
  if (connection.grantId !== task.grantId) return { connection: null, error: CALENDAR_CHANGED };
  return { connection, error: null };
};

const authorizeCreate = async (state: SfuState, task: CalendarTask, signal: AbortSignal) => {
  const target = await taskConnection(state, task);
  if (!target.connection) return target;
  try {
    const accessToken = await refreshGoogleAccessToken(state, target.connection, signal);
    return { ...target, accessToken };
  } catch (error) {
    return { connection: null, error: messageOf(error) };
  }
};

const runDelete = async (state: SfuState, task: CalendarTask, options: CalendarTaskOptions): Promise<CalendarTaskRun> => {
  const target = await taskConnection(state, task);
  if (!target.connection) return defer(state, task, target.error, options);
  let result: Awaited<ReturnType<typeof deleteGoogleCalendarEvent>>;
  try {
    result = await deleteGoogleCalendarEvent(state, target.connection, task.eventId);
  } catch (error) {
    return defer(state, task, messageOf(error), options);
  }
  if (result === "missing" && task.awaitingCreate) return defer(state, task, CREATE_NOT_CONFIRMED, options);
  await state.controlPlane.commit(finishCalendarDelete(task));
  return idle();
};

const runCreate = async (state: SfuState, task: CalendarTask, options: CalendarTaskOptions): Promise<CalendarTaskRun> => {
  const signal = AbortSignal.timeout(GOOGLE_EVENT_DEADLINE_MS);
  const target = await authorizeCreate(state, task, signal);
  const checked = await state.controlPlane.commit(checkCalendarCreate(task));
  if (!checked.ok) return idle();
  if (!checked.value.wanted) return finishCreateWork(state, checked.value, options);
  if (!target.connection) return defer(state, task, target.error, options);
  const meeting = checked.value.meeting;
  try {
    await createGoogleCalendarEvent(state, target.connection, {
      eventId: task.eventId,
      title: meeting.title,
      description: meeting.attendeeNote ?? "",
      meetingLink: buildSchedulingMeetingLink(task.appOrigin, meeting),
      startAt: task.startAt,
      endAt: task.endAt,
      timeZone: task.timeZone,
      attendeeName: meeting.attendeeName ?? "",
      attendeeEmail: meeting.attendeeEmail ?? "",
    }, { accessToken: target.accessToken, signal });
  } catch (error) {
    return defer(state, task, messageOf(error), options);
  }
  const settled = await state.controlPlane.commit(settleCalendarCreate(task));
  return settled.ok ? finishCreateWork(state, settled.value, options) : idle();
};

export const runCalendarTask = async (
  state: SfuState,
  id: string,
  options: CalendarTaskOptions = {},
  claimed = false,
): Promise<CalendarTaskRun> => {
  try {
    let task: CalendarTask | null;
    if (claimed) {
      task = await state.controlPlane.read(calendarTaskById(id));
      if (task?.action !== "create" || task.attempts !== 1) return idle();
    } else {
      const claim = await state.controlPlane.commit(claimCalendarTask(id, options.leaseMs ?? CALENDAR_TASK_LEASE_MS));
      task = claim.ok ? claim.value : null;
    }
    if (!task || task.state !== "open") return idle();
    return task.action === "create" ? await runCreate(state, task, options) : await runDelete(state, task, options);
  } catch (error) {
    Logger.warn(`[ControlPlane] calendar task ${id} stopped; it runs again once its lease ends`, error);
    return idle();
  }
};

export const drainCalendarTasks = async (state: SfuState, options: CalendarTaskOptions = {}): Promise<void> => {
  if (state.calendarTasks.draining) return;
  state.calendarTasks.draining = true;
  try {
    for (const task of await state.controlPlane.read(dueCalendarTasks)) {
      await runCalendarTask(state, task.id, options);
    }
    state.calendarTasks.failed = (await state.controlPlane.read(failedCalendarTasks)).length;
  } finally {
    state.calendarTasks.draining = false;
  }
};
