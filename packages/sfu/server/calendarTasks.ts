import { Logger } from "../utilities/loggers.js";
import {
  CALENDAR_TASK_LEASE_MS,
  CALENDAR_TASK_RETRY_DELAYS_MS,
  calendarTaskById,
  checkCalendarCreate,
  claimCalendarTask,
  deferCalendarTask,
  dueCalendarTasks,
  failedCalendarTasks,
  finishCalendarDelete,
  settleCalendarCreate,
} from "./controlPlane/calendarTaskCommands.js";
import type { CalendarTask } from "./controlPlane/model.js";
import { hostCalendar } from "./controlPlane/schedulingCommands.js";
import { createGoogleCalendarEvent, deleteGoogleCalendarEvent } from "./googleCalendar.js";
import { isCalendarUsable } from "./scheduling.js";
import { buildSchedulingMeetingLink } from "./schedulingLinks.js";
import type { SfuState } from "./state.js";
import type { ScheduledMeeting } from "../types.js";

export type CalendarTaskOptions = { leaseMs?: number; retryDelaysMs?: readonly number[] };

export type CalendarTaskRun = {
  meeting: ScheduledMeeting | null;
  error: string | null;
  bookingGone: boolean;
};

const NOT_CONNECTED = "Google Calendar is not connected.";

const idle = (meeting: ScheduledMeeting | null = null): CalendarTaskRun => ({ meeting, error: null, bookingGone: false });

const messageOf = (error: unknown): string => (error instanceof Error && error.message) || "Google Calendar request failed.";

const defer = async (
  state: SfuState,
  task: CalendarTask,
  message: string,
  options: CalendarTaskOptions,
): Promise<CalendarTaskRun> => {
  const deferred = await state.controlPlane.commit(
    deferCalendarTask(task.id, message, options.retryDelaysMs ?? CALENDAR_TASK_RETRY_DELAYS_MS),
  );
  if (deferred.ok && deferred.value.gaveUp) {
    Logger.error(
      `[ControlPlane] gave up on calendar task ${task.id} (${task.action} the event of booking ${task.meetingId}) after ${deferred.value.task.attempts} attempts: ${message}`,
    );
  }
  return { meeting: deferred.ok ? deferred.value.meeting : null, error: message, bookingGone: false };
};

const usableConnection = async (state: SfuState, task: CalendarTask) => {
  const connection = await state.controlPlane.read(hostCalendar(task.profileId));
  return isCalendarUsable(connection) ? connection : null;
};

const runDelete = async (state: SfuState, task: CalendarTask, options: CalendarTaskOptions): Promise<CalendarTaskRun> => {
  const connection = await usableConnection(state, task);
  if (!connection) return defer(state, task, NOT_CONNECTED, options);
  try {
    await deleteGoogleCalendarEvent(state, connection, task.eventId);
  } catch (error) {
    return defer(state, task, messageOf(error), options);
  }
  await state.controlPlane.commit(finishCalendarDelete(task.id));
  return idle();
};

const runCreate = async (state: SfuState, task: CalendarTask, options: CalendarTaskOptions): Promise<CalendarTaskRun> => {
  const checked = await state.controlPlane.commit(checkCalendarCreate(task.id));
  if (!checked.ok) return idle();
  if (!checked.value.wanted) {
    await runCalendarTask(state, task.id, options);
    return { ...idle(), bookingGone: true };
  }
  const meeting = checked.value.meeting;
  const connection = await usableConnection(state, task);
  if (!connection) return defer(state, task, NOT_CONNECTED, options);
  try {
    await createGoogleCalendarEvent(state, connection, {
      eventId: task.eventId,
      title: meeting.title,
      description: meeting.attendeeNote ?? "",
      meetingLink: buildSchedulingMeetingLink(task.appOrigin, meeting),
      startAt: task.startAt,
      endAt: task.endAt,
      timeZone: task.timeZone,
      attendeeName: meeting.attendeeName ?? "",
      attendeeEmail: meeting.attendeeEmail ?? "",
    });
  } catch (error) {
    return defer(state, task, messageOf(error), options);
  }
  const settled = await state.controlPlane.commit(settleCalendarCreate(task.id));
  if (!settled.ok) return idle();
  if (settled.value.removal) await runCalendarTask(state, task.id, options);
  return { meeting: settled.value.meeting, error: null, bookingGone: settled.value.meeting === null };
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
