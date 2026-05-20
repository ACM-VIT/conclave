import type { Worker } from "mediasoup/types";
import createWorkers from "../utilities/createWorkers.js";
import { Logger } from "../utilities/loggers.js";
import type { SfuState } from "./state.js";
import {
  createFileScheduledWebinarPersistence,
  loadPersistedSchedules,
  type ScheduledWebinarPersistence,
} from "./scheduledWebinars.js";

export const initMediaSoup = async (state: SfuState): Promise<void> => {
  state.workers = (await createWorkers()) as Worker[];
  Logger.info(`Created ${state.workers.length} mediasoup workers`);
};

export const initScheduledWebinars = (
  state: SfuState,
  persistence: ScheduledWebinarPersistence = createFileScheduledWebinarPersistence(),
): void => {
  state.scheduledWebinarPersistence = persistence;
  const loaded = loadPersistedSchedules(state.scheduledWebinars, persistence);
  if (loaded > 0) {
    Logger.info(`Restored ${loaded} scheduled webinar(s) from disk`);
  }
};
