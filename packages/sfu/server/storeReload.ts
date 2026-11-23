import { mergePersistedMeetings } from "./scheduledMeetings.js";
import { mergePersistedSchedules } from "./scheduledWebinars.js";
import { mergePersistedScheduling } from "./scheduling.js";
import type { SfuState } from "./state.js";

/**
 * Each SFU loads its stores once at startup, so records another SFU recovered
 * or saved later are missing here until a reload. This merges them in, newest
 * stamp wins over values and deletions, and then writes the merged scheduling
 * records back, which restores any that an older SFU's whole-table save erased.
 * Any failed read or write rejects, so the caller can report it.
 */
export const reloadPersistedStores = async (
  state: SfuState,
): Promise<{ webinars: number; meetings: number; scheduling: number }> => {
  const webinars = state.scheduledWebinarPersistence
    ? await mergePersistedSchedules(state.scheduledWebinars, state.scheduledWebinarPersistence)
    : 0;
  const meetings = state.scheduledMeetingPersistence
    ? await mergePersistedMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence)
    : 0;
  const scheduling = state.schedulingPersistence
    ? await mergePersistedScheduling(state.scheduling, state.schedulingPersistence, { strict: true, writeBack: true })
    : 0;
  return { webinars, meetings, scheduling };
};
