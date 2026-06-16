import type { Worker } from "mediasoup/types";
import createWorkers from "../utilities/createWorkers.js";
import { Logger } from "../utilities/loggers.js";
import { forceCloseRoom } from "./rooms.js";
import type { SfuState } from "./state.js";
import {
  createScheduledWebinarPersistence,
  loadPersistedSchedules,
  type ScheduledWebinarPersistence,
} from "./scheduledWebinars.js";
import {
  createSqliteScheduledMeetingPersistence,
  loadPersistedMeetings,
  type ScheduledMeetingPersistence,
} from "./scheduledMeetings.js";

export const initMediaSoup = async (state: SfuState): Promise<void> => {
  state.workers = (await createWorkers({
    onWorkerDied: (_worker, label) => {
      const affectedRooms = Array.from(state.rooms.values()).filter(
        (room) => room.router.closed,
      );
      for (const room of affectedRooms) {
        Logger.warn(
          `Closing room ${room.id} (${room.clientId}) after worker ${label} died`,
        );
        forceCloseRoom(state, room.channelId);
      }
    },
  })) as Worker[];
  Logger.info(`Created ${state.workers.length} mediasoup workers`);
};

export const initScheduledWebinars = (
  state: SfuState,
  persistence: ScheduledWebinarPersistence = createScheduledWebinarPersistence(),
): void => {
  state.scheduledWebinarPersistence = persistence;
  const loaded = loadPersistedSchedules(state.scheduledWebinars, persistence);
  if (loaded > 0) {
    Logger.info(`Restored ${loaded} scheduled webinar(s) from persistence`);
  }
};

export const initScheduledMeetings = (
  state: SfuState,
  persistence: ScheduledMeetingPersistence = createSqliteScheduledMeetingPersistence(),
): void => {
  state.scheduledMeetingPersistence = persistence;
  const loaded = loadPersistedMeetings(state.scheduledMeetings, persistence);
  if (loaded > 0) {
    Logger.info(`Restored ${loaded} scheduled meeting(s) from persistence`);
  }
};
