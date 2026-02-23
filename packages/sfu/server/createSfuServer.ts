import { createServer as createHttpServer } from "http";
import type { Server as HttpServer } from "http";
import type { Express } from "express";
import type { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../config/config.js";
import { Logger } from "../utilities/loggers.js";
import { initMediaSoup } from "./init.js";
import { createSfuApp } from "./http/createApp.js";
import { createSfuSocketServer } from "./socket/createSocketServer.js";
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
  const state = createSfuState({ isDraining: config.draining });
  let io: SocketIOServer | null = null;

  const app = createSfuApp({
    state,
    config,
    getIo: () => io,
  });
  const httpServer = createHttpServer(app);
  io = createSfuSocketServer(httpServer, { state, config });

  const start = async (): Promise<void> => {
    await initMediaSoup(state);

    await new Promise<void>((resolve) => {
      httpServer.listen(config.port, () => {
        Logger.success(`Server running on port ${config.port}`);
        resolve();
      });
    });
  };

  const stop = async (): Promise<void> => {
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
    start,
    stop,
  };
};
