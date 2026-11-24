import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { meetingByRoomCode, updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { hostCalendar, profileForUser } from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { webinarBySlug } from "../server/controlPlane/webinarCommands.js";
import { legacyCalendar, legacyMeeting, legacyProfile, legacyWebinar, type OldMode } from "./support/oldSfu.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

type Row = { id: string; title: string; updatedAt: number; unique?: string; status?: string; room?: string };

type StoreCase = {
  name: string;
  file: string;
  uniqueKey: string;
  encode: (rows: Row[]) => unknown;
  load: (store: ControlPlaneStore) => Promise<Record<string, string>>;
  holder: (store: ControlPlaneStore, unique: string) => Promise<string | null>;
};

const SECRET = "current-secret";

const stores: StoreCase[] = [
  {
    name: "scheduled meetings",
    file: "scheduled-meetings.json",
    uniqueKey: "room code",
    encode: (rows) =>
      rows.map(({ id, title, updatedAt, unique, status }) =>
        legacyMeeting(id, { title, updatedAt, ...(unique ? { roomCode: unique } : {}), ...(status ? { status } : {}) }),
      ),
    load: async (store) =>
      Object.fromEntries((await store.read((view) => view.all("meeting"))).map(({ value }) => [value.id, value.title])),
    holder: async (store, unique) => (await store.read(meetingByRoomCode("conclave", unique)))?.id ?? null,
  },
  {
    name: "scheduled webinars",
    file: "scheduled-webinars.json",
    uniqueKey: "link slug",
    encode: (rows) =>
      rows.map(({ id, title, updatedAt, unique, room }) =>
        legacyWebinar(id, { title, updatedAt, linkSlug: unique ?? `slug-${id}`, roomId: room ?? `room-${id}` }),
      ),
    load: async (store) =>
      Object.fromEntries((await store.read((view) => view.all("webinar"))).map(({ value }) => [value.id, value.title])),
    holder: async (store, unique) => (await store.read(webinarBySlug(unique)))?.id ?? null,
  },
  {
    name: "scheduling records",
    file: "scheduling.json",
    uniqueKey: "host",
    encode: (rows) => ({
      profiles: rows.map(({ id, title, updatedAt, unique }) =>
        legacyProfile(id, { name: title, updatedAt, userId: unique ?? `user-${id}` }),
      ),
      availability: [],
      eventTypes: [],
      calendars: [],
    }),
    load: async (store) =>
      Object.fromEntries((await store.read((view) => view.all("profile"))).map(({ value }) => [value.id, value.name])),
    holder: async (store, unique) => (await store.read(profileForUser("conclave", unique)))?.id ?? null,
  },
];

const modes: OldMode[] = hasRedis ? ["json", "sqlite", "redis"] : ["json", "sqlite"];

let redis: RedisServer | null = null;
let dir = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const opened: ControlPlaneStore[] = [];

const oldStorePath = (store: StoreCase) => join(dir, "json", store.file);
const importDir = () => join(dir, "recordings", "json-fallback-import");
const ARCHIVE = "20261124T000000000Z-sfu-20261124T000000Z-0a1b2c3d";
const copyPath = (store: StoreCase, service = "sfu-a", archive: string | null = ARCHIVE) =>
  archive === null ? join(importDir(), service, store.file) : join(importDir(), service, archive, store.file);

const write = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};

const start = async (): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  opened.push(store);
  return store;
};

const restart = async (store: ControlPlaneStore): Promise<ControlPlaneStore> => {
  opened.splice(opened.indexOf(store), 1);
  await store.close();
  return start();
};

const loaded = async (store: StoreCase) => store.load(await start());

const warnings = () => warn.mock.calls.map((call) => String(call.join(" ")));

const dataRevs = (store: ControlPlaneStore) =>
  store.read((view) =>
    [...view.all("meeting"), ...view.all("webinar"), ...view.all("profile"), ...view.all("calendar")].map((stored) => stored.rev),
  );

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6800);
});

afterAll(() => {
  redis?.stop();
});

const useMode = (mode: OldMode) => {
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  if (mode === "redis") vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-recovered-copies-"));
  mkdirSync(join(dir, "json"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
  vi.stubEnv("SCHEDULING_PATH", join(dir, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "json", "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `recovered:${Date.now()}:${Math.random()}`);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  useMode("json");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(modes)("a %s store after the deploy saved an older SFU's container files", (mode) => {
  beforeEach(() => useMode(mode));

  it.each(stores)("starts with the $name the old SFU kept, once, and marks the copy adopted", async (store) => {
    write(copyPath(store), store.encode([{ id: "kept", title: "Kept", updatedAt: 100 }]));

    const first = await start();
    expect(await store.load(first)).toEqual({ kept: "Kept" });
    expect(existsSync(copyPath(store))).toBe(false);
    expect(existsSync(`${copyPath(store)}.adopted`)).toBe(true);
    const revs = await dataRevs(first);
    const second = await restart(first);
    expect(await store.load(second)).toEqual({ kept: "Kept" });
    expect(await dataRevs(second)).toEqual(revs);
  });
});

describe.each(stores)("an SFU combining the old $name with a container copy", (store) => {
  it("keeps a record saved during a rollback when the old store already holds records", async () => {
    write(oldStorePath(store), store.encode([{ id: "before", title: "Before the rollback", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "during", title: "Saved during the rollback", updatedAt: 200 }]));

    expect(await loaded(store)).toEqual({ before: "Before the rollback", during: "Saved during the rollback" });
  });

  it("keeps the newer edit of a record both hold, whichever has it", async () => {
    write(oldStorePath(store), store.encode([{ id: "a", title: "Older", updatedAt: 100 }, { id: "b", title: "Newer here", updatedAt: 300 }]));
    write(copyPath(store), store.encode([{ id: "a", title: "Newer in the copy", updatedAt: 200 }, { id: "b", title: "Older", updatedAt: 200 }]));

    expect(await loaded(store)).toEqual({ a: "Newer in the copy", b: "Newer here" });
  });

  it("combines two different copies", async () => {
    write(copyPath(store, "sfu-a"), store.encode([{ id: "a", title: "From sfu-a", updatedAt: 100 }]));
    write(copyPath(store, "sfu-b"), store.encode([{ id: "b", title: "From sfu-b", updatedAt: 100 }]));

    expect(await loaded(store)).toEqual({ a: "From sfu-a", b: "From sfu-b" });
  });

  it("keeps the first copy's record and logs it when two copies changed it differently at the same time", async () => {
    write(copyPath(store, "sfu-a"), store.encode([{ id: "a", title: "One edit", updatedAt: 100 }]));
    write(copyPath(store, "sfu-b"), store.encode([{ id: "a", title: "Another edit", updatedAt: 100 }]));

    expect(await loaded(store)).toEqual({ a: "One edit" });
    expect(warnings().some((line) => /legacy \w+ a was changed in the container copy sfu-b\/.* at the same time/.test(line))).toBe(true);
    expect(existsSync(`${copyPath(store, "sfu-a")}.adopted`)).toBe(true);
    expect(existsSync(`${copyPath(store, "sfu-b")}.adopted`)).toBe(true);
  });

  it("keeps the old store's record and logs it when a copy changed it differently at the same time", async () => {
    write(oldStorePath(store), store.encode([{ id: "a", title: "One edit", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "a", title: "Another edit", updatedAt: 100 }]));

    expect(await loaded(store)).toEqual({ a: "One edit" });
    expect(warnings().some((line) => /legacy \w+ a was changed in the container copy sfu-a\/.* at the same time/.test(line))).toBe(true);
  });

  it("changes nothing when the copy holds nothing new", async () => {
    const rows = store.encode([{ id: "a", title: "Same", updatedAt: 100 }]);
    write(oldStorePath(store), rows);
    const first = await start();
    const revs = await dataRevs(first);
    write(copyPath(store), rows);
    const second = await restart(first);

    expect(await store.load(second)).toEqual({ a: "Same" });
    expect(await dataRevs(second)).toEqual(revs);
    expect(existsSync(`${copyPath(store)}.adopted`)).toBe(true);
  });

  it("keeps both records when a copy's record claims the $uniqueKey another holds, and leaves it with the record already in the store", async () => {
    write(oldStorePath(store), store.encode([{ id: "a", title: "First", updatedAt: 100, unique: "shared" }]));
    write(copyPath(store), store.encode([{ id: "b", title: "Second", updatedAt: 200, unique: "shared" }]));

    const started = await start();
    expect(await store.load(started)).toEqual({ a: "First", b: "Second" });
    expect(await store.holder(started, "shared")).toBe("a");
    expect(warnings().some((line) => line.includes("kept without"))).toBe(true);
  });

  it("combines every transfer the deploy saved for one SFU, and copies an older deploy left directly in its folder", async () => {
    write(copyPath(store, "sfu-a", "20261120T000000000Z-first"), store.encode([{ id: "a", title: "First deploy", updatedAt: 100 }]));
    write(copyPath(store, "sfu-a", "20261124T000000000Z-second"), store.encode([{ id: "a", title: "Second deploy", updatedAt: 200 }]));
    write(copyPath(store, "sfu-b", null), store.encode([{ id: "b", title: "Flat copy", updatedAt: 100 }]));

    expect(await loaded(store)).toEqual({ a: "Second deploy", b: "Flat copy" });
    expect(existsSync(`${copyPath(store, "sfu-a", "20261120T000000000Z-first")}.adopted`)).toBe(true);
    expect(existsSync(`${copyPath(store, "sfu-a", "20261124T000000000Z-second")}.adopted`)).toBe(true);
    expect(existsSync(`${copyPath(store, "sfu-b", null)}.adopted`)).toBe(true);
  });

  it("ignores a transfer the deploy left half done", async () => {
    const partial = join(importDir(), ".incoming-sfu-a-20261124T000000000Z-x-0a1b2c3d4e5f", "files", store.file);
    write(partial, store.encode([{ id: "partial", title: "Half sent", updatedAt: 100 }]));

    expect(await loaded(store)).toEqual({});
    expect(existsSync(partial)).toBe(true);
  });
});

describe.each(stores)("an SFU whose saved $name copies it cannot open", (store) => {
  const isRoot = process.getuid?.() === 0;
  const lockedWhile = async (path: string, mode: number, check: () => Promise<void>) => {
    chmodSync(path, mode);
    try {
      await check();
    } finally {
      chmodSync(path, 0o700);
    }
  };

  it.skipIf(isRoot).each([
    ["the import folder", () => importDir(), 0o000],
    ["a service folder", () => join(importDir(), "sfu-a"), 0o000],
    ["an archive folder it can read but not claim in", () => dirname(copyPath(store)), 0o500],
  ] as const)("refuses to start, naming %s and the fix, and changes nothing", async (_label, locked, mode) => {
    write(oldStorePath(store), store.encode([{ id: "live", title: "Live", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "saved", title: "Saved", updatedAt: 100 }]));

    await lockedWhile(locked(), mode, async () => {
      const refusal = start();
      await expect(refusal).rejects.toThrow(/cannot open it \((EACCES|EPERM)\)[\s\S]*chown -R node:node/);
      await expect(refusal).rejects.toThrow(locked());
    });
    expect(existsSync(copyPath(store))).toBe(true);
    expect(readdirSync(dirname(copyPath(store)))).toEqual([store.file]);
    expect(await loaded(store)).toEqual({ live: "Live", saved: "Saved" });
  });

  it.skipIf(isRoot)("starts as usual when only a staging folder it never reads is locked", async () => {
    write(copyPath(store), store.encode([{ id: "saved", title: "Saved", updatedAt: 100 }]));
    const staging = join(importDir(), ".incoming-sfu-a-20261124T000000000Z-sfu-test-deploy-1a2b3c");
    write(join(staging, "files", store.file), store.encode([{ id: "partial", title: "Partial", updatedAt: 100 }]));

    await lockedWhile(staging, 0o000, async () => {
      expect(await loaded(store)).toEqual({ saved: "Saved" });
    });
  });
});

describe("an SFU combining old scheduled meetings with a container copy", () => {
  const meetings = stores[0];

  it("lets an ended or cancelled meeting share a room code with an active one", async () => {
    write(oldStorePath(meetings), meetings.encode([{ id: "active", title: "Active", updatedAt: 100, unique: "shared-code" }]));
    write(copyPath(meetings), meetings.encode([{ id: "done", title: "Cancelled", updatedAt: 100, unique: "shared-code", status: "cancelled" }]));

    const started = await start();
    expect(await meetings.load(started)).toEqual({ active: "Active", done: "Cancelled" });
    expect(await meetings.holder(started, "shared-code")).toBe("active");
    expect(warnings().some((line) => line.includes("kept without"))).toBe(false);
  });

  it("keeps a change made here over a copy the next deploy saved, and logs the record", async () => {
    write(oldStorePath(meetings), meetings.encode([{ id: "a", title: "Imported", updatedAt: 100 }]));
    const first = await start();
    expect((await first.commit(updateMeeting("a", { title: "Changed here" }, { email: null, isAdmin: true }))).ok).toBe(true);
    write(copyPath(meetings), meetings.encode([{ id: "a", title: "Changed in the container", updatedAt: 200 }]));
    const second = await restart(first);

    expect(await meetings.load(second)).toEqual({ a: "Changed here" });
    expect(warnings().some((line) => /legacy meeting a was changed in the container copy sfu-a\/.* and here since it was imported/.test(line))).toBe(true);
  });
});

describe("an SFU combining old scheduling records with a container copy", () => {
  const scheduling = stores[2];
  const withCalendar = (secret: string) => ({
    ...(scheduling.encode([{ id: "p1", title: "Host", updatedAt: 100 }]) as object),
    calendars: [legacyCalendar("p1", secret)],
  });

  it("treats two saves of the same calendar as one record, though their ciphertext differs", async () => {
    write(oldStorePath(scheduling), withCalendar(SECRET));
    write(copyPath(scheduling), withCalendar(SECRET));

    const started = await start();
    expect(await scheduling.load(started)).toEqual({ p1: "Host" });
    expect((await started.read(hostCalendar("p1")))?.refreshToken).toBe("refresh-token-value");
    expect(warnings().some((line) => line.includes("legacy calendar"))).toBe(false);
    expect(existsSync(`${copyPath(scheduling)}.adopted`)).toBe(true);
  });

  it("refuses to start rather than drop calendar tokens it cannot decrypt", async () => {
    write(copyPath(scheduling), withCalendar("the-older-sfus-secret"));

    await expect(start()).rejects.toThrow(/cannot be decrypted/);
    expect(existsSync(copyPath(scheduling))).toBe(true);
  });

  it("refuses to start rather than drop calendar tokens in the old store it cannot decrypt", async () => {
    write(oldStorePath(scheduling), withCalendar("the-older-sfus-secret"));

    await expect(start()).rejects.toThrow(/cannot be decrypted/);
  });
});
