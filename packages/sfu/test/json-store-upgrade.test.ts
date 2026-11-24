import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
} from "../server/scheduledMeetings.js";
import {
  createScheduledWebinar,
  createScheduledWebinarPersistence,
  createScheduledWebinarStore,
} from "../server/scheduledWebinars.js";
import { createSchedulingPersistence, createSchedulingStore, ensureSchedulingProfile } from "../server/scheduling.js";

type Record = { id: string; title: string; updatedAt: number; unique?: string };

type Store = {
  name: string;
  file: string;
  modeVariable: string;
  pathVariable: string;
  uniqueKey: string | null;
  encode: (records: Record[]) => unknown;
  load: () => Promise<Record[]>;
};

const later = Date.now() + 86_400_000;
const HOST = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

const meetingTemplate = () =>
  createScheduledMeeting(createScheduledMeetingStore(), { title: "template", scheduledStartAt: later }, HOST);
const webinarTemplate = () =>
  createScheduledWebinar(createScheduledWebinarStore(), { title: "template", scheduledStartAt: later, linkSlug: "template-slug" }, HOST).webinar;

const stores: Store[] = [
  {
    name: "scheduled meetings",
    file: "scheduled-meetings.json",
    modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE",
    pathVariable: "SCHEDULED_MEETINGS_PATH",
    uniqueKey: null,
    encode: (records) => records.map(({ id, title, updatedAt }) => ({ ...meetingTemplate(), id, title, updatedAt })),
    load: async () =>
      (await createScheduledMeetingPersistence().load()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  },
  {
    name: "scheduled webinars",
    file: "scheduled-webinars.json",
    modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE",
    pathVariable: "SCHEDULED_WEBINARS_PATH",
    uniqueKey: "link slug",
    encode: (records) =>
      records.map(({ id, title, updatedAt, unique }) => ({ ...webinarTemplate(), id, title, updatedAt, linkSlug: unique ?? `slug-${id}` })),
    load: async () => createScheduledWebinarPersistence().load().map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  },
  {
    name: "scheduling records",
    file: "scheduling.json",
    modeVariable: "SCHEDULING_PERSISTENCE",
    pathVariable: "SCHEDULING_PATH",
    uniqueKey: "host",
    encode: (records) => ({
      profiles: records.map(({ id, title, updatedAt, unique }) => ({
        ...ensureSchedulingProfile(createSchedulingStore(), { clientId: "conclave", userId: unique ?? `user-${id}`, email: `${id}@example.test` }),
        id,
        name: title,
        username: `host-${id}`,
        updatedAt,
      })),
      availability: [],
      eventTypes: [],
      calendars: [],
    }),
    load: async () =>
      (await createSchedulingPersistence().load()).profiles.map(({ id, name, updatedAt }) => ({ id, title: name, updatedAt })),
  },
];

let dir = "";
const activePath = (store: Store) => join(dir, "recordings", store.file);
const importDir = () => join(dir, "recordings", "json-fallback-import");
const copyPath = (store: Store, service = "sfu-a") => join(importDir(), service, store.file);

const write = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
};

const byId = (records: Record[]) => Object.fromEntries(records.map((record) => [record.id, record.title]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-upgrade-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
  for (const store of stores) {
    vi.stubEnv(store.modeVariable, "json");
    vi.stubEnv(store.pathVariable, activePath(store));
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(stores)("an SFU in explicit JSON mode with $name from an older image", (store) => {
  it("starts with the records the old SFU kept, from the copy the deploy saved", async () => {
    write(copyPath(store), store.encode([{ id: "kept", title: "Kept", updatedAt: 100 }]));

    expect(byId(await store.load())).toEqual({ kept: "Kept" });
    expect(existsSync(copyPath(store))).toBe(false);
    expect(existsSync(`${copyPath(store)}.adopted`)).toBe(true);
    expect(byId(await store.load())).toEqual({ kept: "Kept" });
  });

  it("keeps a record saved during a rollback when its own store already holds records", async () => {
    write(activePath(store), store.encode([{ id: "before", title: "Before the rollback", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "during", title: "Saved during the rollback", updatedAt: 200 }]));

    expect(byId(await store.load())).toEqual({ before: "Before the rollback", during: "Saved during the rollback" });
    expect(readdirSync(dirname(activePath(store))).some((name) => name.startsWith(`${store.file}.premerge-`))).toBe(true);
  });

  it("keeps the newer edit of a record both stores hold, whichever store has it", async () => {
    write(activePath(store), store.encode([{ id: "a", title: "Older", updatedAt: 100 }, { id: "b", title: "Newer here", updatedAt: 300 }]));
    write(copyPath(store), store.encode([{ id: "a", title: "Newer in the copy", updatedAt: 200 }, { id: "b", title: "Older", updatedAt: 200 }]));

    expect(byId(await store.load())).toEqual({ a: "Newer in the copy", b: "Newer here" });
  });

  it("combines two different copies when its own store is missing", async () => {
    write(copyPath(store, "sfu-a"), store.encode([{ id: "a", title: "From sfu-a", updatedAt: 100 }]));
    write(copyPath(store, "sfu-b"), store.encode([{ id: "b", title: "From sfu-b", updatedAt: 100 }]));

    expect(byId(await store.load())).toEqual({ a: "From sfu-a", b: "From sfu-b" });
  });

  it("refuses to start when both stores changed a record differently at the same time", async () => {
    write(activePath(store), store.encode([{ id: "a", title: "One edit", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "a", title: "Another edit", updatedAt: 100 }]));

    await expect(store.load()).rejects.toThrow(/differs between/);
    expect(existsSync(copyPath(store))).toBe(true);
  });

  it("leaves its own store as it is when the copy holds nothing new", async () => {
    const records = store.encode([{ id: "a", title: "Same", updatedAt: 100 }]);
    write(activePath(store), records);
    write(copyPath(store), records);

    expect(byId(await store.load())).toEqual({ a: "Same" });
    expect(readdirSync(dirname(activePath(store))).some((name) => name.includes(".premerge-"))).toBe(false);
    expect(existsSync(`${copyPath(store)}.adopted`)).toBe(true);
  });
});

describe.each(stores.filter((store) => store.uniqueKey))("an SFU in explicit JSON mode combining $name", (store) => {
  it("refuses to start when two records would claim the same $uniqueKey", async () => {
    write(activePath(store), store.encode([{ id: "a", title: "First", updatedAt: 100, unique: "shared" }]));
    write(copyPath(store), store.encode([{ id: "b", title: "Second", updatedAt: 100, unique: "shared" }]));

    await expect(store.load()).rejects.toThrow(/both claim/);
  });
});
