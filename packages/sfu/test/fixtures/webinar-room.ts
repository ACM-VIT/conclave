import { done } from "../../server/controlPlane/model.js";
import { getRoomChannelId } from "../../server/rooms.js";
import { refreshWebinarRoomConfig } from "../../server/scheduledWebinarScheduler.js";
import type { SfuState } from "../../server/state.js";
import type { ScheduledWebinar } from "../../types.js";

export const readRoomConfig = (state: SfuState, webinar: ScheduledWebinar) =>
  state.webinarConfigs.get(getRoomChannelId(webinar.clientId, webinar.roomId));

export const seedRoomConfig = async (state: SfuState, webinar: ScheduledWebinar) => {
  await refreshWebinarRoomConfig(state, webinar, () => {});
  const config = readRoomConfig(state, webinar);
  if (!config) throw new Error("The persisted schedule did not seed a room config");
  return config;
};

export const publishWebinar = async (state: SfuState, webinar: ScheduledWebinar) => {
  const saved = await state.controlPlane.commit((tx) => {
    tx.put("webinar", webinar);
    return done(undefined);
  });
  if (!saved.ok) throw new Error("Could not persist the schedule fixture");
  return seedRoomConfig(state, webinar);
};
