import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  // The room (Room.incarnationId) that wrote it.
  writer: string;
  // The signed-in account the code belongs to, which hosts whenever it is
  // there. Null for a code a guest made. Kept when a meeting is over.
  ownerEmail: string | null;
};

/**
 * Where records are kept. A room writes only on top of a record it wrote
 * itself, or of the one it took over when it was created, so a room an SFU
 * has lost track of (a stalled process, another SFU that took the call over)
 * never writes over what the room that took over wrote since.
 */
export type RoomRecoveryStore = {
  // The code's newest record, as stored.
  read: (channelId: string) => Promise<unknown>;
  // Lands `record` only if the newest one was written by `record.writer` or
  // by `takesOver`, or there is none. Says whether it landed.
  write: (
    channelId: string,
    record: RoomRecoveryRecord,
    takesOver: string | null,
  ) => Promise<boolean>;
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
  // Who wrote the newest record. A room created now takes that record over.
  lastWriter: string | null;
  // Whose code it is, if there is a record of it at all.
  owner: { email: string | null } | null;
};

type LedgerRoom = Pick<
  Room,
  | "channelId"
  | "incarnationId"
  | "takesOverRecordOf"
  | "ownerEmail"
  | "hostUserKey"
  | "adminUserKeys"
  | "usersNeedingReadmission"
  | "recoveryPassesVoidUntil"
>;

export type RoomRecoveryLedger = {
  noteRunning: (room: LedgerRoom) => void;
  noteOver: (
    room: Pick<Room, "channelId" | "incarnationId" | "takesOverRecordOf" | "ownerEmail">,
  ) => void;
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
    writer,
    ownerEmail,
  } = raw as Record<string, unknown>;
  if (liveAt !== null && typeof liveAt !== "number") return null;
  if (overAt !== null && typeof overAt !== "number") return null;
  if (typeof writer !== "string") return null;
  if (ownerEmail !== null && typeof ownerEmail !== "string") return null;
  if (hostUserKey !== null && typeof hostUserKey !== "string") return null;
  if (!isStringList(adminUserKeys)) return null;
  if (!isStringList(readmissionRequiredUserKeys)) return null;
  return {
    liveAt,
    hostUserKey,
    adminUserKeys,
    readmissionRequiredUserKeys,
    overAt,
    writer,
    ownerEmail,
  };
};

const writerOf = (raw: unknown): string | null => {
  const writer =
    raw && typeof raw === "object" ? (raw as { writer?: unknown }).writer : null;
  return typeof writer === "string" ? writer : null;
};

// Whether a record written by `writer`, a room that took over the record of
// `takesOver`, may go on top of `newest`. One that names no writer, or does
// not parse, holds nobody back.
const mayFollow = (
  newest: unknown,
  writer: string,
  takesOver: string | null,
): boolean => {
  const last = writerOf(newest);
  return last === null || last === writer || last === takesOver;
};

const wasRunningRecently = (liveAt: number | null): liveAt is number =>
  liveAt !== null && Date.now() - liveAt <= LOST_ROOM_WINDOW_MS;

// The cutoff, for as long as a pass signed before it can still be unexpired.
const stillVoids = (overAt: number | null): number | null =>
  overAt !== null && Date.now() - overAt <= ROOM_RECOVERY_PASS_TTL_MS
    ? overAt
    : null;

// How long a room whose newest record says nothing else keeps that record
// once it stops changing: a day, or a month when it names whose code it is.
const CLEARED_ROOM_KEPT_MS = 24 * 60 * 60 * 1000;
const OWNED_CODE_KEPT_MS = 30 * CLEARED_ROOM_KEPT_MS;

// Whether a room whose newest record is `raw`, unchanged for `unchangedMs`,
// may be cleared out. One that does not parse is not a record at all.
const mayClearOut = (raw: unknown, unchangedMs: number): boolean => {
  const record = parseRoomRecoveryRecord(raw);
  if (!record) return unchangedMs >= CLEARED_ROOM_KEPT_MS;
  if (wasRunningRecently(record.liveAt) || stillVoids(record.overAt) !== null) {
    return false;
  }
  return (
    unchangedMs >= (record.ownerEmail ? OWNED_CODE_KEPT_MS : CLEARED_ROOM_KEPT_MS)
  );
};

export const createRoomRecoveryLedger = (
  store: RoomRecoveryStore,
): RoomRecoveryLedger => {
  const save = (
    room: Pick<Room, "channelId" | "takesOverRecordOf">,
    record: RoomRecoveryRecord,
  ) => {
    store
      .write(room.channelId, record, room.takesOverRecordOf)
      .then((landed) => {
        if (!landed) {
          Logger.warn(
            `Did not update the recovery record of ${room.channelId}: another room has written it since`,
          );
        }
      })
      .catch((error) => {
        Logger.warn(`Failed to update the recovery record of ${room.channelId}`, error);
      });
  };

  return {
    noteRunning: (room) =>
      save(room, {
        liveAt: Date.now(),
        hostUserKey: room.hostUserKey,
        adminUserKeys: [...room.adminUserKeys],
        readmissionRequiredUserKeys: room.usersNeedingReadmission,
        overAt: stillVoids(room.recoveryPassesVoidUntil),
        writer: room.incarnationId,
        ownerEmail: room.ownerEmail,
      }),
    noteOver: (room) =>
      save(room, {
        liveAt: null,
        hostUserKey: null,
        adminUserKeys: [],
        readmissionRequiredUserKeys: [],
        overAt: Date.now(),
        writer: room.incarnationId,
        ownerEmail: room.ownerEmail,
      }),
    recall: async (channelId) => {
      const stored = await store.read(channelId).catch((error) => {
        Logger.warn(`Failed to read the recovery record of ${channelId}`, error);
        return null;
      });
      const record = parseRoomRecoveryRecord(stored);
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
        lastWriter: writerOf(stored),
        owner: record ? { email: record.ownerEmail } : null,
      };
    },
  };
};

export const createMemoryRoomRecoveryStore = (): RoomRecoveryStore => {
  const records = new Map<string, string>();
  const read = (channelId: string): unknown => {
    const stored = records.get(channelId);
    return stored === undefined ? null : JSON.parse(stored);
  };
  return {
    read: async (channelId) => read(channelId),
    write: async (channelId, record, takesOver) => {
      if (!mayFollow(read(channelId), record.writer, takesOver)) return false;
      records.set(channelId, JSON.stringify(record));
      return true;
    },
  };
};

const PRUNE_EVERY_MS = 10 * 60 * 1000;
const ABANDONED_TEMP_FILE_MS = 60 * 1000;
const WRITE_ATTEMPTS = 8;

const roomRecoveryDirectory = (): string => {
  const configured = process.env.SFU_ROOM_RECOVERY_PATH?.trim();
  if (configured) return resolve(configured);
  const recordingStoragePath = process.env.RECORDING_STORAGE_PATH?.trim();
  return recordingStoragePath
    ? resolve(recordingStoragePath, "room-recovery")
    : resolve(process.cwd(), "data", "room-recovery");
};

const failedWith = (error: unknown, ...codes: string[]): boolean =>
  codes.includes((error as NodeJS.ErrnoException | null)?.code ?? "");

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

const parsedOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const VERSION_FILE = /^(\d+)\.json$/;

/**
 * A directory per room in a directory every SFU container on the host
 * shares, holding the room's records as numbered versions. A record is never
 * changed or replaced: a write adds the next version, created only if no one
 * has created that version first, and readers take the highest. So a write
 * that lost a race, or was decided on what has changed since, never lands;
 * the writer looks again and either writes after it or, if another room
 * wrote meanwhile, does not write. No lock, no clock.
 *
 * Tidying removes versions below the newest, which no one reads any more,
 * and a whole room only once its newest record has said nothing for a day
 * (a month, if it names whose code it is).
 */
export const createFileRoomRecoveryStore = (
  directory: string = roomRecoveryDirectory(),
): RoomRecoveryStore => {
  const roomOf = (channelId: string): string =>
    resolve(directory, createHash("sha256").update(channelId).digest("hex"));
  const versionsIn = (room: string): number[] =>
    (unlessGone(() => readdirSync(room)) ?? [])
      .flatMap((name) => {
        const match = VERSION_FILE.exec(name);
        return match ? [Number(match[1])] : [];
      })
      .sort((a, b) => b - a);
  const versionPath = (room: string, version: number): string =>
    join(room, `${version}.json`);
  // The newest version and what it holds. One removed as it is read has a
  // newer one above it, so look again.
  const newestIn = (room: string): { version: number; stored: unknown } | null => {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const [version] = versionsIn(room);
      if (version === undefined) return null;
      const text = unlessGone(() => readFileSync(versionPath(room, version), "utf8"));
      if (text !== null) return { version, stored: parsedOrUndefined(text) };
    }
    throw new Error(`Could not read the newest recovery record in ${room}`);
  };
  const pruneRoom = (room: string) => {
    const [newest, ...older] = versionsIn(room);
    if (newest === undefined) {
      try {
        rmdirSync(room);
      } catch (error) {
        if (!failedWith(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
      }
      return;
    }
    for (const version of older) rmSync(versionPath(room, version), { force: true });
    // Until then the record still fences off writes from rooms before it.
    const path = versionPath(room, newest);
    const written = unlessGone(() => statSync(path).mtimeMs);
    if (written === null || Date.now() - written < CLEARED_ROOM_KEPT_MS) return;
    const text = unlessGone(() => readFileSync(path, "utf8"));
    if (text === null || !mayClearOut(parsedOrUndefined(text), Date.now() - written)) {
      return;
    }
    rmSync(path, { force: true });
    try {
      rmdirSync(room);
    } catch (error) {
      // A write has come in since: the room stays.
      if (!failedWith(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error;
    }
  };
  // Nothing touches the disk until the first room does.
  let prunedAt = 0;
  const tidy = () => {
    if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          pruneRoom(path);
          continue;
        }
        // What is left of a write that never finished.
        const written = unlessGone(() => statSync(path).mtimeMs);
        if (written !== null && Date.now() - written > ABANDONED_TEMP_FILE_MS) {
          rmSync(path, { force: true });
        }
      }
    } catch (error) {
      Logger.warn(`Failed to clear out old recovery records in ${directory}`, error);
    }
  };
  return {
    read: async (channelId) => newestIn(roomOf(channelId))?.stored ?? null,
    write: async (channelId, record, takesOver) => {
      mkdirSync(directory, { recursive: true });
      tidy();
      const room = roomOf(channelId);
      let pending: string | null = null;
      try {
        for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
          const newest = newestIn(room);
          if (newest && !mayFollow(newest.stored, record.writer, takesOver)) {
            return false;
          }
          mkdirSync(room, { recursive: true });
          if (pending === null) {
            pending = resolve(directory, `.${randomBytes(6).toString("hex")}.tmp`);
            writeFileSync(pending, JSON.stringify(record), "utf8");
          }
          try {
            linkSync(pending, versionPath(room, (newest?.version ?? 0) + 1));
            return true;
          } catch (error) {
            // Someone created that version first, or the room was just
            // cleared out: look again.
            if (!failedWith(error, "EEXIST", "ENOENT")) throw error;
          }
        }
        throw new Error(`Gave up writing the recovery record of ${channelId}`);
      } finally {
        if (pending !== null) rmSync(pending, { force: true });
      }
    },
  };
};
