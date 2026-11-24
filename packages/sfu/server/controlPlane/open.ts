import { resolve } from "node:path";
import { Logger } from "../../utilities/loggers.js";
import {
  resolveRedisPersistenceKeyPrefix,
  resolveRedisPersistenceUrl,
} from "../redisPersistence.js";
import { retryWhileSqliteLocked } from "../sqliteWriteCheck.js";
import type { Backend, StoreMode } from "./backends/backend.js";
import { createJsonBackend } from "./backends/json.js";
import { createMemoryBackend, type MemoryData } from "./backends/memory.js";
import { createRedisBackend } from "./backends/redis.js";
import { createSqliteBackend } from "./backends/sqlite.js";
import { resolveLegacyPaths, type LegacyPaths } from "./legacy.js";
import { runLegacyImport } from "./legacyImport.js";
import { controlPlaneStore, type ControlPlaneStore } from "./store.js";

export type ControlPlaneConfig = {
  mode: StoreMode;
  sqlitePath: string;
  jsonPath: string;
  redisUrl: string;
  keyPrefix: string;
  legacy: LegacyPaths;
};

const MODES: readonly StoreMode[] = ["memory", "json", "sqlite", "redis"];
const LEGACY_MODE_VARIABLES = [
  "SCHEDULING_PERSISTENCE",
  "SCHEDULED_MEETINGS_PERSISTENCE",
  "SCHEDULED_WEBINARS_PERSISTENCE",
] as const;

const asMode = (value: string, variable: string): StoreMode => {
  const normalized = value === "file" ? "json" : value;
  if (!MODES.includes(normalized as StoreMode)) {
    throw new Error(`${variable}=${value} is not one of ${MODES.join(", ")}.`);
  }
  return normalized as StoreMode;
};

export const resolveControlPlaneMode = (env: NodeJS.ProcessEnv = process.env): StoreMode => {
  const explicit = env.CONTROL_PLANE_PERSISTENCE?.trim().toLowerCase();
  if (explicit) return asMode(explicit, "CONTROL_PLANE_PERSISTENCE");
  const derived: StoreMode = resolveRedisPersistenceUrl() ? "redis" : "sqlite";
  const legacy = LEGACY_MODE_VARIABLES.map((variable) => ({
    variable,
    value: env[variable]?.trim().toLowerCase() ?? "",
  })).filter((entry) => entry.value);
  if (legacy.length === 0) return derived;
  const modes = legacy.map((entry) => asMode(entry.value, entry.variable));
  if (modes.every((mode) => mode === derived)) return derived;
  if (legacy.length === LEGACY_MODE_VARIABLES.length && modes.every((mode) => mode === modes[0])) {
    return modes[0];
  }
  throw new Error(
    `${legacy.map((entry) => `${entry.variable}=${entry.value}`).join(", ")} no longer chooses storage per store. Scheduling, meetings and webinars share one store now: set CONTROL_PLANE_PERSISTENCE to ${MODES.join(", ")}.`,
  );
};

export const resolveControlPlaneConfig = (
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig => {
  const mode = resolveControlPlaneMode(env);
  const redisUrl = resolveRedisPersistenceUrl();
  if (mode === "redis" && !redisUrl) {
    throw new Error(
      "Redis control-plane persistence requires SFU_PERSISTENCE_REDIS_URL, SFU_REDIS_URL, or REDIS_URL.",
    );
  }
  const recordings = env.RECORDING_STORAGE_PATH?.trim();
  return {
    mode,
    sqlitePath: env.CONCLAVE_SQLITE_PATH?.trim()
      ? resolve(env.CONCLAVE_SQLITE_PATH.trim())
      : recordings
        ? resolve(recordings, "conclave.sqlite")
        : resolve(process.cwd(), "data", "conclave.sqlite"),
    jsonPath: env.CONTROL_PLANE_JSON_PATH?.trim()
      ? resolve(env.CONTROL_PLANE_JSON_PATH.trim())
      : resolve(process.cwd(), "data", "control-plane.json"),
    redisUrl,
    keyPrefix: resolveRedisPersistenceKeyPrefix(),
    legacy: resolveLegacyPaths(env),
  };
};

export type OpenOptions = {
  clock?: () => number;
  memory?: MemoryData;
  importLegacy?: boolean;
};

export const openControlPlane = async (
  config: ControlPlaneConfig = resolveControlPlaneConfig(),
  options: OpenOptions = {},
): Promise<ControlPlaneStore> => {
  let backend: Backend;
  let redis: { client: Awaited<ReturnType<typeof createRedisBackend>>["client"]; prefix: string } | undefined;
  switch (config.mode) {
    case "memory":
      backend = createMemoryBackend(options.memory);
      break;
    case "json":
      backend = createJsonBackend(config.jsonPath);
      break;
    case "sqlite":
      backend = await retryWhileSqliteLocked(() => createSqliteBackend(config.sqlitePath));
      break;
    case "redis": {
      const created = await createRedisBackend({
        redisUrl: config.redisUrl,
        keyPrefix: config.keyPrefix,
      });
      backend = created;
      redis = { client: created.client, prefix: config.keyPrefix };
      break;
    }
    default: {
      const unreachable: never = config.mode;
      throw new Error(`Unknown control-plane mode ${String(unreachable)}`);
    }
  }
  const store = controlPlaneStore(backend, options.clock);
  if (options.importLegacy === false || config.mode === "memory") return store;
  try {
    const imported = await runLegacyImport(store, {
      mode: config.mode,
      paths: config.legacy,
      redis,
      read: (run) => retryWhileSqliteLocked(run),
    });
    if (imported.superseded) {
      Logger.info("[ControlPlane] another SFU started a newer legacy import; left the rest to it");
    } else if (imported.inserted + imported.refreshed + imported.deleted + imported.conflicts > 0) {
      Logger.info(
        `[ControlPlane] legacy import from ${[...imported.sources, ...imported.adopted].join(", ")}: ${imported.inserted} new, ${imported.refreshed} changed, ${imported.deleted} deleted, ${imported.conflicts} kept over a conflicting change`,
      );
    }
  } catch (error) {
    await store.close();
    throw error;
  }
  Logger.info(`[ControlPlane] ${config.mode} store ready`);
  return store;
};
