import { mergePersistedMeetings } from "./scheduledMeetings.js";
import { mergePersistedSchedules } from "./scheduledWebinars.js";
import { mergePersistedScheduling, persistScheduling } from "./scheduling.js";
import type { SfuState } from "./state.js";

/**
 * Each SFU loads its stores once at startup, so records another SFU recovered
 * or saved later are missing here until a reload. This merges them in, newest
 * wins, and then writes the merged scheduling records back, which restores any
 * that an older SFU's whole-table save erased.
 */
export const reloadPersistedStores = async (
  state: SfuState,
): Promise<{ webinars: number; meetings: number; scheduling: number }> => {
  const webinars = state.scheduledWebinarPersistence
    ? mergePersistedSchedules(state.scheduledWebinars, state.scheduledWebinarPersistence)
    : 0;
  const meetings = state.scheduledMeetingPersistence
    ? await mergePersistedMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence)
    : 0;
  let scheduling = 0;
  if (state.schedulingPersistence) {
    scheduling = await mergePersistedScheduling(state.scheduling, state.schedulingPersistence, { strict: true });
    await persistScheduling(state.scheduling, state.schedulingPersistence);
  }
  return { webinars, meetings, scheduling };
};
