import type { Worker } from "mediasoup/types";
import type { Server as SocketIOServer } from "socket.io";
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
  createScheduledMeetingPersistence,
  loadPersistedMeetings,
  type ScheduledMeetingPersistence,
} from "./scheduledMeetings.js";
import {
  createSchedulingPersistence,
  loadPersistedScheduling,
  type SchedulingPersistence,
} from "./scheduling.js";

const WORKER_RESTART_NOTICE =
  "The media server for this room restarted. Reconnecting...";
const WORKER_RESTART_NOTICE_MS = 1000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const cleanupDeadWorkerRooms = async (
  state: SfuState,
  io: SocketIOServer | null,
  worker: Worker,
  label: string,
): Promise<void> => {
  const workerPid = typeof worker.pid === "number" ? worker.pid : null;
  const affectedRooms = Array.from(state.rooms.values()).filter((room) =>
    workerPid === null ? room.router.closed : room.workerPid === workerPid,
  );

  if (affectedRooms.length === 0) {
    Logger.warn(`Worker ${label} died with no matching rooms to clean up`);
    return;
  }

  const pendingSockets = new Set<{ disconnect: (close?: boolean) => void }>();

  if (io) {
    for (const room of affectedRooms) {
      io.to(room.channelId).emit("serverRestarting", {
        roomId: room.id,
        message: WORKER_RESTART_NOTICE,
        reconnecting: true,
      });

      for (const pending of room.pendingClients.values()) {
        pendingSockets.add(pending.socket);
        pending.socket.emit("serverRestarting", {
          roomId: room.id,
          message: WORKER_RESTART_NOTICE,
          reconnecting: true,
        });
      }
    }
  }

  for (const room of affectedRooms) {
    Logger.warn(
      `Closing room ${room.id} (${room.clientId}) after worker ${label} died`,
    );
    forceCloseRoom(state, room.channelId);
  }

  if (io) {
    await wait(WORKER_RESTART_NOTICE_MS);
    for (const room of affectedRooms) {
      io.in(room.channelId).disconnectSockets(true);
    }
    for (const pendingSocket of pendingSockets) {
      pendingSocket.disconnect(true);
    }
  }
};

export const initMediaSoup = async (
  state: SfuState,
  getIo?: () => SocketIOServer | null,
): Promise<void> => {
  state.workers = (await createWorkers({
    onWorkerDied: async (worker, label) => {
      await cleanupDeadWorkerRooms(
        state,
        getIo?.() ?? null,
        worker,
        label,
      );
    },
  }));
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
  persistence: ScheduledMeetingPersistence = createScheduledMeetingPersistence(),
): Promise<void> => {
  state.scheduledMeetingPersistence = persistence;
  return loadPersistedMeetings(state.scheduledMeetings, persistence).then((loaded) => {
    if (loaded > 0) {
      Logger.info(`Restored ${loaded} scheduled meeting(s) from persistence`);
    }
  });
};

export const initScheduling = (
  state: SfuState,
  persistence: SchedulingPersistence = createSchedulingPersistence(),
): Promise<void> => {
  state.schedulingPersistence = persistence;
  return loadPersistedScheduling(state.scheduling, persistence).then((loaded) => {
    if (loaded > 0) {
      Logger.info(`Restored ${loaded} scheduling record(s) from persistence`);
    }
  });
};
