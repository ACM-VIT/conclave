import { runDetached } from "./runDetached.js";
import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dir,
  type Dirent,
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
  temporaryHostUserKey: string | null;
  coHostUserKeys: string[];
  guestPasses: Record<string, string[]>;
  generation?: number;
  passGeneration?: number;
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
  // Lands what `decide` makes of the newest record, as one step: a write that
  // lands first is what `decide` sees. Null from `decide` writes nothing.
  // Says whether it landed.
  update: (
    channelId: string,
    decide: (current: unknown) => RoomRecoveryRecord | null,
  ) => Promise<boolean>;
};

export type LostRoom = {
  hostUserKey: string | null;
  adminUserKeys: string[];
  coHostUserKeys: string[];
  readmissionRequiredUserKeys: string[];
  guestPasses: Record<string, string[]>;
  // After this no pass from the lost call can still be good, so the room is
  // anyone's to open again.
  claimableUntil: number;
  passGeneration: number | null;
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
  | "hostReasons"
  | "guestPassesFor"
> & { ownershipGeneration?: number | null };

type OverRoom = Pick<Room, "channelId" | "incarnationId" | "takesOverRecordOf" | "ownerEmail"> & {
  ownershipGeneration?: number | null;
};

export type RoomRecoveryLedger = {
  noteRunning: (room: LedgerRoom) => void;
  noteOver: (room: OverRoom) => void;
  runningRecord: (room: LedgerRoom) => Readonly<RoomRecoveryRecord>;
  overRecord: (room: OverRoom) => Readonly<RoomRecoveryRecord>;
  saveRecord: (
    room: Pick<Room, "channelId" | "takesOverRecordOf">,
    record: Readonly<RoomRecoveryRecord>,
  ) => Promise<boolean>;
  fence: (
    room: Pick<Room, "channelId" | "incarnationId" | "takesOverRecordOf">,
    generation: number,
    createdBy: string | null,
  ) => Promise<boolean>;
  reclaim: (
    room: Pick<Room, "channelId" | "incarnationId">,
    generation: number,
  ) => Promise<boolean>;
  recall: (channelId: string) => Promise<RecalledRoom>;
};

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringListRecord = (value: unknown): value is Record<string, string[]> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every(isStringList);

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
    temporaryHostUserKey = null,
    coHostUserKeys,
    guestPasses = {},
    generation,
    passGeneration,
  } = raw as Record<string, unknown>;
  if (liveAt !== null && typeof liveAt !== "number") return null;
  if (overAt !== null && typeof overAt !== "number") return null;
  if (typeof writer !== "string") return null;
  if (ownerEmail !== null && typeof ownerEmail !== "string") return null;
  if (temporaryHostUserKey !== null && typeof temporaryHostUserKey !== "string") {
    return null;
  }
  if (hostUserKey !== null && typeof hostUserKey !== "string") return null;
  if (!isStringList(adminUserKeys)) return null;
  if (!isStringList(readmissionRequiredUserKeys)) return null;
  if (coHostUserKeys !== undefined && !isStringList(coHostUserKeys)) return null;
  if (!isStringListRecord(guestPasses)) return null;
  return {
    liveAt,
    hostUserKey,
    adminUserKeys,
    readmissionRequiredUserKeys,
    overAt,
    writer,
    ownerEmail,
    temporaryHostUserKey,
    coHostUserKeys:
      coHostUserKeys ?? adminUserKeys.filter((userKey) => userKey !== temporaryHostUserKey),
    guestPasses,
    ...(typeof generation === "number" ? { generation } : {}),
    ...(typeof passGeneration === "number" ? { passGeneration } : {}),
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
const generationOf = (raw: unknown): number | null => {
  const generation =
    raw && typeof raw === "object" ? (raw as { generation?: unknown }).generation : null;
  return typeof generation === "number" ? generation : null;
};

const writeIfFollowing =
  (record: RoomRecoveryRecord, takesOver: string | null) =>
  (current: unknown): RoomRecoveryRecord | null =>
    mayFollow(current, record, takesOver) ? record : null;

const mayFollow = (
  newest: unknown,
  record: Pick<RoomRecoveryRecord, "writer" | "generation">,
  takesOver: string | null,
): boolean => {
  const newestGeneration = generationOf(newest);
  if (record.generation !== undefined && newestGeneration !== null) {
    if (newestGeneration > record.generation) return false;
    if (newestGeneration < record.generation) return true;
  }
  const last = writerOf(newest);
  return last === null || last === record.writer || last === takesOver;
};

const wasRunningRecently = (liveAt: number | null): liveAt is number =>
  liveAt !== null && Date.now() - liveAt <= LOST_ROOM_WINDOW_MS;

// The cutoff, for as long as a pass signed before it can still be unexpired.
const stillVoids = (overAt: number | null): number | null =>
  overAt !== null && Date.now() - overAt <= ROOM_RECOVERY_PASS_TTL_MS
    ? overAt
    : null;

// Whether a stored record still says anything a recall acts on. One that
// does not parse says nothing.
const stillMatters = (raw: unknown): boolean => {
  const record = parseRoomRecoveryRecord(raw);
  return Boolean(
    record && (wasRunningRecently(record.liveAt) || stillVoids(record.overAt) !== null),
  );
};

// What replaces a record that no longer says anything: the same writer, so
// the same rooms may follow it, and whose code it is. Nothing else.
const tombstoneOf = (raw: unknown): Record<string, unknown> => {
  const record = parseRoomRecoveryRecord(raw);
  const writer = writerOf(raw);
  return {
    liveAt: null,
    hostUserKey: null,
    adminUserKeys: [],
    readmissionRequiredUserKeys: [],
    overAt: null,
    ...(writer === null ? {} : { writer }),
    ownerEmail: record?.ownerEmail ?? null,
    temporaryHostUserKey: null,
    ...(record?.generation === undefined ? {} : { generation: record.generation }),
  };
};
const isTombstone = (raw: unknown): boolean =>
  JSON.stringify(raw) === JSON.stringify(tombstoneOf(raw));

// Rooms this SFU has seen finish, newest last. Such a room never writes
// again, so a room may always take over a record one of them holds.
const FINISHED_ROOMS_KEPT = 10_000;

export const createRoomRecoveryLedger = (
  store: RoomRecoveryStore,
): RoomRecoveryLedger => {
  const finished = new Set<string>();
  const noteFinished = (writer: string) => {
    finished.add(writer);
    if (finished.size > FINISHED_ROOMS_KEPT) {
      const [oldest] = finished;
      finished.delete(oldest);
    }
  };
  // Saves still settling, per code. A recall waits for them.
  const settling = new Map<string, Set<Promise<void>>>();

  // A refused save means another room wrote since this one took the record
  // over. If that room is one this SFU saw finish, this room takes its
  // record over and writes. Otherwise the record belongs to a room still
  // running somewhere, and this room must not write over it: that is loud.
  const retakeOrRefuse = async (
    room: Pick<Room, "channelId" | "takesOverRecordOf">,
    record: RoomRecoveryRecord,
  ): Promise<boolean> => {
    const newest = await store.read(room.channelId);
    const holder = writerOf(newest);
    const newestGeneration = generationOf(newest);
    const outranked =
      record.generation !== undefined &&
      newestGeneration !== null &&
      newestGeneration > record.generation;
    if (!outranked && holder !== null && finished.has(holder)) {
      Logger.warn(
        `Room ${record.writer} takes over the recovery record of ${room.channelId} from ${holder}, a room that finished here`,
      );
      room.takesOverRecordOf = holder;
      if (await store.write(room.channelId, record, holder)) return true;
    }
    Logger.error(
      `Refused to save the recovery record of ${room.channelId}: room ${record.writer} took over ${room.takesOverRecordOf ?? "no record"}, but ${holder ?? "an unreadable record"} has written it since`,
    );
    return false;
  };
  const save = (
    room: Pick<Room, "channelId" | "takesOverRecordOf">,
    record: RoomRecoveryRecord,
  ): Promise<boolean> => {
    const channelId = room.channelId;
    const landing = store
      .write(channelId, record, room.takesOverRecordOf)
      .then((landed) => (landed ? true : retakeOrRefuse(room, record)))
      .catch((error) => {
        Logger.warn(`Failed to update the recovery record of ${channelId}`, error);
        return false;
      });
    const done = landing.then(() => undefined);
    const pending = settling.get(channelId) ?? new Set<Promise<void>>();
    pending.add(done);
    settling.set(channelId, pending);
    void done.then(() => {
      pending.delete(done);
      if (pending.size === 0 && settling.get(channelId) === pending) {
        settling.delete(channelId);
      }
    });
    return landing;
  };

  const runningRecord = (room: LedgerRoom): Readonly<RoomRecoveryRecord> =>
    Object.freeze({
        liveAt: Date.now(),
        hostUserKey: room.hostUserKey,
        adminUserKeys: [...room.adminUserKeys],
        readmissionRequiredUserKeys: room.usersNeedingReadmission,
        overAt: stillVoids(room.recoveryPassesVoidUntil),
        writer: room.incarnationId,
        ownerEmail: room.ownerEmail,
        temporaryHostUserKey:
          [...room.hostReasons].find(([, reason]) => reason === "temporary")?.[0] ?? null,
        coHostUserKeys: [...room.hostReasons]
          .filter(([, reason]) => reason === "cohost")
          .map(([userKey]) => userKey),
        guestPasses: room.guestPassesFor([
          ...room.adminUserKeys,
          ...room.usersNeedingReadmission,
        ]),
        ...(typeof room.ownershipGeneration === "number"
          ? { generation: room.ownershipGeneration, passGeneration: room.ownershipGeneration }
          : {}),
      });
  const overRecord = (room: OverRoom): Readonly<RoomRecoveryRecord> =>
    Object.freeze({
      liveAt: null,
      hostUserKey: null,
      adminUserKeys: [],
      readmissionRequiredUserKeys: [],
      overAt: Date.now(),
      writer: room.incarnationId,
      ownerEmail: room.ownerEmail,
      temporaryHostUserKey: null,
      coHostUserKeys: [],
      guestPasses: {},
      ...(typeof room.ownershipGeneration === "number" ? { generation: room.ownershipGeneration } : {}),
    });
  const saveRecord = (
    room: Pick<Room, "channelId" | "takesOverRecordOf">,
    record: Readonly<RoomRecoveryRecord>,
  ): Promise<boolean> => {
    if (record.liveAt === null && record.overAt !== null) noteFinished(record.writer);
    return save(room, { ...record });
  };

  return {
    runningRecord,
    overRecord,
    saveRecord,
    fence: async (room, generation, createdBy) => {
      await Promise.all([...(settling.get(room.channelId) ?? new Set<Promise<void>>())]);
      return store
        .update(room.channelId, (current) => {
          const fenced = generationOf(current);
          if (fenced !== null && fenced > generation) return null;
          const newest = parseRoomRecoveryRecord(current);
          return newest
            ? { ...newest, writer: room.incarnationId, generation }
            : {
                liveAt: null,
                hostUserKey: null,
                adminUserKeys: [],
                readmissionRequiredUserKeys: [],
                overAt: null,
                writer: room.incarnationId,
                ownerEmail: createdBy,
                temporaryHostUserKey: null,
                coHostUserKeys: [],
                guestPasses: {},
                generation,
              };
        })
        .catch((error) => {
          Logger.error(`Failed to fence the recovery record of ${room.channelId}`, error);
          return false;
        });
    },
    reclaim: async (room, generation) => {
      await Promise.all([...(settling.get(room.channelId) ?? new Set<Promise<void>>())]);
      return store
        .update(room.channelId, (current) => {
          const newest = parseRoomRecoveryRecord(current);
          if (!newest || newest.writer !== room.incarnationId) return null;
          if (newest.generation !== undefined && newest.generation > generation) return null;
          return { ...newest, generation };
        })
        .catch((error) => {
          Logger.error(`Failed to reclaim the recovery record of ${room.channelId}`, error);
          return false;
        });
    },
    noteRunning: (room) => {
      runDetached("Saving the recovery record", () => save(room, runningRecord(room)));
    },
    noteOver: (room) => {
      runDetached("Saving the end of a meeting", () => saveRecord(room, overRecord(room)));
    },
    recall: async (channelId) => {
      await Promise.all([...(settling.get(channelId) ?? new Set<Promise<void>>())]);
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
                coHostUserKeys: record.coHostUserKeys,
                readmissionRequiredUserKeys: record.readmissionRequiredUserKeys,
                guestPasses: record.guestPasses,
                claimableUntil: liveAt + LOST_ROOM_WINDOW_MS,
                passGeneration: record.passGeneration ?? null,
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
  const update: RoomRecoveryStore["update"] = async (channelId, decide) => {
    const next = decide(read(channelId));
    if (!next) return false;
    records.set(channelId, JSON.stringify(next));
    return true;
  };
  return {
    read: async (channelId) => read(channelId),
    write: (channelId, record, takesOver) =>
      update(channelId, writeIfFollowing(record, takesOver)),
    update,
  };
};

const PRUNE_EVERY_MS = 10 * 60 * 1000;
// How many entries of the shared directory a pass looks at besides the rooms
// this SFU wrote: enough to get round, in time, the rooms an SFU that has
// gone left untidy, and few enough that a pass never holds up a call.
const SWEPT_PER_PASS = 200;
const ABANDONED_TEMP_FILE_MS = 60 * 1000;
const TOMBSTONE_KEPT_MS = 90 * 24 * 60 * 60 * 1000;
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
 * Versions are never numbered again, so a room's newest record and its
 * directory are never removed. Tidying removes versions below the newest,
 * which no one reads any more, and replaces a newest that no longer says
 * anything with a tombstone published as the next version, like any write.
 * The tombstone stays, a few bytes for each code ever used, and a room
 * opened at the code later goes on from its number. A write decided on an
 * older version finds its number taken, or a newer one above it, and does
 * not land.
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
  // Publishes `record` as this version, only if no one has: a temp file
  // written in full, then linked into place. Says whether it landed: not if
  // the number was taken, nor if a newer version is there already, which
  // was decided on what came after this write's view.
  const publish = (room: string, version: number, record: unknown): boolean => {
    mkdirSync(room, { recursive: true });
    const pending = resolve(directory, `.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(pending, JSON.stringify(record), "utf8");
    try {
      linkSync(pending, versionPath(room, version));
    } catch (error) {
      // Another SFU took the number first, or cleared out this write's temp
      // file after it stalled.
      if (failedWith(error, "EEXIST", "ENOENT")) return false;
      throw error;
    } finally {
      rmSync(pending, { force: true });
    }
    return versionsIn(room)[0] === version;
  };
  // Says whether the room is settled: it holds a tombstone and nothing else.
  const pruneRoom = (room: string): boolean => {
    const [newest, ...older] = versionsIn(room);
    // A room with no record yet: a write is about to fill it.
    if (newest === undefined) return true;
    for (const version of older) rmSync(versionPath(room, version), { force: true });
    const path = versionPath(room, newest);
    const text = unlessGone(() => readFileSync(path, "utf8"));
    if (text === null) return false;
    const stored = parsedOrUndefined(text);
    if (stillMatters(stored)) return false;
    if (isTombstone(stored)) {
      const standingSince = unlessGone(() => statSync(path).mtimeMs);
      if (standingSince !== null && Date.now() - standingSince > TOMBSTONE_KEPT_MS) {
        rmSync(path, { force: true });
        try {
          rmdirSync(room);
        } catch (error) {
          if (!failedWith(error, "ENOTEMPTY", "EEXIST", "ENOENT")) throw error;
        }
      }
      return true;
    }
    // Once the tombstone is the newest, the record it replaces is below it.
    // Taken by a write that came in meanwhile, it is that write's room.
    if (!publish(room, newest + 1, tombstoneOf(stored))) return false;
    rmSync(path, { force: true });
    return true;
  };
  // Rooms this SFU wrote that are not settled yet.
  const written = new Set<string>();
  // Goes round the shared directory a few entries at a time, so no pass
  // looks at every room ever opened.
  let sweep: Dir | null = null;
  const nextEntries = (count: number): Dirent[] => {
    const entries: Dirent[] = [];
    while (entries.length < count) {
      sweep ??= opendirSync(directory);
      const entry = sweep.readSync();
      if (!entry) {
        sweep.closeSync();
        sweep = null;
        break;
      }
      entries.push(entry);
    }
    return entries;
  };
  // Nothing touches the disk until the first room does.
  let prunedAt = 0;
  const tidy = () => {
    if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    try {
      for (const room of written) if (pruneRoom(room)) written.delete(room);
      for (const entry of nextEntries(SWEPT_PER_PASS)) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          pruneRoom(path);
          continue;
        }
        // What is left of a write that never finished.
        const madeAt = unlessGone(() => statSync(path).mtimeMs);
        if (madeAt !== null && Date.now() - madeAt > ABANDONED_TEMP_FILE_MS) {
          rmSync(path, { force: true });
        }
      }
    } catch (error) {
      const broken = sweep;
      sweep = null;
      void broken?.close().catch(() => undefined);
      Logger.warn(`Failed to clear out old recovery records in ${directory}`, error);
    }
  };
  const update: RoomRecoveryStore["update"] = async (channelId, decide) => {
    mkdirSync(directory, { recursive: true });
    tidy();
    const room = roomOf(channelId);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const newest = newestIn(room);
      const next = decide(newest?.stored ?? null);
      if (!next) return false;
      // Someone wrote first: decide again on what they wrote.
      if (publish(room, (newest?.version ?? 0) + 1, next)) {
        written.add(room);
        return true;
      }
    }
    throw new Error(`Gave up writing the recovery record of ${channelId}`);
  };
  return {
    read: async (channelId) => newestIn(roomOf(channelId))?.stored ?? null,
    write: (channelId, record, takesOver) =>
      update(channelId, writeIfFollowing(record, takesOver)),
    update,
  };
};
