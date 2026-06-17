import type { Server as HttpServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Server as SocketIOServer } from "socket.io";
import { config as defaultConfig } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import { resolveCorsOrigins } from "../cors.js";
import type { SfuState } from "../state.js";
import { attachSocketAuth } from "./auth.js";
import { registerConnectionHandlers } from "./registerConnectionHandlers.js";

// Cap the maximum size of a single inbound message. This is socket.io's own
// default (1 MB) made explicit so it is reviewable and tunable, and so it acts
// as a documented backstop against a client trying to push oversized frames
// (e.g. a huge Yjs/awareness payload) to exhaust memory.
const MAX_HTTP_BUFFER_SIZE = 1_000_000;

export type CreateSocketServerOptions = {
  state: SfuState;
  config?: typeof defaultConfig;
};

export type SocketAdapterLifecycle = {
  mode: "memory" | "redis";
  close: () => Promise<void>;
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
      // Env-driven allow-list; dev may default to "*", production requires
      // SFU_CORS_ORIGINS unless SFU_ALLOW_OPEN_CORS=1 is explicitly set.
      origin: resolveCorsOrigins(),
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    pingInterval: socketConfig.socket.pingIntervalMs,
    pingTimeout: socketConfig.socket.pingTimeoutMs,
    connectionStateRecovery,
  });

  attachSocketAuth(io, { config: options.config });
  registerConnectionHandlers(io, options.state);

  return io;
};

export const connectSocketAdapter = async (
  io: SocketIOServer,
  options?: { config?: typeof defaultConfig },
): Promise<SocketAdapterLifecycle> => {
  const socketConfig = options?.config ?? defaultConfig;
  const redisUrl = socketConfig.socket.redisUrl;

  if (!redisUrl) {
    if (socketConfig.socket.requireRedisAdapter) {
      throw new Error("Redis Socket.IO adapter is required but not configured.");
    }
    Logger.info("[Socket.IO] Using in-memory adapter");
    return { mode: "memory", close: async () => {} };
  }

  const pubClient = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: socketConfig.socket.redisConnectTimeoutMs,
    },
  });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (error) => {
    Logger.error("[Socket.IO] Redis pub client error", error);
  });
  subClient.on("error", (error) => {
    Logger.error("[Socket.IO] Redis sub client error", error);
  });

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    Logger.success("[Socket.IO] Redis adapter connected");
  } catch (error) {
    await Promise.allSettled([pubClient.disconnect(), subClient.disconnect()]);
    throw error;
  }

  return {
    mode: "redis",
    close: async () => {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    },
  };
};
