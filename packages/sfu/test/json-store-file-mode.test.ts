import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeeting, createScheduledMeetingPersistence, createScheduledMeetingStore } from "../server/scheduledMeetings.js";
import { createScheduledWebinar, createScheduledWebinarPersistence, createScheduledWebinarStore } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence, createSchedulingStore, ensureSchedulingProfile } from "../server/scheduling.js";

const HOST = { clientId: "conclave", createdBy: "host@example.test", defaultHostEmail: "host@example.test", defaultHostUserId: null };

const stores = [
  {
    name: "scheduled meetings",
    file: "scheduled-meetings.json",
    modeVariable: "SCHEDULED_MEETINGS_PERSISTENCE",
    pathVariable: "SCHEDULED_MEETINGS_PATH",
    save: () => createScheduledMeetingPersistence().save([createScheduledMeeting(createScheduledMeetingStore(), { title: "Private", scheduledStartAt: 1_900_000_000_000 }, HOST)]),
    load: () => createScheduledMeetingPersistence().load(),
    records: (title: string) => [{ ...createScheduledMeeting(createScheduledMeetingStore(), { title, scheduledStartAt: 1_900_000_000_000 }, HOST) }],
  },
  {
    name: "scheduled webinars",
    file: "scheduled-webinars.json",
    modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE",
    pathVariable: "SCHEDULED_WEBINARS_PATH",
    save: () => createScheduledWebinarPersistence().save([createScheduledWebinar(createScheduledWebinarStore(), { title: "Private", scheduledStartAt: 1_900_000_000_000 }, HOST).webinar]),
    load: () => createScheduledWebinarPersistence().load(),
    records: (title: string) => [createScheduledWebinar(createScheduledWebinarStore(), { title, scheduledStartAt: 1_900_000_000_000, linkSlug: `slug-${title.toLowerCase()}` }, HOST).webinar],
  },
  {
    name: "scheduling records",
    file: "scheduling.json",
    modeVariable: "SCHEDULING_PERSISTENCE",
    pathVariable: "SCHEDULING_PATH",
    save: () => createSchedulingPersistence().save({ profiles: [ensureSchedulingProfile(createSchedulingStore(), { clientId: "conclave", userId: "u", email: "h@example.test" })], availability: [], eventTypes: [], calendars: [] }),
    load: () => createSchedulingPersistence().load(),
    records: (title: string) => ({
      profiles: [{ ...ensureSchedulingProfile(createSchedulingStore(), { clientId: "conclave", userId: `user-${title}`, email: `${title}@example.test` }), name: title }],
      availability: [],
      eventTypes: [],
      calendars: [],
    }),
  },
];

let dir = "";
let previousUmask = 0;
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-mode-"));
  previousUmask = process.umask(0o022);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(dir, "recordings", "json-fallback-import"));
  for (const store of stores) {
    vi.stubEnv(store.modeVariable, "json");
    vi.stubEnv(store.pathVariable, join(dir, "recordings", store.file));
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  process.umask(previousUmask);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(stores)("the $name JSON store under umask 022", (store) => {
  const active = () => join(dir, "recordings", store.file);
  const copy = () => join(dir, "recordings", "json-fallback-import", "sfu-a", store.file);

  it("keeps its file readable only by its owner when it saves", async () => {
    await store.save();
    expect(mode(active())).toBe("600");
  });

  it("keeps the combined store and the backup of the old one readable only by their owner", async () => {
    mkdirSync(dirname(active()), { recursive: true });
    writeFileSync(active(), JSON.stringify(store.records("Before")), { mode: 0o644 });
    mkdirSync(dirname(copy()), { recursive: true });
    writeFileSync(copy(), JSON.stringify(store.records("During")), { mode: 0o600 });

    await store.load();

    expect(mode(active())).toBe("600");
    const backups = readdirSync(dirname(active())).filter((name) => name.startsWith(`${store.file}.premerge-`));
    expect(backups.length).toBe(1);
    expect(mode(join(dirname(active()), backups[0]))).toBe("600");
    expect(existsSync(`${copy()}.adopted`)).toBe(true);
    expect(mode(`${copy()}.adopted`)).toBe("600");
  });
});
