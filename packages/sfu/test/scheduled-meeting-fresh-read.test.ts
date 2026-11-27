import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bookingInvites, roomBooking, roomInviteeDecision, updateRoomInvitation } from "../server/controlPlane/inviteeCommands.js";
import { createMeeting, deleteMeeting, meetingByRoomCode, updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { openSqliteDatabase } from "../server/controlPlane/backends/sqlite.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { readRoomBooking } from "../server/rooms.js";
import { createSfuState } from "../server/state.js";
import { legacyMeeting } from "./support/oldSfu.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const ROOM = "abc-mnop-xyz";
const HOST = "host@example.test";
const INVITEE = "invitee@example.test";
const CLIENT = "conclave";
let dir: string;
let redis: RedisServer | null = null;
const stores: ControlPlaneStore[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6920);
});

afterAll(() => redis?.stop());
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "unified-meeting-invitees-")); });
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const configFor = (mode: "memory" | "json" | "sqlite" | "redis") =>
  resolveControlPlaneConfig({
    CONTROL_PLANE_PERSISTENCE: mode,
    CONCLAVE_SQLITE_PATH: join(dir, "unified.sqlite"),
    CONTROL_PLANE_JSON_PATH: join(dir, "unified.json"),
    SCHEDULED_MEETINGS_SQLITE_PATH: join(dir, "staging.sqlite"),
    SCHEDULED_MEETINGS_PATH: join(dir, "scheduled-meetings.json"),
    CONCLAVE_FALLBACK_IMPORT_DIR: join(dir, "fallback"),
    SFU_PERSISTENCE_REDIS_URL: redis?.url,
    SFU_PERSISTENCE_REDIS_KEY_PREFIX: `fresh-read:${dir}`,
  });

const open = async (mode: "memory" | "json" | "sqlite" | "redis", importLegacy = false) => {
  const store = await openControlPlane(configFor(mode), { importLegacy });
  stores.push(store);
  return store;
};

const book = async (store: ControlPlaneStore, clientId = CLIENT) => {
  const result = await store.commit(createMeeting({
    title: "Intro call", roomCode: ROOM, scheduledStartAt: Date.now(), hostEmail: HOST, attendeeEmail: INVITEE,
  }, { clientId, defaultHostEmail: HOST, defaultHostUserId: null, createdBy: HOST }));
  if (!result.ok) throw Error(result.message ?? result.reason);
  return result.value;
};

const commit = async (store: ControlPlaneStore, ...args: Parameters<typeof updateRoomInvitation>) => {
  expect(await store.commit(updateRoomInvitation(...args))).toMatchObject({ ok: true });
};

const invited = async (store: ControlPlaneStore, clientId = CLIENT) =>
  bookingInvites(await store.read(roomBooking(clientId, ROOM)), INVITEE);

describe.each(hasRedis ? ["memory", "json", "sqlite", "redis"] as const : ["memory", "json", "sqlite"] as const)("%s invitee decisions", (mode) => {
  it("reads fresh decisions and keeps them through ordinary booking edits", async () => {
    const a = await open(mode);
    const b = mode === "memory" || mode === "json" ? a : await open(mode);
    const meeting = await book(a);
    expect(await invited(b)).toBe(true);
    await commit(a, meeting, { kind: "decide", email: INVITEE, removed: true, at: 10, generation: 1 });
    expect(await invited(b)).toBe(false);
    expect(await b.commit(updateMeeting(meeting.id, { title: "Moved" }, { email: HOST, isAdmin: false }))).toMatchObject({ ok: true });
    expect(await invited(a)).toBe(false);
    await commit(b, meeting, { kind: "decide", email: INVITEE, removed: false, at: 11, generation: 1 });
    await commit(a, meeting, { kind: "decide", email: INVITEE, removed: true, at: 10, generation: 1 });
    expect(await invited(a)).toBe(true);
  });

  it("keeps later removals and lets removal win ties in either delivery order", async () => {
    const store = await open(mode);
    const meeting = await book(store);
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: false, at: 30 });
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: true, at: 30 });
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: false, at: 30 });
    expect(await invited(store)).toBe(false);
    await commit(store, meeting, { kind: "end", at: 30 });
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: true, at: 29 });
    expect(await invited(store)).toBe(true);
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: true, at: 31 });
    expect(await invited(store)).toBe(false);
  });

  it("fences an old owner, permits a continuous reclaim, and adopts newly booked codes", async () => {
    const store = await open(mode);
    const meeting = await book(store);
    await commit(store, meeting, { kind: "fence", generation: 7, held: 5 });
    expect(await store.commit(updateRoomInvitation(meeting, { kind: "fence", generation: 8, held: 5 }))).toMatchObject({ ok: false });
    await commit(store, meeting, { kind: "fence", generation: 8, held: 7 });
    for (const change of [
      { kind: "fence", generation: 7 },
      { kind: "decide", email: INVITEE, removed: true, at: 50, generation: 7 },
      { kind: "end", at: 60, generation: 7 },
    ] as const) {
      expect(await store.commit(updateRoomInvitation(meeting, change))).toMatchObject({ ok: false });
    }
    expect(await invited(store)).toBe(true);
  });

  it.each([10, 60])("allows the next meeting to record removal at clock %i after an end at 60", async (clock) => {
    const first = await open(mode);
    const next = mode === "memory" || mode === "json" ? first : await open(mode);
    const meeting = await book(first);
    await commit(first, meeting, { kind: "end", at: 60, generation: 1 });
    await commit(next, meeting, { kind: "fence", generation: 2 });
    const decision = await next.read(roomInviteeDecision(CLIENT, ROOM, INVITEE));
    await commit(next, meeting, {
      kind: "decide", email: INVITEE, removed: true,
      at: Math.max(clock, (decision?.at ?? -1) + 1), generation: 2,
    });
    expect(await invited(first)).toBe(false);
  });

  it("ends a meeting even if the previous owner recorded a removal ahead of its clock", async () => {
    const first = await open(mode);
    const next = mode === "memory" || mode === "json" ? first : await open(mode);
    const meeting = await book(first);
    await commit(first, meeting, { kind: "decide", email: INVITEE, removed: true, at: 60, generation: 1 });
    expect(await invited(next)).toBe(false);
    await commit(next, meeting, { kind: "fence", generation: 2 });
    await commit(next, meeting, { kind: "end", at: 10, generation: 2 });
    expect(await invited(first)).toBe(true);
  });

  it("pins writes to the booking and grants only in the exact tenant", async () => {
    const store = await open(mode);
    const meeting = await book(store);
    const unrelated = await book(store, "other");
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: true, at: 5 });
    expect(await invited(store, "other")).toBe(true);
    expect(await invited(store, "conclave-custom")).toBe(false);
    expect(await store.commit(deleteMeeting(meeting.id, { email: HOST, isAdmin: false }))).toMatchObject({ ok: true });
    const replacement = await book(store);
    expect(replacement.id).not.toBe(meeting.id);
    await commit(store, meeting, { kind: "decide", email: INVITEE, removed: true, at: 7 });
    expect(await invited(store)).toBe(true);
    expect((await store.read(roomBooking("other", ROOM)))?.meeting.id).toBe(unrelated.id);
  });

  it("queues a decision during a backup hold and leaves reads available", async () => {
    const state = createSfuState({ controlPlane: await open(mode) });
    const meeting = await book(state.controlPlane);
    expect(await state.persistenceFence.hold("test-backup", 5_000)).not.toBeNull();
    const removal = state.controlPlane.commit(updateRoomInvitation(meeting, { kind: "decide", email: INVITEE, removed: true, at: 12 }));
    try {
      expect(await invited(state.controlPlane)).toBe(true);
    } finally {
      state.persistenceFence.release("test-backup");
    }
    expect(await removal).toMatchObject({ ok: true });
    expect(await invited(state.controlPlane)).toBe(false);
  });
});

const restoredMeeting = (fields: Record<string, unknown> = {}) =>
  legacyMeeting("restored", { roomCode: ROOM, attendeeEmail: INVITEE, ...fields });
const removed = {
  readmissionRequiredEmails: [INVITEE],
  readmissionDecisions: { [INVITEE]: { removed: true, at: 50 } },
  readmissionWriteGeneration: 7,
};
const archiveFile = () =>
  join(configFor("json").legacy.fallbackDir!, "sfu-a", "20261124T000000000Z-sfu-older", "scheduled-meetings.json");

describe("a staging archive opened by the unified store", () => {
  it.each(["archived", "same-stamp copy", "newer edit"] as const)("retains the decisions for %s and retires the archive", async (source) => {
    const config = configFor("json");
    const path = archiveFile();
    mkdirSync(dirname(path), { recursive: true });
    if (source !== "archived") writeFileSync(config.legacy.meetingsJson, JSON.stringify([restoredMeeting(removed)]));
    const archived = source === "archived" ? restoredMeeting(removed)
      : source === "newer edit" ? restoredMeeting({ title: "Moved", updatedAt: 150 }) : restoredMeeting();
    writeFileSync(path, JSON.stringify([archived]));
    const store = await open("json", true);
    const booking = await store.read(roomBooking(CLIENT, ROOM));
    expect(booking).toMatchObject({ meeting: { title: archived.title }, removed: [INVITEE] });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.adopted`)).toBe(true);
    expect(await store.commit(updateRoomInvitation(booking!.meeting, { kind: "fence", generation: 6 }))).toMatchObject({ ok: false });
  });

  it("does not re-import an older carried removal after a readmission", async () => {
    const config = configFor("json");
    writeFileSync(config.legacy.meetingsJson, JSON.stringify([restoredMeeting({ readmissionRequiredEmails: [INVITEE] })]));
    const first = await open("json", true);
    const meeting = (await first.read(meetingByRoomCode(CLIENT, ROOM)))!;
    expect(await invited(first)).toBe(false);
    await commit(first, meeting, { kind: "decide", email: INVITEE, removed: false, at: 101 });
    await first.close();
    stores.pop();
    expect(await invited(await open("json", true))).toBe(true);
  });

  it("imports SQLite decisions atomically and does not revive the row's already moved removals", async () => {
    const config = configFor("sqlite");
    const legacy = openSqliteDatabase(config.legacy.meetingsSqlite);
    legacy.exec(`
      CREATE TABLE scheduled_meetings (payload_json TEXT);
      CREATE TABLE scheduled_meeting_removed_invitees (meeting_id TEXT, email TEXT, removed_at INTEGER, readmitted INTEGER);
      CREATE TABLE scheduled_meeting_removals_moved (meeting_id TEXT);
      CREATE TABLE scheduled_meeting_write_generations (meeting_id TEXT, generation INTEGER);
    `);
    legacy.prepare("INSERT INTO scheduled_meetings VALUES (?)").run(JSON.stringify(restoredMeeting(removed)));
    legacy.prepare("INSERT INTO scheduled_meeting_removed_invitees VALUES ('restored', ?, 60, 1)").run(INVITEE);
    legacy.exec("INSERT INTO scheduled_meeting_removals_moved VALUES ('restored'); INSERT INTO scheduled_meeting_write_generations VALUES ('restored', 9)");
    legacy.close();

    const inspect = await open("sqlite");
    const target = openSqliteDatabase(config.sqlitePath);
    target.exec(`
      CREATE TRIGGER block_invitee_state BEFORE INSERT ON control_plane_records
      WHEN NEW.kind = 'inviteeState' BEGIN SELECT RAISE(ABORT, 'injected import fault'); END;
    `);
    try {
      await expect(open("sqlite", true)).rejects.toThrow();
      expect(await inspect.read(roomBooking(CLIENT, ROOM))).toBeNull();
    } finally {
      target.exec("DROP TRIGGER block_invitee_state");
      target.close();
    }
    const imported = await open("sqlite", true);
    const booking = await imported.read(roomBooking(CLIENT, ROOM));
    expect(bookingInvites(booking, INVITEE)).toBe(true);
    expect(await imported.commit(updateRoomInvitation(booking!.meeting, { kind: "fence", generation: 8 }))).toMatchObject({ ok: false });
  });

  it.skipIf(!hasRedis)("imports Redis removals, end stamps and generation with the meeting", async () => {
    const config = configFor("redis");
    const legacy = createClient({ url: config.redisUrl });
    const key = `${config.keyPrefix}:scheduled-meetings`;
    await legacy.connect();
    try {
      await legacy.multi()
        .hSet(key, "restored", JSON.stringify(restoredMeeting()))
        .hSet(`${key}:removed-invitees`, `restored ${INVITEE}`, "70:removed")
        .hSet(`${key}:removed-invitees-ended`, "restored", "60")
        .hSet(`${key}:write-generations`, "restored", "9")
        .sAdd(`${key}:removed-invitees-moved`, "restored")
        .exec();
    } finally {
      await legacy.quit();
    }
    const imported = await open("redis", true);
    const booking = await imported.read(roomBooking(CLIENT, ROOM));
    expect(bookingInvites(booking, INVITEE)).toBe(false);
    expect(await imported.commit(updateRoomInvitation(booking!.meeting, { kind: "fence", generation: 8 }))).toMatchObject({ ok: false });
    await commit(imported, booking!.meeting, { kind: "end", at: 70, generation: 9 });
    expect(await invited(imported)).toBe(true);
  });
});

it("does not wait indefinitely for a booking read, or grant on failure", async () => {
  const state = createSfuState();
  state.controlPlane.read = () => new Promise(() => undefined);
  expect(await readRoomBooking(state, CLIENT, ROOM)).toBeNull();
  state.controlPlane.read = async () => { throw Error("injected booking read failure"); };
  expect(await readRoomBooking(state, CLIENT, ROOM)).toBeNull();
});
