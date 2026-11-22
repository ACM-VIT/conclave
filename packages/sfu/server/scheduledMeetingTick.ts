import { Logger } from "../utilities/loggers.js";
import { advanceScheduledMeetings, persistScheduledMeetingChanges } from "./scheduledMeetings.js";
import { sendDueSchedulingEmailReminders } from "./schedulingEmailReminders.js";
import type { SfuState } from "./state.js";

/** Moves due meetings to live or ended and sends due reminders; saving is best effort and retried by later edits. */
export const runScheduledMeetingTick = async (state: SfuState): Promise<void> => {
  const changedMeetings = advanceScheduledMeetings(state.scheduledMeetings);
  const persistence = state.scheduledMeetingPersistence;
  await Promise.all([
    changedMeetings.length > 0 && persistence
      ? persistScheduledMeetingChanges(state.scheduledMeetings, persistence, changedMeetings).catch((error: unknown) => {
          Logger.warn("Failed to persist scheduled-meeting tick", error);
        })
      : undefined,
    sendDueSchedulingEmailReminders(state).catch((error: unknown) => {
      Logger.warn("Failed to send scheduling reminders", error);
    }),
  ]);
};
