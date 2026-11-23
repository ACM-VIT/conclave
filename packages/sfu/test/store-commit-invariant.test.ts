import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Fails one JSON store write on demand, the way a full disk would.
const jsonFailure = vi.hoisted(() => ({ under: "", armed: false, injected: false }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (jsonFailure.armed && jsonFailure.under && String(args[0]).startsWith(jsonFailure.under)) {
        jsonFailure.armed = false;
        jsonFailure.injected = true;
        throw Object.assign(new Error(`EIO: i/o error, write '${String(args[0])}'`), { code: "EIO" });
      }
      fs.writeFileSync(...args);
    },
  };
});

import type { ScheduledMeeting } from "../types.js";
import { initScheduledMeetings, initScheduledWebinars } from "../server/init.js";
import { LocalRoomRegistry } from "../server/roomRegistry.js";
import {
  changeMeetings,
  createRedisScheduledMeetingPersistence,
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createSqliteScheduledMeetingPersistence,
  deleteScheduledMeeting,
  type ScheduledMeetingPersistence,
  type ScheduledMeetingStore,
  updateScheduledMeeting,
} from "../server/scheduledMeetings.js";
import { changeWebinars, deleteScheduledWebinar } from "../server/scheduledWebinars.js";
import { createRedisSchedulingPersistence, createSchedulingPersistence, createSqliteSchedulingPersistence } from "../server/scheduling.js";
import { sendDueSchedulingEmailReminders } from "../server/schedulingEmailReminders.js";
import { readStampedJson } from "../server/stampedJsonFile.js";
import { createSfuState, type SfuState } from "../server/state.js";
import { hasRedis, startRedis } from "./support/redisServer.js";

type Mode = "sqlite" | "json" | "redis";
type Step = "none" | "sqlite" | "json" | "redis" | "mirror";
type Operation = "create" | "update" | "delete" | "reminder claim" | "recovery file, then delete";

const STEPS: Record<Mode, Step[]> = {
  sqlite: ["none", "sqlite"],
  json: ["none", "json"],
  redis: ["none", "redis", "mirror"],
};
const OPERATIONS: Operation[] = ["create", "update", "delete", "reminder claim", "recovery file, then delete"];
const EMAIL_WORKER = "https://email-worker.example.test";
const HOST = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

let redis: { url: string; stop: () => void } | null = null;
let raw: ReturnType<typeof createClient> | null = null;
let stateDir = "";
let prefix = "";
let caseNumber = 0;
let armed: Step = "none";
let injected = false;
const open: ScheduledMeetingPersistence[] = [];

const sqlitePath = () => join(stateDir, "conclave.sqlite");
const jsonPath = () => join(stateDir, "json", "scheduled-meetings.json");

/** Makes the next write through `methods` fail once while `step` is armed. */
const failingOnce = <T extends object>(store: T, step: Step, methods: string[]): T => {
  for (const method of methods) {
    const target = store as Record<string, (...args: unknown[]) => unknown>;
    if (typeof target[method] !== "function") continue;
    const original = target[method].bind(store);
    target[method] = (...args: unknown[]) => {
      if (armed === step) {
        armed = "none";
        injected = true;
        return Promise.reject(new Error(`injected ${step} failure`));
      }
      return original(...args);
    };
  }
  return store;
};

const openPersistence = (mode: Mode): ScheduledMeetingPersistence => {
  const sqlite = () => createSqliteScheduledMeetingPersistence(sqlitePath());
  const persistence =
    mode === "sqlite"
      ? failingOnce(sqlite(), "sqlite", ["saveChanged", "importIfNewer"])
      : mode === "json"
        ? createScheduledMeetingPersistence()
        : createRedisScheduledMeetingPersistence(redis!.url, prefix, failingOnce(sqlite(), "mirror", ["saveChanged", "importIfNewer", "syncFrom"]));
  open.push(persistence);
  return persistence;
};

const startState = async (mode: Mode): Promise<SfuState> => {
  const state = createSfuState({
    roomRegistry: new LocalRoomRegistry({ instanceId: `invariant-${caseNumber}`, instanceUrl: "http://localhost", ttlMs: 45000 }),
  });
  await initScheduledMeetings(state, openPersistence(mode));
  return state;
};

const SCRIPT_COMMANDS = ["eval", "evalsha", "eval_ro", "evalsha_ro"];

/**
 * Runs work with the failure armed. Redis refuses every script while armed,
 * before the script writes anything, the way a lost connection would; the
 * other steps fail their next write once.
 */
const withFailure = async (step: Step, work: () => unknown): Promise<boolean> => {
  armed = step;
  jsonFailure.armed = step === "json";
  if (step === "redis") await raw!.sendCommand(["ACL", "SETUSER", "default", ...SCRIPT_COMMANDS.map((name) => `-${name}`)]);
  try {
    await work();
    return false;
  } catch {
    return true;
  } finally {
    if (step === "redis") await raw!.sendCommand(["ACL", "SETUSER", "default", ...SCRIPT_COMMANDS.map((name) => `+${name}`)]);
    armed = "none";
    jsonFailure.armed = false;
  }
};

type View = Record<string, { title: string; status: string; startAt: number; reminder: string | null }>;

const viewOf = (records: Array<Partial<ScheduledMeeting>>): View =>
  Object.fromEntries(
    records
      .map((record) => [
        String(record.id),
        {
          title: String(record.title),
          status: String(record.status),
          startAt: Number(record.scheduledStartAt),
          reminder: record.emailReminderStatus ?? null,
        },
      ] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const sqliteRows = (): { records: View; deleted: string[] } => {
  const db = new DatabaseSync(sqlitePath());
  try {
    const records = (db.prepare("SELECT payload_json FROM scheduled_meetings").all() as Array<{ payload_json: string }>).map(
      (row) => JSON.parse(row.payload_json) as ScheduledMeeting,
    );
    const deleted = (db.prepare("SELECT id FROM scheduled_meeting_tombstones").all() as Array<{ id: string }>).map((row) => row.id);
    return { records: viewOf(records), deleted: deleted.sort() };
  } finally {
    db.close();
  }
};

/** What the mode's authority holds, read raw so the read itself repairs nothing. */
const authority = async (mode: Mode): Promise<{ records: View; deleted: string[] }> => {
  if (mode === "sqlite") return sqliteRows();
  if (mode === "json") {
    const stored = readStampedJson(jsonPath(), (entry) => entry as ScheduledMeeting);
    return { records: viewOf(stored.records), deleted: [...stored.deletedAt.keys()].sort() };
  }
  const values = await raw!.hVals(`${prefix}:scheduled-meetings`);
  const tombstones = await raw!.hGetAll(`${prefix}:scheduled-meetings:tombstones`);
  return { records: viewOf(values.map((value) => JSON.parse(value) as ScheduledMeeting)), deleted: Object.keys(tombstones).sort() };
};

const memoryOf = (store: ScheduledMeetingStore) => ({
  records: viewOf([...store.byId.values()]),
  deleted: [...store.deletedAt.keys()].sort(),
});

const bookingDueForReminder = (draft: ScheduledMeetingStore, id: string, now: number): ScheduledMeeting => {
  const meeting = createScheduledMeeting(
    draft,
    {
      title: id,
      scheduledStartAt: now + 10 * 60_000,
      scheduledEndAt: now + 40 * 60_000,
      source: "booking_link",
      attendeeName: "Guest",
      attendeeEmail: "guest@example.test",
    },
    HOST,
  );
  meeting.createdAt = now - 2 * 3_600_000;
  return meeting;
};

/** A JSON file an older SFU left behind, as the deploy copies it in. */
const writeRecoveryFile = (records: unknown[]): void => {
  const dir = join(stateDir, "import", "sfu-old");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scheduled-meetings.json"), JSON.stringify(records));
};

const workerCalls = (fetchSpy: { mock: { calls: Array<Parameters<typeof fetch>> } }) =>
  fetchSpy.mock.calls.filter(([input]) => (input instanceof Request ? input.url : String(input)).startsWith(EMAIL_WORKER)).length;

const closeAll = async (): Promise<void> => {
  for (const persistence of open.splice(0)) await persistence.close?.();
};

beforeAll(async () => {
  if (!hasRedis) return;
  redis = await startRedis(6480);
  const setup = createClient({ url: redis.url });
  await setup.connect();
  await setup.sendCommand(["ACL", "SETUSER", "invariant-admin", "on", ">invariant-admin", "~*", "&*", "+@all"]);
  await setup.quit();
  raw = createClient({ url: redis.url, username: "invariant-admin", password: "invariant-admin" });
  raw.on("error", () => {});
  await raw.connect();
});

afterAll(async () => {
  await raw?.quit();
  redis?.stop();
});

beforeEach(() => {
  caseNumber += 1;
  injected = false;
  jsonFailure.injected = false;
  stateDir = mkdtempSync(join(tmpdir(), "sfu-commit-invariant-"));
  prefix = `invariant:${caseNumber}:${Date.now()}`;
  jsonFailure.under = join(stateDir, "json");
  vi.stubEnv("CONCLAVE_SQLITE_PATH", sqlitePath());
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", jsonPath());
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(stateDir, "import"));
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_URL", EMAIL_WORKER);
  vi.stubEnv("SCHEDULING_EMAIL_WORKER_SECRET", "email-secret");
  vi.stubEnv("SFU_FOLLOW_UP_RETRY_DELAYS_MS", "600000");
  for (const variable of ["SCHEDULED_MEETINGS_SQLITE_PATH", "RECORDING_STORAGE_PATH", "REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  await closeAll();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

const cases = (Object.keys(STEPS) as Mode[]).flatMap((mode) =>
  OPERATIONS.flatMap((operation) => STEPS[mode].map((step) => ({ mode, operation, step }))),
);

describe("a failure at any write step", () => {
  it.each(cases)("leaves memory, disk and Redis in agreement: $mode, $operation, failing at $step", async ({ mode, operation, step }) => {
    if (mode === "redis" && !hasRedis) return;
    vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", mode);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const now = Date.now();

    let state = await startState(mode);
    await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [], (draft) =>
      bookingDueForReminder(draft, "baseline", now),
    );
    const baseline = [...state.scheduledMeetings.byId.values()][0];

    let deletedRecovered = false;
    if (operation === "recovery file, then delete") {
      const recovered = { ...baseline, id: "recovered", roomCode: "recovered-room", title: "recovered", updatedAt: now - 1 };
      writeRecoveryFile([recovered, { id: "broken" }]);
      await closeAll();
      await withFailure(step, async () => {
        state = await startState(mode);
      });
      if (state.scheduledMeetings.byId.has("recovered")) {
        await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, ["recovered"], (draft) =>
          deleteScheduledMeeting(draft, "recovered"),
        );
        deletedRecovered = true;
      }
    } else {
      const failed = await withFailure(step, async () => {
        if (operation === "create") {
          await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [], (draft) =>
            createScheduledMeeting(draft, { title: "created", scheduledStartAt: now + 3_600_000 }, HOST),
          );
        } else if (operation === "update") {
          await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [baseline.id], (draft) =>
            updateScheduledMeeting(draft, baseline.id, { title: "updated" }),
          );
        } else if (operation === "delete") {
          await changeMeetings(state.scheduledMeetings, state.scheduledMeetingPersistence, [baseline.id], (draft) =>
            deleteScheduledMeeting(draft, baseline.id),
          );
        } else {
          await sendDueSchedulingEmailReminders(state, now);
        }
      });
      if (operation !== "reminder claim") expect(failed).toBe(step === "sqlite" || step === "json" || step === "redis");
    }
    if (step === "sqlite" || step === "json" || step === "mirror") expect(injected || jsonFailure.injected).toBe(true);

    const before = memoryOf(state.scheduledMeetings);
    expect(before).toEqual(await authority(mode));
    if (operation === "reminder claim") {
      const reminder = before.records[baseline.id]?.reminder;
      expect(reminder).not.toBe("pending");
      expect(workerCalls(fetchSpy)).toBe(reminder === "sent" ? 1 : 0);
    }

    await closeAll();
    const restarted = await startState(mode);
    const after = memoryOf(restarted.scheduledMeetings);
    expect(after).toEqual(await authority(mode));
    if (operation !== "recovery file, then delete") expect(after).toEqual(before);
    if (deletedRecovered) expect(after.records.recovered).toBeUndefined();
    if (mode === "redis") expect(sqliteRows()).toEqual(await authority(mode));
  });
});

const webinarRecord = (id: string, updatedAt: number) => ({
  id, clientId: "conclave", roomId: `${id}-room`, linkSlug: `${id}-room`, title: id, description: "", hostEmail: "host@example.test",
  hostName: "", hostUserId: null, coHosts: [], scheduledStartAt: Date.now() + 3_600_000, scheduledEndAt: Date.now() + 7_200_000,
  status: "scheduled", publicAccess: true, maxAttendees: 500, requiresInviteCode: false, waitingRoomEnabled: true,
  earlyEntryMinutes: 10, qaEnabled: true, notes: "", createdAt: 1, createdBy: "", updatedAt, liveStartedAt: null, endedAt: null,
  totalJoinCount: 0, peakAttendeeCount: 0, coHostInviteTokenHash: null, coHostInviteTokenCreatedAt: null,
});

describe("a JSON store", () => {
  it("keeps a webinar the host deleted deleted when its recovery file is imported again", async () => {
    vi.stubEnv("SCHEDULED_WEBINARS_PERSISTENCE", "json");
    vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(stateDir, "json", "scheduled-webinars.json"));
    const dir = join(stateDir, "import", "sfu-old");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "scheduled-webinars.json"), JSON.stringify([webinarRecord("recovered", 5), { id: "broken" }]));
    const start = async () => {
      const state = createSfuState({ roomRegistry: new LocalRoomRegistry({ instanceId: "webinars", instanceUrl: "http://localhost", ttlMs: 45000 }) });
      await initScheduledWebinars(state);
      return state;
    };

    const first = await start();
    expect(first.scheduledWebinars.byId.has("recovered")).toBe(true);
    await changeWebinars(first.scheduledWebinars, first.scheduledWebinarPersistence, ["recovered"], (draft) =>
      deleteScheduledWebinar(draft, "recovered"),
    );

    const second = await start();
    expect(second.scheduledWebinars.byId.has("recovered")).toBe(false);
    expect([...second.scheduledWebinars.deletedAt.keys()]).toEqual(["recovered"]);
  });

  it("refuses a scheduling import older than the deletion it saved", async () => {
    vi.stubEnv("SCHEDULING_PERSISTENCE", "json");
    vi.stubEnv("SCHEDULING_PATH", join(stateDir, "json", "scheduling.json"));
    const persistence = createSchedulingPersistence();
    await persistence.save({ profiles: [], availability: [], eventTypes: [], calendars: [], deleted: [{ kind: "event_type", id: "gone", deletedAt: 50 }] });

    const stale = { kind: "event_type" as const, id: "gone", clientId: "conclave", updatedAt: 40, payload: { id: "gone", profileId: "host", updatedAt: 40 } };
    expect(await persistence.importIfNewer(stale)).toBe(false);
    expect((await persistence.load()).eventTypes).toEqual([]);
  });
});

describe.skipIf(!hasRedis)("a scheduling save in Redis mode", () => {
  const profileRecord = (id: string, updatedAt: number) => ({
    id, clientId: "conclave", userId: `user-${id}`, email: `${id}@example.test`, name: id, username: id, timeZone: "UTC", createdAt: 1, updatedAt,
  });
  const mirrorProfiles = (): string[] => {
    const db = new DatabaseSync(sqlitePath());
    try {
      return (db.prepare("SELECT id FROM scheduling_records WHERE kind = 'profile' ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    } finally {
      db.close();
    }
  };
  const redisProfiles = async (): Promise<string[]> => (await raw!.hKeys(`${prefix}:scheduling:profiles`)).sort();
  const open = () => {
    const mirror = failingOnce(createSqliteSchedulingPersistence(sqlitePath()), "mirror", ["save", "importIfNewer", "syncFrom"]);
    const persistence = createRedisSchedulingPersistence(redis!.url, prefix, mirror);
    closers.push(() => persistence.close?.());
    return persistence;
  };
  const closers: Array<() => unknown> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it("leaves nothing on disk when Redis refuses it", async () => {
    const persistence = open();
    await persistence.load();
    const failed = await withFailure("redis", () => persistence.save({ profiles: [profileRecord("refused", 5)], availability: [], eventTypes: [], calendars: [] }));

    expect(failed).toBe(true);
    expect([await redisProfiles(), mirrorProfiles()]).toEqual([[], []]);
  });

  it("commits when only the mirror fails, and rebuilds the mirror on the next write", async () => {
    const persistence = open();
    await persistence.load();
    const failed = await withFailure("mirror", () => persistence.save({ profiles: [profileRecord("first", 5)], availability: [], eventTypes: [], calendars: [] }));
    expect([failed, injected]).toEqual([false, true]);
    expect([await redisProfiles(), mirrorProfiles()]).toEqual([["first"], []]);

    await persistence.save({ profiles: [profileRecord("second", 6)], availability: [], eventTypes: [], calendars: [] });
    expect([await redisProfiles(), mirrorProfiles()]).toEqual([["first", "second"], ["first", "second"]]);
  });
});
