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

/**
 * One small file per room, in a directory every SFU container on the host
 * shares. A room runs on one instance at a time, so instances never write the
 * same record, and whichever instance recreates a lost room can read it.
 *
 * Instances do share the tidying up, so one may be clearing out a room's
 * expired record just as another writes that room a new one. A record is
 * therefore never deleted where it lies: it is moved aside, which takes
 * whatever is there in one step, and looked at again before it goes.
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
  // What a file holds now. Another instance may have taken it meanwhile.
  const stateOf = (path: string): "gone" | "expired" | "current" => {
    try {
      const stored = read(path);
      if (stored === null) return "gone";
      return hasExpired(stored) ? "expired" : "current";
    } catch {
      return "expired";
    }
  };
  // Back where it was, unless the room has a newer record there already.
  const putBack = (aside: string, path: string) => {
    try {
      linkSync(aside, path);
    } catch (error) {
      if (!failedWith(error, "EEXIST")) throw error;
    }
  };
  const pruneOne = (name: string) => {
    const path = resolve(directory, name);
    if (!name.endsWith(".json")) {
      // What is left of a write or a clear-out that never finished.
      const written = unlessGone(() => statSync(path).mtimeMs);
      if (written !== null && Date.now() - written > ABANDONED_TEMP_FILE_MS) {
        rmSync(path, { force: true });
      }
      return;
    }
    if (stateOf(path) !== "expired") return;
    const aside = `${path}.${randomBytes(6).toString("hex")}.expired`;
    if (unlessGone(() => renameSync(path, aside)) === null) return;
    if (stateOf(aside) === "current") putBack(aside, path);
    rmSync(aside, { force: true });
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
  return {
    read: async (channelId) => read(pathOf(channelId)),
    write: async (channelId, record) => {
      mkdirSync(directory, { recursive: true });
      tidy();
      const path = pathOf(channelId);
      const pending = `${path}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(pending, JSON.stringify(record), "utf8");
      renameSync(pending, path);
    },
  };
};
