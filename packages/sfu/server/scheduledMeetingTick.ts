import { Logger } from "../utilities/loggers.js";
import { advanceScheduledMeetings, changeMeetings, dueScheduledMeetingIds } from "./scheduledMeetings.js";
import { sendDueSchedulingEmailReminders } from "./schedulingEmailReminders.js";
import type { SfuState } from "./state.js";

export const runScheduledMeetingTick = async (state: SfuState): Promise<void> => {
  const dueAt = Date.now();
  await Promise.all([
    dueScheduledMeetingIds(state.scheduledMeetings, dueAt).length > 0
      ? changeMeetings(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
          (store) => dueScheduledMeetingIds(store, dueAt),
          (draft, at) => advanceScheduledMeetings(draft, dueAt, at),
        ).catch((error: unknown) => {
          Logger.warn("Failed to persist scheduled-meeting tick", error);
        })
      : undefined,
    sendDueSchedulingEmailReminders(state).catch((error: unknown) => {
      Logger.warn("Failed to send scheduling reminders", error);
    }),
  ]);
};
