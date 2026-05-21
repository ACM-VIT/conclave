import { createServer as createHttpServer } from "http";
import type { Server as HttpServer } from "http";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import { initMediaSoup, initScheduledWebinars } from "./init.js";
import { createSfuApp } from "./http/createApp.js";
import {
  startScheduledWebinarTimer,
  stopScheduledWebinarTimer,
} from "./scheduledWebinarScheduler.js";
import { createSfuSocketServer } from "./socket/createSocketServer.js";
import { createSfuState } from "./state.js";
import type { SfuState } from "./state.js";
import {
  createRecordingManager,
  type RecordingManager,
} from "./recording/recordingManager.js";
import { isFfmpegAvailable } from "./recording/ffmpegBridge.js";

export type SfuServer = {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  state: SfuState;
  recordings: RecordingManager;
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
  const state = createSfuState({ isDraining: config.draining });
  let io: SocketIOServer | null = null;
  const recordings = createRecordingManager({
    state,
    getIo: () => io,
  });

  const app = createSfuApp({
    state,
    config,
    getIo: () => io,
    recordings,
  });
  const httpServer = createHttpServer(app);
  io = createSfuSocketServer(httpServer, { state, config, recordings });

  const start = async (): Promise<void> => {
    await initMediaSoup(state);
    initScheduledWebinars(state);
    startScheduledWebinarTimer(state, () => io, undefined, recordings);
    void isFfmpegAvailable();

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, () => {
        Logger.success(`Server running on port ${config.port}`);
        resolve();
      });
    });
  };

  const stop = async (): Promise<void> => {
    stopScheduledWebinarTimer(state);
    state.scheduledWebinarPersistence?.close?.();
    state.scheduledWebinarPersistence = null;
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
    recordings,
    start,
    stop,
  };
};
