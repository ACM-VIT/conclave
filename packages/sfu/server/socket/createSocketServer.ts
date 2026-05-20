import type { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../../config/config.js";
import type { RecordingManager } from "../recording/recordingManager.js";
import type { SfuState } from "../state.js";
import { attachSocketAuth } from "./auth.js";
import { registerConnectionHandlers } from "./registerConnectionHandlers.js";

export type CreateSocketServerOptions = {
  state: SfuState;
  config?: typeof defaultConfig;
  recordings: RecordingManager;
};

export const createSfuSocketServer = (
  httpServer: HttpServer,
  options: CreateSocketServerOptions,
): SocketIOServer => {
  const socketConfig = options.config ?? defaultConfig;
  const connectionStateRecovery =
    socketConfig.socket.recoveryMaxDisconnectionMs > 0
      ? {
          maxDisconnectionDuration:
            socketConfig.socket.recoveryMaxDisconnectionMs,
          skipMiddlewares: true,
        }
      : undefined;

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    pingInterval: socketConfig.socket.pingIntervalMs,
    pingTimeout: socketConfig.socket.pingTimeoutMs,
    connectionStateRecovery,
  });

  attachSocketAuth(io, { config: options.config });
  registerConnectionHandlers(io, options.state, options.recordings);

  return io;
};
