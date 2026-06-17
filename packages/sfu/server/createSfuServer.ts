import { createServer as createHttpServer } from "http";
import type { Server as HttpServer } from "http";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import {
  initMediaSoup,
  initScheduledMeetings,
  initScheduledWebinars,
} from "./init.js";
import {
  advanceScheduledMeetings,
  persistScheduledMeetingChanges,
} from "./scheduledMeetings.js";
import { createSfuApp } from "./http/createApp.js";
import {
  startScheduledWebinarTimer,
  stopScheduledWebinarTimer,
} from "./scheduledWebinarScheduler.js";
import {
  connectSocketAdapter,
  createSfuSocketServer,
  type SocketAdapterLifecycle,
} from "./socket/createSocketServer.js";
import { createRoomRegistry } from "./roomRegistry.js";
import {
  releaseAllRoomOwnerships,
  renewRoomOwnerships,
} from "./rooms.js";
import { createSfuState } from "./state.js";
import type { SfuState } from "./state.js";

export type SfuServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  state: SfuState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type CreateSfuServerOptions = {
  config?: typeof defaultConfig;
};

export const createSfuServer = (
  options: CreateSfuServerOptions = {},
): SfuServer => {
  const config = options.config ?? defaultConfig;
  const roomRegistry = createRoomRegistry(config);
  const state = createSfuState({
    isDraining: config.draining,
    roomRegistry,
  });
  let io: SocketIOServer | null = null;

  const app = createSfuApp({
    state,
    config,
    getIo: () => io,
  });
  const httpServer = createHttpServer(app);
  io = createSfuSocketServer(httpServer, { state, config });

  let scheduledMeetingTickTimer: NodeJS.Timeout | null = null;
  let roomOwnershipRenewTimer: NodeJS.Timeout | null = null;
  let socketAdapterLifecycle: SocketAdapterLifecycle | null = null;

  const start = async (): Promise<void> => {
    await state.roomRegistry.start();
    socketAdapterLifecycle = await connectSocketAdapter(io, { config });
    await initMediaSoup(state, () => io);
    initScheduledWebinars(state);
    initScheduledMeetings(state);
    startScheduledWebinarTimer(state, () => io, undefined);
    roomOwnershipRenewTimer = setInterval(() => {
      renewRoomOwnerships(state).catch((error) => {
        Logger.error("Failed to renew room ownerships", error);
      });
    }, config.roomRegistry.renewIntervalMs);
    if (roomOwnershipRenewTimer.unref) {
      roomOwnershipRenewTimer.unref();
    }
    scheduledMeetingTickTimer = setInterval(() => {
      const changedMeetings = advanceScheduledMeetings(state.scheduledMeetings);
      if (changedMeetings.length > 0 && state.scheduledMeetingPersistence) {
        try {
          persistScheduledMeetingChanges(
            state.scheduledMeetings,
            state.scheduledMeetingPersistence,
            changedMeetings,
          );
        } catch (error) {
          Logger.warn("Failed to persist scheduled-meeting tick", error);
        }
      }
    }, 5000);

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, () => {
        Logger.success(`Server running on port ${config.port}`);
        resolve();
      });
    });
  };

  const stop = async (): Promise<void> => {
    stopScheduledWebinarTimer(state);
    if (scheduledMeetingTickTimer) {
      clearInterval(scheduledMeetingTickTimer);
      scheduledMeetingTickTimer = null;
    }
    if (roomOwnershipRenewTimer) {
      clearInterval(roomOwnershipRenewTimer);
      roomOwnershipRenewTimer = null;
    }
    state.scheduledWebinarPersistence?.close?.();
    state.scheduledWebinarPersistence = null;
    state.scheduledMeetingPersistence?.close?.();
    state.scheduledMeetingPersistence = null;
    await releaseAllRoomOwnerships(state);
    await socketAdapterLifecycle?.close();
    socketAdapterLifecycle = null;
    await state.roomRegistry.close();
    io.close();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    for (const room of state.rooms.values()) {
      room.close();
    }
    state.rooms.clear();
    state.roomCreations.clear();

    for (const worker of state.workers) {
      try {
        worker.close();
      } catch (error) {
        Logger.warn("Error closing mediasoup worker", error);
      }
    }
    state.workers = [];
  };

  return {
    app,
    httpServer,
    io,
    state,
    start,
    stop,
  };
};
