import { createClient, type RedisClientType } from "redis";
import { Logger } from "../utilities/loggers.js";
import { isRedisTransientError } from "./redisErrors.js";

export type RedisPersistenceClient = RedisClientType;

export const resolveRedisPersistenceUrl = (): string =>
  process.env.SFU_PERSISTENCE_REDIS_URL?.trim() ||
  process.env.SFU_REDIS_URL?.trim() ||
  process.env.REDIS_URL?.trim() ||
  "";

export const resolveRedisPersistenceKeyPrefix = (): string =>
  (
    process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX?.trim() ||
    "conclave:sfu:persistence"
  ).replace(/:+$/, "");

export const shouldUseRedisPersistence = (
  mode: string | undefined,
  redisUrl: string,
): boolean => {
  if (mode === "redis") return true;
  if (mode === "sqlite" || mode === "json" || mode === "file") return false;
  return Boolean(redisUrl);
};

export const createRedisPersistenceClient = (
  name: string,
  redisUrl: string,
): RedisPersistenceClient => {
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: Number(process.env.SFU_REDIS_CONNECT_TIMEOUT_MS || 5000),
      reconnectStrategy: (retries) => Math.min(100 + retries * 200, 5000),
    },
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
  });

  client.on("error", (error) => {
    const log = isRedisTransientError(error) ? Logger.warn : Logger.error;
    log(`[${name}] Redis persistence client error`, error);
  });

  return client;
};
