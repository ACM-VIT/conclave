import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { Logger } from "../../../utilities/loggers.js";
import { asRecord } from "../../../utilities/untrusted.js";
import { KINDS, StoreCorruptionError, StoreUnavailableError, type Kind } from "../model.js";
import type { Backend } from "./backend.js";
import { createMemoryData, readMemory, runOnMemory, type MemoryData } from "./memory.js";

const FORMAT = "conclave-control-plane";
const VERSION = 1;

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

type JsonLock = { token: string; heartbeat: NodeJS.Timeout };

const lockAge = (lockPath: string): number => Date.now() - statSync(lockPath).mtimeMs;

const acquireLock = (lockPath: string, onLost: () => void): JsonLock => {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, token);
      closeSync(fd);
      const heartbeat = setInterval(() => {
        try {
          if (readFileSync(lockPath, "utf8") !== token) throw new Error("taken over");
          const now = new Date();
          utimesSync(lockPath, now, now);
        } catch {
          clearInterval(heartbeat);
          onLost();
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return { token, heartbeat };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockAge(lockPath) < LOCK_STALE_MS) {
        throw new Error(
          `${lockPath} is held by another SFU. JSON persistence serves one SFU only; use sqlite or redis for more.`,
        );
      }
      unlinkSync(lockPath);
    }
  }
  throw new Error(`Could not lock ${lockPath}.`);
};

const releaseLock = (lockPath: string, lock: JsonLock): void => {
  clearInterval(lock.heartbeat);
  try {
    if (readFileSync(lockPath, "utf8") === lock.token) unlinkSync(lockPath);
  } catch {
    return;
  }
};

const parseFile = (path: string): MemoryData => {
  const data = createMemoryData();
  if (!existsSync(path)) return data;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const file = asRecord(parsed);
  if (file.format !== FORMAT || file.version !== VERSION) {
    throw new StoreCorruptionError(`${path} is not a control-plane store file.`);
  }
  data.rev = Number(file.rev) || 0;
  const records = asRecord(file.records);
  for (const kind of KINDS) {
    for (const [id, entry] of Object.entries(asRecord(records[kind]))) {
      const stored = asRecord(entry);
      data.records[kind].set(id, {
        rev: Number(stored.rev) || 0,
        legacy: typeof stored.legacy === "number" ? stored.legacy : null,
        json: JSON.stringify(stored.value),
      });
    }
  }
  for (const [field, owner] of Object.entries(asRecord(file.unique))) {
    if (typeof owner === "string") data.unique.set(field, owner);
  }
  for (const [key, members] of Object.entries(asRecord(file.tags))) {
    if (Array.isArray(members)) {
      data.tags.set(
        key,
        new Set((members as unknown[]).filter((id): id is string => typeof id === "string")),
      );
    }
  }
  for (const [key, rev] of Object.entries(asRecord(file.tombstones))) {
    if (typeof rev === "number") data.tombstones.set(key, rev);
  }
  return data;
};

const serialize = (data: MemoryData): string => {
  const kinds = KINDS.map((kind: Kind) => {
    const entries = [...data.records[kind]].map(
      ([id, stored]) =>
        `${JSON.stringify(id)}:{"rev":${stored.rev},"legacy":${JSON.stringify(stored.legacy)},"value":${stored.json}}`,
    );
    return `${JSON.stringify(kind)}:{${entries.join(",")}}`;
  });
  return [
    `{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"rev":${data.rev}`,
    `,"records":{${kinds.join(",")}}`,
    `,"unique":${JSON.stringify(Object.fromEntries(data.unique))}`,
    `,"tags":${JSON.stringify(Object.fromEntries([...data.tags].map(([key, members]) => [key, [...members]])))}`,
    `,"tombstones":${JSON.stringify(Object.fromEntries(data.tombstones))}}`,
  ].join("");
};

export const createJsonBackend = (path: string): Backend => {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let closed = false;
  const lock = acquireLock(lockPath, () => {
    closed = true;
    Logger.error(`[ControlPlane] lost the lock on ${path}; refusing further writes`);
  });
  let data: MemoryData;
  try {
    data = parseFile(path);
  } catch (error) {
    releaseLock(lockPath, lock);
    throw error;
  }
  const persist = (): void => {
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, serialize(data), { encoding: "utf8", flush: true });
      renameSync(tmp, path);
    } catch (error) {
      throw new StoreUnavailableError(`Could not write ${path}.`, { cause: error });
    }
  };
  return {
    mode: "json",
    commit: async (command, now) => {
      if (closed) throw new Error("The control-plane store is closed.");
      return runOnMemory(data, command, now, persist);
    },
    read: async (read, now) => readMemory(data, read, now),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseLock(lockPath, lock);
    },
  };
};
