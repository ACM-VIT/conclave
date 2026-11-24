import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreMode } from "../server/controlPlane/backends/backend.js";
import { createJsonBackend } from "../server/controlPlane/backends/json.js";
import { createMemoryBackend, createMemoryData, type MemoryData } from "../server/controlPlane/backends/memory.js";
import { createRedisBackend } from "../server/controlPlane/backends/redis.js";
import { createSqliteBackend, openSqliteDatabase } from "../server/controlPlane/backends/sqlite.js";
import { importLegacy } from "../server/controlPlane/legacy.js";
import {
  advanceMeetings,
  createMeeting,
  deleteMeeting,
  meetingById,
  meetingByRoomCode,
  updateMeeting,
} from "../server/controlPlane/meetingCommands.js";
import { StoreUnavailableError, done, fail, tags } from "../server/controlPlane/model.js";
import { controlPlaneStore, type ControlPlaneStore } from "../server/controlPlane/store.js";
import {
  createWebinar,
  recordWebinarJoin,
  webinarById,
} from "../server/controlPlane/webinarCommands.js";
import type { ScheduledMeeting } from "../types.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

let redis: RedisServer | null = null;
let dir = "";
let prefix = "";
let memory: MemoryData = createMemoryData();
const opened: ControlPlaneStore[] = [];

const open = async (mode: StoreMode): Promise<ControlPlaneStore> => {
  const store =
    mode === "memory"
      ? controlPlaneStore(createMemoryBackend(memory))
      : mode === "json"
        ? controlPlaneStore(createJsonBackend(join(dir, "control-plane.json")))
        : mode === "sqlite"
          ? controlPlaneStore(createSqliteBackend(join(dir, "conclave.sqlite")))
          : controlPlaneStore(await createRedisBackend({ redisUrl: redis!.url, keyPrefix: prefix }));
  opened.push(store);
  return store;
};

const closeAll = async () => {
  for (const store of opened.splice(0)) await store.close();
};

const sharedModes: StoreMode[] = hasRedis ? ["memory", "sqlite", "redis"] : ["memory", "sqlite"];
const modes: StoreMode[] = hasRedis ? ["memory", "json", "sqlite", "redis"] : ["memory", "json", "sqlite"];

const host = { email: "host@example.test", isAdmin: false };
const meetingOptions = {
  clientId: "conclave",
  createdBy: "host@example.test",
  defaultHostEmail: "host@example.test",
  defaultHostUserId: null,
};

const mustCreate = async (store: ControlPlaneStore, roomCode: string): Promise<ScheduledMeeting> => {
  const result = await store.commit(
    createMeeting({ title: "Standup", scheduledStartAt: Date.now() + 3_600_000, roomCode }, meetingOptions),
  );
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6520);
});

afterAll(() => {
  redis?.stop();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-control-plane-"));
  prefix = `conformance:${Date.now()}:${Math.random()}`;
  memory = createMemoryData();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await closeAll();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(modes)("the %s control-plane store", (mode) => {
  it("commits a write and gives every later write a higher revision", async () => {
    const store = await open(mode);
    const first = await store.commit(
      createMeeting({ title: "One", scheduledStartAt: Date.now() + 60_000, roomCode: "one" }, meetingOptions),
    );
    const second = await store.commit(
      createMeeting({ title: "Two", scheduledStartAt: Date.now() + 60_000, roomCode: "two" }, meetingOptions),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(await store.read(meetingById(first.value.id))).toEqual(first.value);
  });

  it("writes nothing when a command fails after staging writes", async () => {
    const store = await open(mode);
    const meeting = await mustCreate(store, "standup");
    const result = await store.commit((tx) => {
      tx.put("meeting", { ...meeting, title: "Changed" });
      tx.remove("meeting", meeting.id);
      return fail("conflict", "stop");
    });
    expect(result).toEqual({ ok: false, reason: "conflict", message: "stop" });
    expect(await store.read(meetingById(meeting.id))).toEqual(meeting);
  });

  it("rejects invalid input without writing anything", async () => {
    const store = await open(mode);
    const result = await store.commit(
      createMeeting({ title: "", scheduledStartAt: Date.now() }, meetingOptions),
    );
    expect(result).toEqual({ ok: false, reason: "invalid", message: "Title is required." });
    expect(await store.read((view) => view.all("meeting"))).toEqual([]);
  });

  it("keeps an active room code unique and frees it once the meeting ends or goes", async () => {
    const store = await open(mode);
    const first = await mustCreate(store, "standup");
    const taken = await store.commit(
      createMeeting({ title: "Again", scheduledStartAt: Date.now() + 60_000, roomCode: "standup" }, meetingOptions),
    );
    expect(taken.ok).toBe(false);
    expect((await store.commit(updateMeeting(first.id, { status: "ended" }, host))).ok).toBe(true);
    const second = await mustCreate(store, "standup");
    expect((await store.read(meetingByRoomCode("conclave", "standup")))?.id).toBe(second.id);
    expect((await store.commit(deleteMeeting(second.id, host))).ok).toBe(true);
    const third = await mustCreate(store, "standup");
    expect((await store.read(meetingByRoomCode("conclave", "standup")))?.id).toBe(third.id);
  });

  it("finds records by tag and drops them from the tag when they change", async () => {
    const store = await open(mode);
    const meeting = await mustCreate(store, "standup");
    const active = () => store.read((view) => view.tagged("meeting", tags.activeMeetings).map((stored) => stored.value.id));
    expect(await active()).toEqual([meeting.id]);
    await store.commit(updateMeeting(meeting.id, { status: "cancelled" }, host));
    expect(await active()).toEqual([]);
  });

  it("refuses a delete and an edit from someone who is not the host", async () => {
    const store = await open(mode);
    const meeting = await mustCreate(store, "standup");
    const stranger = { email: "stranger@example.test", isAdmin: false };
    expect(await store.commit(deleteMeeting(meeting.id, stranger))).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await store.commit(updateMeeting(meeting.id, { title: "Mine" }, stranger))).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(await store.read(meetingById(meeting.id))).toEqual(meeting);
  });

  it("imports legacy records only where no live record or deletion exists", async () => {
    const store = await open(mode);
    const live = await mustCreate(store, "live-room");
    const removed = await mustCreate(store, "gone-room");
    await store.commit(deleteMeeting(removed.id, host));
    const fresh = { ...live, id: "legacy-fresh", roomCode: "legacy-room", updatedAt: 100 };
    const imported = await store.commit(
      importLegacy([
        { kind: "meeting", value: { ...live, title: "Old title", updatedAt: 1 }, stamp: 1 },
        { kind: "meeting", value: { ...removed, title: "Back" }, stamp: removed.updatedAt + 1 },
        { kind: "meeting", value: fresh, stamp: 100 },
      ]),
    );
    expect(imported).toMatchObject({ ok: true, value: { inserted: 1, kept: 2 } });
    expect((await store.read(meetingById(live.id)))?.title).toBe("Standup");
    expect(await store.read(meetingById(removed.id))).toBeNull();
    expect(await store.read(meetingById(fresh.id))).toEqual(fresh);

    const refreshed = await store.commit(
      importLegacy([{ kind: "meeting", value: { ...fresh, title: "Newer legacy" }, stamp: 200 }]),
    );
    expect(refreshed).toMatchObject({ ok: true, value: { refreshed: 1 } });
    expect((await store.read(meetingById(fresh.id)))?.title).toBe("Newer legacy");

    await store.commit(updateMeeting(fresh.id, { title: "Edited live" }, host));
    await store.commit(importLegacy([{ kind: "meeting", value: { ...fresh, title: "Later legacy" }, stamp: 300 }]));
    expect((await store.read(meetingById(fresh.id)))?.title).toBe("Edited live");
  });

  it("returns a no-op command's value without writing", async () => {
    const store = await open(mode);
    const meeting = await mustCreate(store, "standup");
    const before = await store.read((view) => view.get("meeting", meeting.id)?.rev);
    const result = await store.commit((tx) => done(tx.get("meeting", meeting.id)?.value.title));
    expect(result).toMatchObject({ ok: true, value: "Standup" });
    expect(await store.read((view) => view.get("meeting", meeting.id)?.rev)).toBe(before);
  });

  it("ends hundreds of live meetings in one tick", async () => {
    const store = await open(mode);
    const now = Date.now();
    const seeded = await store.commit((tx) => {
      for (let index = 0; index < 300; index += 1) {
        const id = `live-${index}`;
        tx.put("meeting", {
          id,
          clientId: "conclave",
          roomCode: `live-room-${index}`,
          title: "Live",
          hostEmail: "host@example.test",
          hostName: "Host",
          hostUserId: null,
          scheduledStartAt: now - 7_200_000,
          scheduledEndAt: now - 3_600_000,
          status: "live",
          startedAt: now - 7_200_000,
          endedAt: null,
          createdAt: now - 7_200_000,
          createdBy: "host@example.test",
          updatedAt: now - 7_200_000,
          source: "manual",
        });
      }
      return done(300);
    });
    expect(seeded.ok).toBe(true);
    const ticked = await store.commit(advanceMeetings);
    expect(ticked.ok && ticked.value.length).toBe(300);
    expect(await store.read((view) => view.tagged("meeting", tags.activeMeetings).length)).toBe(0);
    expect((await store.read((view) => view.all("meeting"))).every((stored) => stored.value.status === "ended")).toBe(true);
  }, 60_000);

  if (mode !== "memory") {
    it("keeps every committed record across a restart", async () => {
      const store = await open(mode);
      const meeting = await mustCreate(store, "standup");
      await store.commit(updateMeeting(meeting.id, { title: "Renamed" }, host));
      await closeAll();
      const reopened = await open(mode);
      expect((await reopened.read(meetingById(meeting.id)))?.title).toBe("Renamed");
      expect((await reopened.read(meetingByRoomCode("conclave", "standup")))?.id).toBe(meeting.id);
    });
  }
});

describe.each(sharedModes)("two SFUs on one %s store", (mode) => {
  it("lose no concurrent update", async () => {
    const [a, b] = [await open(mode), await open(mode)];
    const created = await a.commit(
      createWebinar({ title: "Launch", scheduledStartAt: Date.now() + 60_000 }, { clientId: "conclave", createdBy: "host" , defaultHostEmail: "host@example.test" }),
    );
    if (!created.ok) throw new Error(created.message);
    const id = created.value.webinar.id;
    const joins = Array.from({ length: 30 }, (_, index) =>
      (index % 2 === 0 ? a : b).commit(recordWebinarJoin(id, index)),
    );
    const results = await Promise.all(joins);
    expect(results.every((result) => result.ok)).toBe(true);
    const stored = await b.read(webinarById(id));
    expect(stored?.totalJoinCount).toBe(30);
    expect(stored?.peakAttendeeCount).toBe(29);
  });

  it("let exactly one of two concurrent claims take a link code", async () => {
    const [a, b] = [await open(mode), await open(mode)];
    const claim = (store: ControlPlaneStore, title: string) =>
      store.commit(
        createWebinar(
          { title, scheduledStartAt: Date.now() + 60_000, linkSlug: "launch-day" },
          { clientId: "conclave", createdBy: "host", defaultHostEmail: "host@example.test" },
        ),
      );
    const results = await Promise.all([claim(a, "A"), claim(b, "B")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      reason: "invalid",
      message: "That webinar link code is already in use.",
    });
  });
});

describe("the JSON store", () => {
  it("refuses a second SFU on the same file", async () => {
    await open("json");
    expect(() => createJsonBackend(join(dir, "control-plane.json"))).toThrow(/serves one SFU only/);
  });

  it("refuses to start on a file it cannot read", () => {
    writeFileSync(join(dir, "control-plane.json"), "{ not json");
    expect(() => createJsonBackend(join(dir, "control-plane.json"))).toThrow();
  });

  it("stops writing once another SFU has taken over its lock", async () => {
    const store = await open("json");
    await mustCreate(store, "first-room");
    const before = readFileSync(join(dir, "control-plane.json"), "utf8");
    writeFileSync(join(dir, "control-plane.json.lock"), "another-holder");
    await expect(mustCreate(store, "second-room")).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(readFileSync(join(dir, "control-plane.json"), "utf8")).toBe(before);
  });

  it("takes over a lock whose holder stopped renewing it", async () => {
    const lockPath = join(dir, "control-plane.json.lock");
    writeFileSync(lockPath, "stale-holder");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);
    const store = await open("json");
    expect((await mustCreate(store, "standup")).roomCode).toBe("standup");
  });
});

describe("the SQLite store", () => {
  it("stops a read at a record it cannot decode instead of skipping it", async () => {
    const store = await open("sqlite");
    const meeting = await mustCreate(store, "standup");
    const db = openSqliteDatabase(join(dir, "conclave.sqlite"));
    db.prepare("UPDATE control_plane_records SET value_json = ? WHERE id = ?").run("{}", meeting.id);
    db.close();
    await expect(store.read(meetingById(meeting.id))).rejects.toThrow(/unreadable/);
  });
});

describe.skipIf(!hasRedis)("the Redis store", () => {
  it("answers a storage error, not a result, when Redis is unreachable", async () => {
    const lonely = await startRedis(6560);
    const store = controlPlaneStore(await createRedisBackend({ redisUrl: lonely.url, keyPrefix: prefix }));
    opened.push(store);
    lonely.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      store.commit(createMeeting({ title: "Late", scheduledStartAt: Date.now() + 60_000 }, meetingOptions)),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
