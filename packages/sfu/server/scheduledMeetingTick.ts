import { Logger } from "../utilities/loggers.js";
import { advanceScheduledMeetings, changeMeetings, dueScheduledMeetingIds } from "./scheduledMeetings.js";
import { sendDueSchedulingEmailReminders } from "./schedulingEmailReminders.js";
import type { SfuState } from "./state.js";

/**
 * Moves due meetings to live or ended and sends due reminders. The status
 * change is saved before memory moves on, so a failed save is simply tried
 * again on the next tick.
 */
export const runScheduledMeetingTick = async (state: SfuState): Promise<void> => {
  const now = Date.now();
  await Promise.all([
    dueScheduledMeetingIds(state.scheduledMeetings, now).length > 0
      ? changeMeetings(
          state.scheduledMeetings,
          state.scheduledMeetingPersistence,
          (store) => dueScheduledMeetingIds(store, now),
          (draft) => advanceScheduledMeetings(draft, now),
        ).catch((error: unknown) => {
          Logger.warn("Failed to persist scheduled-meeting tick", error);
        })
      : undefined,
    sendDueSchedulingEmailReminders(state).catch((error: unknown) => {
      Logger.warn("Failed to send scheduling reminders", error);
    }),
  ]);
};
