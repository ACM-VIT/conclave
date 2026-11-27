import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  scheduledMeetingJsonStore,
} from "../server/scheduledMeetings.js";
import {
  createScheduledWebinar,
  createScheduledWebinarPersistence,
  createScheduledWebinarStore,
  scheduledWebinarJsonStore,
} from "../server/scheduledWebinars.js";
import {
  clearGoogleCalendarConnection,
  createEventType,
  createSchedulingPersistence,
  createSchedulingStore,
  deleteEventType,
  ensureSchedulingProfile,
  schedulingJsonStore,
  setGoogleCalendarConnection,
} from "../server/scheduling.js";
import type { SchedulingCalendarConnection } from "../types.js";

type Record = { id: string; title: string; updatedAt: number; unique?: string; status?: string; room?: string };

type Store = {
  name: string;
  file: string;
  modeVariable: string;
  pathVariable: string;
  uniqueKey: string;
  recordsCanBeDeleted: boolean;
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
    uniqueKey: "room code",
    recordsCanBeDeleted: true,
    encode: (records) =>
      records.map(({ id, title, updatedAt, unique, status }) => ({
        ...meetingTemplate(),
        id,
        title,
        updatedAt,
        ...(unique ? { roomCode: unique } : {}),
        ...(status ? { status } : {}),
      })),
    load: async () =>
      (await createScheduledMeetingPersistence().load()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  },
  {
    name: "scheduled webinars",
    file: "scheduled-webinars.json",
    modeVariable: "SCHEDULED_WEBINARS_PERSISTENCE",
    pathVariable: "SCHEDULED_WEBINARS_PATH",
    uniqueKey: "link slug",
    recordsCanBeDeleted: true,
    encode: (records) =>
      records.map(({ id, title, updatedAt, unique, room }) => ({
        ...webinarTemplate(),
        id,
        title,
        updatedAt,
        linkSlug: unique ?? `slug-${id}`,
        roomId: room ?? `room-${id}`,
      })),
    load: async () => createScheduledWebinarPersistence().load().map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  },
  {
    name: "scheduling records",
    file: "scheduling.json",
    modeVariable: "SCHEDULING_PERSISTENCE",
    pathVariable: "SCHEDULING_PATH",
    uniqueKey: "host",
    recordsCanBeDeleted: false,
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
const copyPath = (store: Store, service = "sfu-a", archive = "20261124T000000000Z-sfu-test-deploy") => join(importDir(), service, archive, store.file);

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
    const before = { id: "before", title: "Before the rollback", updatedAt: 100 };
    const during = { id: "during", title: "Saved during the rollback", updatedAt: 200 };
    if (store.recordsCanBeDeleted) {
      write(activePath(store), store.encode([before, { ...during, title: "Original", updatedAt: 100 }]));
      write(copyPath(store), store.encode([{ ...before, updatedAt: 200 }, during]));
    } else {
      write(activePath(store), store.encode([before]));
      write(copyPath(store), store.encode([during]));
    }

    expect(byId(await store.load())).toEqual({ before: "Before the rollback", during: "Saved during the rollback" });
    expect(readdirSync(dirname(activePath(store))).some((name) => name.startsWith(`${store.file}.premerge-`))).toBe(true);
  });

  it("keeps the newer edit of a record both stores hold, whichever store has it", async () => {
    write(activePath(store), store.encode([{ id: "a", title: "Older", updatedAt: 100 }, { id: "b", title: "Newer here", updatedAt: 300 }]));
    write(copyPath(store), store.encode([{ id: "a", title: "Newer in the copy", updatedAt: 200 }, { id: "b", title: "Older", updatedAt: 200 }]));

    expect(byId(await store.load())).toEqual({ a: "Newer in the copy", b: "Newer here" });
  });

  it("only unions disjoint copies of records that cannot be deleted", async () => {
    write(copyPath(store, "sfu-a"), store.encode([{ id: "a", title: "From sfu-a", updatedAt: 100 }]));
    write(copyPath(store, "sfu-b"), store.encode([{ id: "b", title: "From sfu-b", updatedAt: 100 }]));

    if (store.recordsCanBeDeleted) {
      await expect(store.load()).rejects.toThrow(/possible deletion/);
      expect(existsSync(activePath(store))).toBe(false);
      expect(existsSync(copyPath(store, "sfu-a"))).toBe(true);
      expect(existsSync(copyPath(store, "sfu-b"))).toBe(true);
    } else {
      expect(byId(await store.load())).toEqual({ a: "From sfu-a", b: "From sfu-b" });
    }
  });

  it("adopts the copies two deploys saved, oldest first, and keeps the records of both", async () => {
    const first = { id: "a", title: "Saved by the first deploy", updatedAt: 100 };
    const second = { id: "b", title: "Saved by the second deploy", updatedAt: 200 };
    write(copyPath(store, "sfu-a", "20261123T090000000Z-sfu-first-deploy"), store.encode(store.recordsCanBeDeleted ? [first, { ...second, updatedAt: 100 }] : [first]));
    write(copyPath(store, "sfu-a", "20261124T090000000Z-sfu-second-deploy"), store.encode(store.recordsCanBeDeleted ? [{ ...first, updatedAt: 200 }, second] : [second]));
    write(join(importDir(), ".incoming-sfu-a-77", "files", store.file), store.encode([{ id: "c", title: "Still arriving", updatedAt: 100 }]));

    expect(byId(await store.load())).toEqual({ a: "Saved by the first deploy", b: "Saved by the second deploy" });
    expect(existsSync(`${copyPath(store, "sfu-a", "20261123T090000000Z-sfu-first-deploy")}.adopted`)).toBe(true);
    expect(existsSync(`${copyPath(store, "sfu-a", "20261124T090000000Z-sfu-second-deploy")}.adopted`)).toBe(true);
    expect(existsSync(join(importDir(), ".incoming-sfu-a-77", "files", store.file))).toBe(true);
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

describe.each(stores)("an SFU in explicit JSON mode whose saved $name copies it cannot open", (store) => {
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
    ["an archive folder it can read but not mark adopted", () => dirname(copyPath(store)), 0o500],
  ] as const)("refuses to start, naming %s and the fix, and changes nothing", async (_label, locked, mode) => {
    write(activePath(store), store.encode([{ id: "live", title: "Live", updatedAt: 100 }]));
    write(copyPath(store), store.encode([{ id: "live", title: "Saved", updatedAt: 200 }]));

    await lockedWhile(locked(), mode, async () => {
      const refusal = store.load();
      await expect(refusal).rejects.toThrow(/cannot open it \((EACCES|EPERM)\)[\s\S]*chown -R node:node/);
      await expect(refusal).rejects.toThrow(locked());
      expect(readdirSync(dirname(activePath(store))).filter((name) => name.includes(".premerge-"))).toEqual([]);
    });
    expect(existsSync(copyPath(store))).toBe(true);
    expect(byId(await store.load())).toEqual({ live: "Saved" });
  });

  it.skipIf(isRoot)("starts as usual when only a staging folder it never reads is locked", async () => {
    write(copyPath(store), store.encode([{ id: "saved", title: "Saved", updatedAt: 100 }]));
    const staging = join(importDir(), ".incoming-sfu-a-20261124T000000000Z-sfu-test-deploy-1a2b3c");
    write(join(staging, "files", store.file), store.encode([{ id: "partial", title: "Partial", updatedAt: 100 }]));

    await lockedWhile(staging, 0o000, async () => {
      expect(byId(await store.load())).toEqual({ saved: "Saved" });
    });
  });
});

describe.each(stores)("an SFU in explicit JSON mode combining $name", (store) => {
  it("refuses to start when two records would claim the same $uniqueKey", async () => {
    write(activePath(store), store.encode([{ id: "a", title: "First", updatedAt: 100, unique: "shared" }]));
    write(copyPath(store), store.encode([{ id: "b", title: "Second", updatedAt: 100, unique: "shared" }]));

    await expect(store.load()).rejects.toThrow(/both claim/);
  });
});

describe("an SFU in explicit JSON mode combining scheduled meetings", () => {
  const meetings = stores[0];

  it("lets an ended or cancelled meeting share a room code with an active one", async () => {
    const active = { id: "active", title: "Active", updatedAt: 100, unique: "shared-code" };
    const done = { id: "done", title: "Cancelled", updatedAt: 200, unique: "shared-code", status: "cancelled" };
    write(activePath(meetings), meetings.encode([active, { ...done, updatedAt: 100 }]));
    write(copyPath(meetings), meetings.encode([{ ...active, updatedAt: 200 }, done]));

    expect(byId(await meetings.load())).toEqual({ active: "Active", done: "Cancelled" });
  });
});

describe("an SFU in explicit JSON mode combining scheduled webinars", () => {
  const webinars = stores[1];

  it("refuses to start when two webinars would claim the same room", async () => {
    write(activePath(webinars), webinars.encode([{ id: "a", title: "First", updatedAt: 100, room: "same-room" }]));
    write(copyPath(webinars), webinars.encode([{ id: "b", title: "Second", updatedAt: 100, room: "same-room" }]));

    await expect(webinars.load()).rejects.toThrow(/both claim[\s\S]*byRoomChannel/);
  });
});

describe("an SFU in explicit JSON mode combining scheduling records", () => {
  const scheduling = stores[2];

  it.each(["volume", "rollback copy"])("leaves both files intact when the %s deleted a bookable event type", async (deletedIn) => {
    const store = createSchedulingStore();
    const profile = ensureSchedulingProfile(store, { clientId: "conclave", userId: "host", email: "host@example.test" });
    const event = createEventType(store, profile, { title: "Office hours", slug: "office-hours" });
    const snapshot = () => ({ profiles: [profile], eventTypes: [...store.eventTypesById.values()], availability: [], calendars: [] });
    const active = activePath(scheduling);
    const copy = copyPath(scheduling);
    write(deletedIn === "volume" ? copy : active, snapshot());
    expect(deleteEventType(store, profile, event.id)).toBeTruthy();
    write(deletedIn === "volume" ? active : copy, snapshot());
    const originals = [active, copy].map((path) => readFileSync(path, "utf8"));

    const load = async () => createSchedulingPersistence().load();
    await expect(load()).rejects.toThrow(new RegExp(`eventTypes ${event.id}.*possible deletion`));
    expect([active, copy].map((path) => readFileSync(path, "utf8"))).toEqual(originals);
    expect(existsSync(`${copy}.adopted`)).toBe(false);
  });

  const calendar = (profileId: string): SchedulingCalendarConnection => ({
    id: `calendar-${profileId}`,
    clientId: "conclave",
    profileId,
    userId: `user-${profileId}`,
    provider: "google",
    status: "connected",
    email: "host@example.test",
    calendarId: "primary",
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    accessTokenExpiresAt: 1_800_000_000_000,
    scopes: [],
    connectedAt: 100,
    updatedAt: 150,
    error: null,
  });
  const saveThroughTheStore = (path: string, secret: string, snapshot: object) => {
    vi.stubEnv("SCHEDULING_PATH", path);
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", "");
    vi.stubEnv("SCHEDULING_TOKEN_SECRET", secret);
    void createSchedulingPersistence().save(snapshot as never);
    vi.stubEnv("SCHEDULING_PATH", activePath(scheduling));
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
    vi.stubEnv("SCHEDULING_TOKEN_SECRET", "current-secret");
  };
  const withCalendar = () => ({ ...(scheduling.encode([{ id: "p1", title: "Host", updatedAt: 100 }]) as object), calendars: [calendar("p1")] });

  it("refuses to recover a calendar connection that could have been disconnected", async () => {
    const snapshot = withCalendar();
    saveThroughTheStore(activePath(scheduling), "current-secret", snapshot);
    saveThroughTheStore(copyPath(scheduling), "current-secret", { ...snapshot, calendars: [] });

    await expect(scheduling.load()).rejects.toThrow(/calendars calendar-p1.*possible deletion/);
    expect(existsSync(copyPath(scheduling))).toBe(true);
  });

  it.each([true, false])("keeps both files when a calendar was disconnected and reconnected (newer archive: %s)", async (newerArchive) => {
    const store = createSchedulingStore();
    const profile = ensureSchedulingProfile(store, { clientId: "conclave", userId: "host", email: "host@example.test" });
    const snapshot = () => ({ profiles: [profile], eventTypes: [], availability: [], calendars: [...store.calendarByProfileId.values()] });
    const active = activePath(scheduling);
    const copy = copyPath(scheduling);
    const disconnected = setGoogleCalendarConnection(store, profile, { email: "first@example.test", refreshToken: "first" });
    disconnected.updatedAt = newerArchive ? 200 : 100;
    saveThroughTheStore(copy, "current-secret", snapshot());
    clearGoogleCalendarConnection(store, profile);
    const reconnected = setGoogleCalendarConnection(store, profile, { email: "second@example.test", refreshToken: "second" });
    reconnected.updatedAt = newerArchive ? 100 : 200;
    expect(reconnected.id).not.toBe(disconnected.id);
    saveThroughTheStore(active, "current-secret", snapshot());
    const originals = [active, copy].map((path) => readFileSync(path, "utf8"));

    await expect(scheduling.load()).rejects.toThrow(new RegExp(`calendars ${disconnected.id}.*possible deletion`));
    expect([active, copy].map((path) => readFileSync(path, "utf8"))).toEqual(originals);
    expect(existsSync(`${copy}.adopted`)).toBe(false);
  });

  it("treats two saves of the same calendar as one record, though their ciphertext differs", async () => {
    const snapshot = withCalendar();
    saveThroughTheStore(activePath(scheduling), "current-secret", snapshot);
    saveThroughTheStore(copyPath(scheduling), "current-secret", snapshot);

    expect(byId(await scheduling.load())).toEqual({ p1: "Host" });
    expect((await createSchedulingPersistence().load()).calendars.map((entry) => entry.refreshToken)).toEqual(["refresh-token-value"]);
    expect(readdirSync(dirname(activePath(scheduling))).some((name) => name.includes(".premerge-"))).toBe(false);
    expect(existsSync(`${copyPath(scheduling)}.adopted`)).toBe(true);
  });

  it("refuses to start rather than drop calendar tokens it cannot decrypt", async () => {
    saveThroughTheStore(copyPath(scheduling), "the-older-sfus-secret", withCalendar());

    await expect(scheduling.load()).rejects.toThrow(/cannot be decrypted/);
    expect(existsSync(copyPath(scheduling))).toBe(true);
  });
});

describe("the canonical decode of a stored timestamp", () => {
  type Raw = { [field: string]: unknown };
  const calendarRow = (): Raw => ({
    id: "calendar-p1",
    clientId: "conclave",
    profileId: "p1",
    userId: "user-p1",
    provider: "google",
    status: "connected",
    email: "host@example.test",
    calendarId: "primary",
    accessToken: "plaintext-access",
    refreshToken: "plaintext-refresh",
    accessTokenExpiresAt: null,
    scopes: [],
    connectedAt: 100,
    updatedAt: 150,
    error: null,
  });
  const nullable = [
    { name: "scheduled meetings", decode: scheduledMeetingJsonStore.decode, wrap: (row: Raw) => [row], row: () => JSON.parse(JSON.stringify(meetingTemplate())) as Raw, fields: ["startedAt", "endedAt", "emailNotificationSentAt", "emailReminderSentAt"] },
    { name: "scheduled webinars", decode: scheduledWebinarJsonStore.decode, wrap: (row: Raw) => [row], row: () => JSON.parse(JSON.stringify(webinarTemplate())) as Raw, fields: ["liveStartedAt", "endedAt", "coHostInviteTokenCreatedAt"] },
    { name: "scheduling records", decode: schedulingJsonStore.decode, wrap: (row: Raw) => ({ profiles: [], availability: [], eventTypes: [], calendars: [row] }), row: calendarRow, fields: ["accessTokenExpiresAt"] },
  ];
  const unset: Array<[string, unknown]> = [["missing", undefined], ["0", 0], ["an empty string", ""], ["the string 0", "0"], ["a word", "never"]];
  const cases = nullable.flatMap((store) => store.fields.flatMap((field) => unset.map(([variant, value]) => ({ ...store, field, variant, value }))));
  const withField = (row: Raw, field: string, value: unknown): Raw => {
    const copy = { ...row };
    if (value === undefined) delete copy[field];
    else copy[field] = value;
    return copy;
  };

  it.each(cases)("$name reads $field written as $variant exactly as one written as null", ({ decode, wrap, row, field, value }) => {
    const template = row();
    expect(decode(wrap(withField(template, field, value)))).toStrictEqual(decode(wrap(withField(template, field, null))));
  });

  it.each(nullable.flatMap((store) => store.fields.map((field) => ({ ...store, field }))))("$name keeps a real $field", ({ decode, wrap, row, field }) => {
    expect(JSON.stringify(decode(wrap(withField(row(), field, 1_716_200_000_000))))).toContain(`"${field}":1716200000000`);
  });
});

describe("the JSON store merger, for every claim a store declares", () => {
  type Row = { [field: string]: unknown };
  type Claim = { key: (row: Row) => string; holds?: (row: Row) => boolean };
  type Collection = { rows: (snapshot: unknown) => Row[]; key: (row: Row) => string; claims: { [name: string]: Claim } };
  type Adapter = {
    decode: (data: unknown) => unknown;
    write: (path: string, snapshot: unknown) => void;
    build: (base: unknown, rows: { [name: string]: unknown[] }) => unknown;
    collections: { [name: string]: Collection };
  };

  const twoOfEach = (name: string): unknown => {
    if (name === "scheduled meetings") {
      const meetings = createScheduledMeetingStore();
      return [0, 1].map((n) => createScheduledMeeting(meetings, { title: `Meeting ${n}`, scheduledStartAt: later + n * 3_600_000 }, HOST));
    }
    if (name === "scheduled webinars") {
      const webinars = createScheduledWebinarStore();
      return [0, 1].map((n) => createScheduledWebinar(webinars, { title: `Webinar ${n}`, scheduledStartAt: later, linkSlug: `webinar-${n}` }, HOST).webinar);
    }
    const scheduling = createSchedulingStore();
    const profiles = [0, 1].map((n) => ensureSchedulingProfile(scheduling, { clientId: "conclave", userId: `user-${n}`, email: `host-${n}@example.test` }));
    return {
      profiles,
      availability: [],
      eventTypes: profiles.map((profile, n) => createEventType(scheduling, profile, { title: `Event ${n}`, slug: `event-${n}` })),
      calendars: profiles.map((profile) => setGoogleCalendarConnection(scheduling, profile, {})),
    };
  };

  const adapters: Array<[Store, Adapter]> = [
    [stores[0], scheduledMeetingJsonStore as unknown as Adapter],
    [stores[1], scheduledWebinarJsonStore as unknown as Adapter],
    [stores[2], schedulingJsonStore as unknown as Adapter],
  ];
  const cases = adapters.flatMap(([store, adapter]) =>
    Object.entries(adapter.collections).flatMap(([collection, declared]) =>
      Object.keys(declared.claims).map((claim) => ({ store, adapter, collection, claim, label: `${store.name} ${collection}` })),
    ),
  );

  const rivalFor = (declared: Collection, claim: Claim, owner: Row, other: Row): Row => {
    let rival = { ...other };
    for (const field of Object.keys(owner)) {
      if (claim.key(rival) === claim.key(owner)) break;
      const next = { ...rival, [field]: owner[field] };
      if (declared.key(next) !== declared.key(owner)) rival = next;
    }
    return rival;
  };

  it.each(cases)("refuses two $label records that both claim one $claim", async ({ store, adapter, collection, claim }) => {
    const base = adapter.decode(JSON.parse(JSON.stringify(twoOfEach(store.name))));
    const declared = adapter.collections[collection];
    const [owner, other] = declared.rows(base);
    const rival = rivalFor(declared, declared.claims[claim], owner, other);
    expect(declared.claims[claim].key(rival)).toBe(declared.claims[claim].key(owner));
    expect(declared.key(rival)).not.toBe(declared.key(owner));
    for (const row of [owner, rival]) expect(declared.claims[claim].holds?.(row) ?? true).toBe(true);

    const withRow = (row: Row) =>
      adapter.build(base, Object.fromEntries(Object.entries(adapter.collections).map(([name, entry]) => [name, name === collection ? [row] : entry.rows(base)])));
    mkdirSync(dirname(activePath(store)), { recursive: true });
    adapter.write(activePath(store), withRow(owner));
    mkdirSync(dirname(copyPath(store)), { recursive: true });
    adapter.write(copyPath(store), withRow(rival));

    await expect(store.load()).rejects.toThrow(new RegExp(`both claim [^\\n]* in ${claim}\\.`));
  });
});

describe("an invitee a host removed, in a JSON meeting store an older SFU's copy is combined into", () => {
  const store = stores[0];
  const INVITEE = "invitee@example.test";
  const booked = meetingTemplate();
  const meeting = (title: string, updatedAt: number) => ({ ...booked, id: "a", title, updatedAt });
  const removedIn = (record: object) => ({
    ...record,
    readmissionRequiredEmails: [INVITEE],
    readmissionDecisions: { [INVITEE]: { removed: true, at: 50 } },
    readmissionEndedAt: null,
    readmissionWriteGeneration: 7,
  });
  const loaded = async () => (await createScheduledMeetingPersistence().load())[0];

  it("stays removed, and the SFU starts, when the copy holds the same meeting as it was before the removal", async () => {
    write(activePath(store), [removedIn(meeting("Intro call", 100))]);
    write(copyPath(store), [meeting("Intro call", 100)]);

    expect(await loaded()).toMatchObject({ title: "Intro call", readmissionRequiredEmails: [INVITEE] });
    expect(existsSync(`${copyPath(store)}.adopted`)).toBe(true);
  });

  it("stays removed when the copy holds a newer edit of the meeting", async () => {
    write(activePath(store), [removedIn(meeting("Intro call", 100))]);
    write(copyPath(store), [meeting("Intro call, moved", 200)]);

    expect(await loaded()).toMatchObject({ title: "Intro call, moved", readmissionRequiredEmails: [INVITEE] });
  });
});

describe("the JSON store merger", () => {
  type CheckedIndexes = { collections: { [name: string]: { index?: string; claims: object } } };
  const liveStores: Array<{ name: string; store: object; adapter: CheckedIndexes }> = [
    { name: "scheduled meetings", store: createScheduledMeetingStore(), adapter: scheduledMeetingJsonStore },
    { name: "scheduled webinars", store: createScheduledWebinarStore(), adapter: scheduledWebinarJsonStore },
    { name: "scheduling records", store: createSchedulingStore(), adapter: schedulingJsonStore },
  ];

  it.each(liveStores)("checks every index the live $name store keeps", ({ store, adapter }) => {
    const indexes = Object.entries(store)
      .filter(([, value]) => value instanceof Map)
      .map(([name]) => name)
      .sort();
    const checked = Object.values(adapter.collections)
      .flatMap((collection) => [...(collection.index ? [collection.index] : []), ...Object.keys(collection.claims)])
      .sort();
    expect(checked).toEqual(indexes);
  });
});
