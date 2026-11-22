import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { Room } from "../config/classes/Room.js";
import { Logger } from "../utilities/loggers.js";
import {
  LOST_ROOM_WINDOW_MS,
  ROOM_RECOVERY_PASS_TTL_MS,
} from "./roomRecoveryPass.js";

/**
 * What the SFU writes down about a room, outside its own memory, so that
 * losing the room (a crash, a restart, a dead media worker) can be told from
 * closing it. Without it a recreated room looks brand new, and its first
 * visitor becomes host even if they were only knocking on the lost call.
 */
export type RoomRecoveryRecord = {
  // When the room was last seen running with a host. Null once its meeting
  // is over.
  liveAt: number | null;
  hostUserKey: string | null;
  adminUserKeys: string[];
  // People a host removed, blocked or took admission back from.
  readmissionRequiredUserKeys: string[];
  // When the code's last meeting was over: a host ended it for everyone, or
  // its last person left. Recovery passes signed up to then are void. A pass
  // brings people back to a call the SFU lost, and a meeting that is over is
  // not one to recover: whoever opens the code next opens a new meeting.
  overAt: number | null;
};

export type RoomRecoveryStore = {
  read: (channelId: string) => Promise<unknown>;
  write: (channelId: string, record: RoomRecoveryRecord) => Promise<void>;
};

export type LostRoom = {
  hostUserKey: string | null;
  adminUserKeys: string[];
  readmissionRequiredUserKeys: string[];
  // After this no pass from the lost call can still be good, so the room is
  // anyone's to open again.
  claimableUntil: number;
};

export type RecalledRoom = {
  lost: LostRoom | null;
  passesVoidUntil: number | null;
};

type LedgerRoom = Pick<
  Room,
  | "channelId"
  | "hostUserKey"
  | "adminUserKeys"
  | "usersNeedingReadmission"
  | "recoveryPassesVoidUntil"
>;

export type RoomRecoveryLedger = {
  noteRunning: (room: LedgerRoom) => void;
  noteOver: (room: Pick<Room, "channelId">) => void;
  recall: (channelId: string) => Promise<RecalledRoom>;
};

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// The one place a stored record is read back into its shape.
const parseRoomRecoveryRecord = (raw: unknown): RoomRecoveryRecord | null => {
  if (!raw || typeof raw !== "object") return null;
  const {
    liveAt,
    hostUserKey,
    adminUserKeys,
    readmissionRequiredUserKeys,
    overAt,
  } = raw as Record<string, unknown>;
  if (liveAt !== null && typeof liveAt !== "number") return null;
  if (overAt !== null && typeof overAt !== "number") return null;
  if (hostUserKey !== null && typeof hostUserKey !== "string") return null;
  if (!isStringList(adminUserKeys)) return null;
  if (!isStringList(readmissionRequiredUserKeys)) return null;
  return {
    liveAt,
    hostUserKey,
    adminUserKeys,
    readmissionRequiredUserKeys,
    overAt,
  };
};

const wasRunningRecently = (liveAt: number | null): liveAt is number =>
  liveAt !== null && Date.now() - liveAt <= LOST_ROOM_WINDOW_MS;

// The cutoff, for as long as a pass signed before it can still be unexpired.
const stillVoids = (overAt: number | null): number | null =>
  overAt !== null && Date.now() - overAt <= ROOM_RECOVERY_PASS_TTL_MS
    ? overAt
    : null;

// Whether a stored record still says anything. One that does not parse is
// not a record at all.
const hasExpired = (raw: unknown): boolean => {
  const record = parseRoomRecoveryRecord(raw);
  return (
    !record ||
    (!wasRunningRecently(record.liveAt) && stillVoids(record.overAt) === null)
  );
};

export const createRoomRecoveryLedger = (
  store: RoomRecoveryStore,
): RoomRecoveryLedger => {
  const save = (channelId: string, record: RoomRecoveryRecord) => {
    store.write(channelId, record).catch((error) => {
      Logger.warn(`Failed to update the recovery record of ${channelId}`, error);
    });
  };

  return {
    noteRunning: (room) =>
      save(room.channelId, {
        liveAt: Date.now(),
        hostUserKey: room.hostUserKey,
        adminUserKeys: [...room.adminUserKeys],
        readmissionRequiredUserKeys: room.usersNeedingReadmission,
        overAt: stillVoids(room.recoveryPassesVoidUntil),
      }),
    noteOver: (room) =>
      save(room.channelId, {
        liveAt: null,
        hostUserKey: null,
        adminUserKeys: [],
        readmissionRequiredUserKeys: [],
        overAt: Date.now(),
      }),
    recall: async (channelId) => {
      const record = parseRoomRecoveryRecord(
        await store.read(channelId).catch((error) => {
          Logger.warn(`Failed to read the recovery record of ${channelId}`, error);
          return null;
        }),
      );
      const liveAt = record?.liveAt ?? null;
      return {
        lost:
          record && wasRunningRecently(liveAt)
            ? {
                hostUserKey: record.hostUserKey,
                adminUserKeys: record.adminUserKeys,
                readmissionRequiredUserKeys: record.readmissionRequiredUserKeys,
                claimableUntil: liveAt + LOST_ROOM_WINDOW_MS,
              }
            : null,
        passesVoidUntil: stillVoids(record?.overAt ?? null),
      };
    },
  };
};

export const createMemoryRoomRecoveryStore = (): RoomRecoveryStore => {
  const records = new Map<string, string>();
  return {
    read: async (channelId) => {
      const stored = records.get(channelId);
      const record: unknown = stored === undefined ? null : JSON.parse(stored);
      return record;
    },
    write: async (channelId, record) => {
      records.set(channelId, JSON.stringify(record));
    },
  };
};

const PRUNE_EVERY_MS = 10 * 60 * 1000;
const ABANDONED_TEMP_FILE_MS = 60 * 1000;
// A record's lock is held for one small write or one read and delete. One
// held this long belongs to an SFU that died holding it.
const ABANDONED_LOCK_MS = 5_000;
const LOCK_RETRY_MS = 5;

const roomRecoveryDirectory = (): string => {
  const configured = process.env.SFU_ROOM_RECOVERY_PATH?.trim();
  if (configured) return resolve(configured);
  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  return recordingStoragePath
    ? resolve(recordingStoragePath, "room-recovery")
    : resolve(process.cwd(), "data", "room-recovery");
};

const failedWith = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === code;

// Runs a file operation another SFU may race: the file being gone already is
// an answer, not a failure.
const unlessGone = <T>(operation: () => T): T | null => {
  try {
    return operation();
  } catch (error) {
    if (failedWith(error, "ENOENT")) return null;
    throw error;
  }
};

// Back where it was, unless something newer is there already.
const putBack = (aside: string, path: string) => {
  try {
    linkSync(aside, path);
  } catch (error) {
    if (!failedWith(error, "EEXIST")) throw error;
  }
};

type HeldLock = { path: string; token: string };

const holds = (lock: HeldLock): boolean =>
  unlessGone(() => readFileSync(lock.path, "utf8")) === lock.token;

// Takes away a lock held for far longer than anything holds one: its holder
// is gone. The lock is moved aside first, and goes back if what was moved is
// not the lock found abandoned but one taken since.
const clearIfAbandoned = (lockPath: string): void => {
  const takenAt = unlessGone(() => statSync(lockPath).mtimeMs);
  if (takenAt === null || Date.now() - takenAt <= ABANDONED_LOCK_MS) return;
  const holder = unlessGone(() => readFileSync(lockPath, "utf8"));
  if (holder === null) return;
  const aside = `${lockPath}.${randomBytes(6).toString("hex")}.abandoned`;
  if (unlessGone(() => renameSync(lockPath, aside)) === null) return;
  if (unlessGone(() => readFileSync(aside, "utf8")) !== holder) {
    putBack(aside, lockPath);
  }
  rmSync(aside, { force: true });
};

const tryLock = (lockPath: string): HeldLock | null => {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
    return { path: lockPath, token };
  } catch (error) {
    if (!failedWith(error, "EEXIST")) throw error;
    clearIfAbandoned(lockPath);
    return null;
  }
};

const lock = async (lockPath: string): Promise<HeldLock> => {
  for (;;) {
    const held = tryLock(lockPath);
    if (held) return held;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
};

// Never one taken over as abandoned: that is someone else's now.
const unlock = (lock: HeldLock): void => {
  if (holds(lock)) rmSync(lock.path, { force: true });
};

/**
 * One small file per room, in a directory every SFU container on the host
 * shares. A room runs on one instance at a time, and whichever instance
 * recreates a lost room can read its record.
 *
 * Writing a record and clearing out an expired one each take that record's
 * lock, a file beside it created only if it is not there. So a record is
 * deleted only while it is still the expired one that was read, and never
 * moved: another SFU reading without the lock finds the room's record, or
 * finds it gone because it had expired. This SFU's own reads of a room wait
 * for its writes to that room, which wait for the lock when another SFU
 * holds it.
 */
export const createFileRoomRecoveryStore = (
  directory: string = roomRecoveryDirectory(),
): RoomRecoveryStore => {
  const pathOf = (channelId: string): string =>
    resolve(
      directory,
      `${createHash("sha256").update(channelId).digest("hex")}.json`,
    );
  const read = (path: string): unknown => {
    const stored = unlessGone(() => readFileSync(path, "utf8"));
    return stored === null ? null : JSON.parse(stored);
  };
  const lockOf = (path: string): string => `${path}.lock`;
  const isExpired = (path: string): boolean => {
    try {
      const stored = read(path);
      return stored !== null && hasExpired(stored);
    } catch {
      return true;
    }
  };
  const writeNow = (path: string, record: RoomRecoveryRecord) => {
    const pending = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(pending, JSON.stringify(record), "utf8");
    renameSync(pending, path);
  };
  const pruneOne = (name: string) => {
    const path = resolve(directory, name);
    if (name.endsWith(".lock")) {
      clearIfAbandoned(path);
      return;
    }
    if (!name.endsWith(".json")) {
      // What is left of a write that never finished.
      const written = unlessGone(() => statSync(path).mtimeMs);
      if (written !== null && Date.now() - written > ABANDONED_TEMP_FILE_MS) {
        rmSync(path, { force: true });
      }
      return;
    }
    // A record whose lock someone holds is being written or cleared out
    // already: it waits for the next round.
    const held = tryLock(lockOf(path));
    if (!held) return;
    try {
      if (isExpired(path) && holds(held)) rmSync(path, { force: true });
    } finally {
      unlock(held);
    }
  };
  // Nothing touches the disk until the first room does.
  let prunedAt = 0;
  const tidy = () => {
    if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    try {
      for (const name of readdirSync(directory)) pruneOne(name);
    } catch (error) {
      Logger.warn(`Failed to clear out old recovery records in ${directory}`, error);
    }
  };
  // This SFU's writes to a room that had to wait for its lock, in order.
  const waitingWrites = new Map<string, Promise<void>>();
  return {
    read: async (channelId) => {
      const waiting = waitingWrites.get(channelId);
      if (waiting) await waiting.catch(() => undefined);
      return read(pathOf(channelId));
    },
    write: async (channelId, record) => {
      mkdirSync(directory, { recursive: true });
      tidy();
      const path = pathOf(channelId);
      const waiting = waitingWrites.get(channelId);
      const held = waiting ? null : tryLock(lockOf(path));
      if (held) {
        try {
          writeNow(path, record);
        } finally {
          unlock(held);
        }
        return;
      }
      const written = (waiting ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const taken = await lock(lockOf(path));
          try {
            writeNow(path, record);
          } finally {
            unlock(taken);
          }
        });
      waitingWrites.set(channelId, written);
      const settle = () => {
        if (waitingWrites.get(channelId) === written) waitingWrites.delete(channelId);
      };
      written.then(settle, settle);
      return written;
    },
  };
};
