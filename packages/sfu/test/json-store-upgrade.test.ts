import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type Store = {
  name: string;
  file: string;
  modeVariable: string;
  pathVariable: string;
  writeOldStore: () => Promise<void>;
  load: () => Promise<number>;
};

const later = Date.now() + 86_400_000;

const stores: Store[] = [
  {
    name: "scheduled meetings",
    file: "scheduled-meetings.json",
    modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE",
    pathVariable: "SCHEDULED_MEETINGS_PATH",
    writeOldStore: async () => {
      const store = createScheduledMeetingStore();
      createScheduledMeeting(store, { title: "Kept across the upgrade", scheduledStartAt: later }, {
        clientId: "conclave",
        createdBy: "host@example.test",
        defaultHostEmail: "host@example.test",
        defaultHostUserId: null,
      });
      await createScheduledMeetingPersistence().save([...store.byId.values()]);
    },
    load: async () => (await createScheduledMeetingPersistence().load()).length,
  },
  {
    name: "scheduled webinars",
    file: "scheduled-webinars.json",
    modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE",
    pathVariable: "SCHEDULED_WEBINARS_PATH",
    writeOldStore: async () => {
      const store = createScheduledWebinarStore();
      createScheduledWebinar(store, { title: "Kept across the upgrade", scheduledStartAt: later, linkSlug: "kept-launch" }, {
        clientId: "conclave",
        createdBy: "host@example.test",
        defaultHostEmail: "host@example.test",
      });
      createScheduledWebinarPersistence().save([...store.byId.values()]);
    },
    load: async () => createScheduledWebinarPersistence().load().length,
  },
  {
    name: "scheduling records",
    file: "scheduling.json",
    modeVariable: "SCHEDULING_PERSISTENCE",
    pathVariable: "SCHEDULING_PATH",
    writeOldStore: async () => {
      const profile = ensureSchedulingProfile(createSchedulingStore(), {
        clientId: "conclave",
        userId: "host-user",
        email: "host@example.test",
      });
      await createSchedulingPersistence().save({ profiles: [profile], availability: [], eventTypes: [], calendars: [] });
    },
    load: async () => {
      const snapshot = await createSchedulingPersistence().load();
      return snapshot.profiles.length + snapshot.availability.length + snapshot.eventTypes.length + snapshot.calendars.length;
    },
  },
];

let dir = "";
const oldPath = (store: Store) => join(dir, "old-container", "data", store.file);
const activePath = (store: Store) => join(dir, "recordings", store.file);
const importDir = () => join(dir, "recordings", "json-fallback-import");
const recoveredPath = (store: Store, service = "sfu-a") => join(importDir(), service, store.file);

const writeRecoveredCopy = async (store: Store, service = "sfu-a") => {
  vi.stubEnv(store.pathVariable, oldPath(store));
  await store.writeOldStore();
  mkdirSync(join(importDir(), service), { recursive: true });
  copyFileSync(oldPath(store), recoveredPath(store, service));
  vi.stubEnv(store.pathVariable, activePath(store));
};

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

describe.each(stores)("an SFU in explicit JSON mode upgraded from an image that kept $name in its container", (store) => {
  it("starts with the records the old SFU had, from the copy the deploy saved", async () => {
    await writeRecoveredCopy(store);
    expect(existsSync(activePath(store))).toBe(false);

    expect(await store.load()).toBe(1);
    expect(existsSync(activePath(store))).toBe(true);
    expect(existsSync(recoveredPath(store))).toBe(false);
    expect(existsSync(`${recoveredPath(store)}.adopted`)).toBe(true);
    expect(await store.load()).toBe(1);
  });

  it("refuses to start with an empty store while an old store it has not adopted exists", async () => {
    await writeRecoveredCopy(store);
    mkdirSync(join(dir, "recordings"), { recursive: true });
    writeFileSync(activePath(store), store.file === "scheduling.json" ? JSON.stringify({ profiles: [], availability: [], eventTypes: [], calendars: [] }) : "[]");

    await expect(store.load()).rejects.toThrow(/holds no records/);
  });

  it("refuses to start when two different old stores were saved", async () => {
    await writeRecoveredCopy(store, "sfu-a");
    await writeRecoveredCopy(store, "sfu-b");

    await expect(store.load()).rejects.toThrow(/different/);
    expect(existsSync(activePath(store))).toBe(false);
  });

  it("leaves an active store that already holds records alone", async () => {
    await writeRecoveredCopy(store);
    vi.stubEnv(store.pathVariable, activePath(store));
    mkdirSync(join(dir, "recordings"), { recursive: true });
    copyFileSync(recoveredPath(store), activePath(store));

    expect(await store.load()).toBe(1);
    expect(existsSync(recoveredPath(store))).toBe(true);
  });
});
