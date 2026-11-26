import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  advanceScheduledMeetings,
  endScheduledMeetingRemovals,
  createScheduledMeeting,
  fenceScheduledMeeting,
  createScheduledMeetingPersistence,
  createScheduledMeetingStore,
  isScheduledMeetingInvitee,
  loadPersistedMeetings,
  persistInviteeReadmission,
  persistScheduledMeetingChanges,
  refreshScheduledMeeting,
  setScheduledInviteeReadmission,
  type ScheduledMeetingPersistence,
} from "../server/scheduledMeetings.js";
import { markRoomEnded } from "../server/rooms.js";
import { createSfuState } from "../server/state.js";

type Sfu = {
  persistence: ScheduledMeetingPersistence;
  meetings: ReturnType<typeof createScheduledMeetingStore>;
};
const dirs: string[] = [];
const running: Sfu[] = [];
afterEach(async () => {
  for (const sfu of running.splice(0)) await sfu.persistence.close?.();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "meetings-"));
  dirs.push(dir);
  return dir;
};

// The Redis store is tried against a real server, where one is installed.
const redisServerPath = (() => {
  try {
    return execFileSync("which", ["redis-server"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
let redis: { process: ChildProcess; port: number; dir: string } | null = null;
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
beforeAll(async () => {
  if (!redisServerPath) return;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "meetings-redis-"));
  const server = spawn(
    redisServerPath,
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir],
    { stdio: "ignore" },
  );
  redis = { process: server, port, dir };
  await vi.waitFor(async () => expect(await accepts(port)).toBe(true), {
    timeout: 20_000,
    interval: 50,
  });
}, 30_000);
afterAll(() => {
  redis?.process.kill();
  if (redis) rmSync(redis.dir, { recursive: true, force: true });
});

type StoreKind = "sqlite" | "json" | "redis";
let keyPrefix = 0;
// Where the SFUs of one test keep their meetings. Over Redis each SFU has a
// local copy of its own as well, as SFUs on different hosts do.
const useStore = (kind: StoreKind, dir = tempDir()) => {
  vi.stubEnv("SCHEDULED_MEETINGS_PERSISTENCE", kind);
  vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "scheduled-meetings.json"));
  vi.stubEnv("REDIS_URL", "");
  vi.stubEnv("SFU_REDIS_URL", "");
  vi.stubEnv(
    "SFU_PERSISTENCE_REDIS_URL",
    kind === "redis" ? `redis://127.0.0.1:${redis?.port}` : "",
  );
  keyPrefix += 1;
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `test:${process.pid}:${keyPrefix}`);
  return dir;
};

// One SFU: its own copy of the meetings in memory, over a store it may share.
const startSfu = async (kind: StoreKind, localDir = tempDir()): Promise<Sfu> => {
  if (kind === "redis") {
    vi.stubEnv("SCHEDULED_MEETINGS_SQLITE_PATH", join(localDir, "conclave.sqlite"));
  }
  const persistence = createScheduledMeetingPersistence();
  const meetings = createScheduledMeetingStore();
  await loadPersistedMeetings(meetings, persistence);
  const sfu = { persistence, meetings };
  running.push(sfu);
  return sfu;
};
const CODE = "abc-mnop-xyz";
const INVITEE = "invitee@example.com";
const isInvited = (sfu: Sfu) =>
  isScheduledMeetingInvitee(sfu.meetings, "conclave", CODE, INVITEE);
const scheduleIntroCall = async (sfu: Sfu) => {
  const meeting = createScheduledMeeting(
    sfu.meetings,
    {
      title: "Intro call",
      scheduledStartAt: Date.now(),
      roomCode: CODE,
      hostEmail: "host@example.com",
      attendeeEmail: INVITEE,
    },
    {
      clientId: "conclave",
      createdBy: "host@example.com",
      defaultHostEmail: "host@example.com",
      defaultHostUserId: null,
    },
  );
  await persistScheduledMeetingChanges(sfu.meetings, sfu.persistence, [meeting]);
  return meeting;
};
// What the SFU hosting the room does when its host removes the invitee, or
// lets them in again.
const setRemoved = async (sfu: Sfu, removed: boolean) => {
  const changed = setScheduledInviteeReadmission(sfu.meetings, "conclave", CODE, INVITEE, removed);
  await persistInviteeReadmission(sfu.meetings, sfu.persistence, changed!, INVITEE, removed);
};
// What every SFU's clock does to its own copy of a meeting whose time has
// come: move it on, and save the whole copy.
const moveOnAndSave = async (sfu: Sfu, now: number) => {
  const moved = advanceScheduledMeetings(sfu.meetings, now);
  expect(moved).toHaveLength(1);
  await persistScheduledMeetingChanges(sfu.meetings, sfu.persistence, moved);
};
const readFresh = (sfu: Sfu) =>
  refreshScheduledMeeting(sfu.meetings, sfu.persistence, "conclave", CODE);

describe.each(["sqlite", "json", "redis"] as const)(
  "two SFUs that share a %s schedule store",
  (kind) => {
    const test = kind === "redis" && !redisServerPath ? it.skip : it;

    test("see an invitee's removal on the one that did not make it, once it reads fresh", async () => {
      useStore(kind);
      const sfuA = await startSfu(kind);
      await scheduleIntroCall(sfuA);
      const sfuB = await startSfu(kind);
      expect(isInvited(sfuB)).toBe(true);

      await setRemoved(sfuA, true);
      expect(isInvited(sfuB)).toBe(true);

      await readFresh(sfuB);
      expect(isInvited(sfuB)).toBe(false);
    });

    test("keep the removal when the one that did not make it saves its older copy of the meeting", async () => {
      useStore(kind);
      const sfuA = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfuA);
      const sfuB = await startSfu(kind);
      await setRemoved(sfuA, true);

      await moveOnAndSave(sfuB, meeting.scheduledEndAt + 1_000);

      expect(isInvited(await startSfu(kind))).toBe(false);
      await readFresh(sfuB);
      expect(isInvited(sfuB)).toBe(false);
      await readFresh(sfuA);
      expect(isInvited(sfuA)).toBe(false);
    });

    test("invite them again once a host lets them back in, whatever older copies are saved after", async () => {
      useStore(kind);
      const sfuA = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfuA);
      await setRemoved(sfuA, true);
      const sfuB = await startSfu(kind);
      expect(isInvited(sfuB)).toBe(false);

      await setRemoved(sfuA, false);
      await moveOnAndSave(sfuB, meeting.scheduledEndAt + 1_000);

      expect(isInvited(await startSfu(kind))).toBe(true);
      await readFresh(sfuB);
      expect(isInvited(sfuB)).toBe(true);
    });
  },
);

describe.each(["sqlite", "json", "redis"] as const)("a fence on a %s schedule store", (kind) => {
  const test = kind === "redis" && !redisServerPath ? it.skip : it;
  const fence = (sfu: Sfu, generation: number) =>
    fenceScheduledMeeting(sfu.meetings, sfu.persistence, "conclave", CODE, generation);

  test("refuses a generation older than one that fenced the meeting, and takes that one again", async () => {
    useStore(kind);
    const sfuA = await startSfu(kind);
    await scheduleIntroCall(sfuA);

    expect(await fence(sfuA, 20)).toBe(true);
    expect(await fence(sfuA, 10)).toBe(false);
    expect(await fence(sfuA, 20)).toBe(true);
    expect(await fence(await startSfu(kind), 15)).toBe(false);
  });

  test("lets a room that claims its code again fence only while the fence it held still stands", async () => {
    useStore(kind);
    const sfuA = await startSfu(kind);
    await scheduleIntroCall(sfuA);
    const sfuB = await startSfu(kind);
    const again = (sfu: Sfu, generation: number, held: number) =>
      fenceScheduledMeeting(sfu.meetings, sfu.persistence, "conclave", CODE, generation, held);

    expect(await fence(sfuA, 5)).toBe(true);
    expect(await again(sfuA, 7, 5)).toBe(true);
    expect(await again(sfuA, 7, 5)).toBe(true);

    expect(await fence(sfuB, 8)).toBe(true);
    expect(await again(sfuA, 9, 7)).toBe(false);
    expect(await fence(sfuB, 8)).toBe(true);
  });

  test("lets a room that claims its code again fence a meeting booked after the room opened", async () => {
    useStore(kind);
    const sfuA = await startSfu(kind);
    await scheduleIntroCall(sfuA);

    expect(
      await fenceScheduledMeeting(sfuA.meetings, sfuA.persistence, "conclave", CODE, 7, 5),
    ).toBe(true);
    expect(await fence(sfuA, 6)).toBe(false);
  });
});

describe("the end of a meeting on one SFU and a removal at the next on another", () => {
  const test = redisServerPath ? it : it.skip;

  test("keeps the newer removal when the end's reset reaches Redis after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-11-23T08:00:00Z");
    vi.setSystemTime(startedAt);
    useStore("redis");
    const sfuA = await startSfu("redis");
    await scheduleIntroCall(sfuA);
    const sfuB = await startSfu("redis");
    await setRemoved(sfuA, true);

    // SFU A's writes to Redis are slow from here on.
    const persistenceA = sfuA.persistence as unknown as { start: () => Promise<void> };
    const start = persistenceA.start.bind(persistenceA);
    let goOn: () => void = () => {};
    const slow = new Promise<void>((resolve) => (goOn = resolve));
    persistenceA.start = async () => {
      await slow;
      return start();
    };

    // The meeting ends on SFU A.
    const stateA = createSfuState();
    stateA.scheduledMeetings = sfuA.meetings;
    stateA.scheduledMeetingPersistence = sfuA.persistence;
    vi.setSystemTime(startedAt + 60_000);
    markRoomEnded(
      stateA,
      {
        id: CODE,
        clientId: "conclave",
        channelId: `conclave:${CODE}`,
        markEnded: () => {},
        incarnationId: "room-a",
        takesOverRecordOf: null,
        ownerEmail: null,
      },
      { message: "The host ended this meeting.", endedBy: "host" },
    );

    // The next meeting runs on SFU B, whose host removes the invitee again.
    vi.setSystemTime(startedAt + 120_000);
    await setRemoved(sfuB, true);

    goOn();
    await sfuA.persistence.flush?.();
    expect(isInvited(await startSfu("redis"))).toBe(false);
  });
});

describe.each(["sqlite", "redis"] as const)(
  "a %s store taking back the removals of a meeting that is over",
  (kind) => {
    const test = kind === "redis" && !redisServerPath ? it.skip : it;

    test("takes back only those made at or before the end it applies", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const removedAt = Date.parse("2026-11-23T08:00:00Z");
      vi.setSystemTime(removedAt);
      useStore(kind);
      const sfu = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfu);
      await setRemoved(sfu, true);

      await sfu.persistence.endRemovals?.(meeting.id, removedAt - 1);
      await sfu.persistence.flush?.();
      expect(isInvited(await startSfu(kind))).toBe(false);

      await sfu.persistence.endRemovals?.(meeting.id, removedAt);
      await sfu.persistence.flush?.();
      expect(isInvited(await startSfu(kind))).toBe(true);
    });
  },
);

describe.each(["sqlite", "redis"] as const)(
  "a meeting that ends on an SFU that saw none of its removals, over a %s store",
  (kind) => {
    const test = kind === "redis" && !redisServerPath ? it.skip : it;

    test("still takes back a removal another SFU made before the end and saved after it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const removedAt = Date.parse("2026-11-23T08:00:00Z");
      vi.setSystemTime(removedAt);
      useStore(kind);
      const sfuA = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfuA);
      const sfuB = await startSfu(kind);

      // The meeting failed over to SFU B and ends there. SFU A removed the
      // invitee before that, and its save is still on its way.
      vi.setSystemTime(removedAt + 60_000);
      await endScheduledMeetingRemovals(sfuB.meetings, sfuB.persistence, "conclave", CODE, Date.now());
      await sfuB.persistence.flush?.();
      await sfuA.persistence.setInviteeReadmission?.(meeting.id, INVITEE, true, removedAt);
      await sfuA.persistence.flush?.();

      expect(isInvited(await startSfu(kind))).toBe(true);
    });
  },
);

describe("a json schedule store at the end of a meeting", () => {
  it("invites again the people removed from it", async () => {
    useStore("json");
    const sfu = await startSfu("json");
    await scheduleIntroCall(sfu);
    await setRemoved(sfu, true);

    await endScheduledMeetingRemovals(sfu.meetings, sfu.persistence, "conclave", CODE, Date.now());

    expect(isInvited(await startSfu("json"))).toBe(true);
  });
});

describe("a removal still queued for Redis when its meeting ends", () => {
  const test = redisServerPath ? it : it.skip;

  test("is taken back with the meeting, stamped when the host made it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const removedAt = Date.parse("2026-11-23T08:00:00Z");
    vi.setSystemTime(removedAt);
    useStore("redis");
    const sfu = await startSfu("redis");
    await scheduleIntroCall(sfu);
    // This SFU's writes to Redis are slow from here on.
    const persistence = sfu.persistence as unknown as { start: () => Promise<void> };
    const start = persistence.start.bind(persistence);
    let goOn: () => void = () => {};
    const slow = new Promise<void>((resolve) => (goOn = resolve));
    persistence.start = async () => {
      await slow;
      return start();
    };

    const changed = setScheduledInviteeReadmission(sfu.meetings, "conclave", CODE, INVITEE, true);
    const removing = persistInviteeReadmission(sfu.meetings, sfu.persistence, changed!, INVITEE, true);
    vi.setSystemTime(removedAt + 60_000);
    const ending = endScheduledMeetingRemovals(sfu.meetings, sfu.persistence, "conclave", CODE, Date.now());
    vi.setSystemTime(removedAt + 120_000);
    goOn();
    await removing;
    await ending;

    expect(isInvited(await startSfu("redis"))).toBe(true);
  });
});

// A small seeded generator, so a failing order can be replayed.
const seededRandom = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe.each(["sqlite", "redis", "json"] as const)(
  "removals and readmissions on a %s store, from two SFUs in any order",
  (kind) => {
    const test = kind === "redis" && !redisServerPath ? it.skip : it;
    const invitees = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"];

    test("end at each invitee's newest decision, a removal winning a tie", async () => {
      useStore(kind);
      const sfuA = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfuA);
      const sfuB = await startSfu(kind);

      // Every decision so far: an invitee no round decides about keeps the
      // state an earlier round left.
      const made: Array<{ email: string; removed: boolean; at: number }> = [];
      for (let round = 1; round <= 12; round += 1) {
        const random = seededRandom(round);
        const base = round * 1_000_000;
        const decisions = Array.from({ length: 10 }, () => ({
          email: invitees[Math.floor(random() * invitees.length)],
          removed: random() < 0.5,
          // A narrow range, so stamps collide now and then.
          at: base + Math.floor(random() * 6),
          sfu: random() < 0.5 ? sfuA : sfuB,
        }));
        const delivery = [...decisions].sort(() => random() - 0.5);
        for (const decision of delivery) {
          await decision.sfu.persistence.setInviteeReadmission?.(
            meeting.id,
            decision.email,
            decision.removed,
            decision.at,
          );
          await decision.sfu.persistence.flush?.();
        }

        made.push(...decisions);
        const expected = new Set<string>();
        for (const email of invitees) {
          const newest = made
            .filter((decision) => decision.email === email)
            .sort((x, y) => y.at - x.at || Number(y.removed) - Number(x.removed))[0];
          if (newest?.removed) expected.add(email);
        }
        const reader = await startSfu(kind);
        const removed = new Set(reader.meetings.byId.get(meeting.id)?.readmissionRequiredEmails);
        expect([...removed].sort(), `round ${round}`).toEqual([...expected].sort());
        await reader.persistence.close?.();
        running.splice(running.indexOf(reader), 1);
      }
    }, 60_000);
  },
);

describe("an SFU whose Redis holds no meetings yet", () => {
  const test = redisServerPath ? it : it.skip;

  test("brings its local copy's removed invitees along with the meetings", async () => {
    useStore("redis");
    const localDir = tempDir();
    const before = await startSfu("redis", localDir);
    await scheduleIntroCall(before);
    await setRemoved(before, true);

    vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `test:${process.pid}:emptied`);
    expect(isInvited(await startSfu("redis", localDir))).toBe(false);
    expect(isInvited(await startSfu("redis"))).toBe(false);
  });

  test("hands a claimed reminder's meeting back with its removed invitees", async () => {
    useStore("redis");
    const sfu = await startSfu("redis");
    const meeting = await scheduleIntroCall(sfu);
    const HOUR_MS = 60 * 60 * 1000;
    Object.assign(meeting, {
      source: "booking_link",
      status: "scheduled",
      createdAt: Date.now() - 2 * HOUR_MS,
      scheduledStartAt: Date.now() + HOUR_MS / 2,
      scheduledEndAt: Date.now() + HOUR_MS,
      updatedAt: Date.now(),
    });
    await persistScheduledMeetingChanges(sfu.meetings, sfu.persistence, [meeting]);
    await setRemoved(sfu, true);

    const claimed = await sfu.persistence.claimEmailReminder?.({
      meetingId: meeting.id,
      now: Date.now(),
      leadMs: HOUR_MS,
    });
    expect(claimed?.emailReminderStatus).toBe("pending");
    expect(claimed?.readmissionRequiredEmails).toEqual([INVITEE]);
  });
});

const openSqlite = (path: string) => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (file: string) => {
      prepare: (sql: string) => { get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown };
      close: () => void;
    };
  };
  return new DatabaseSync(path);
};

// Before removed invitees had writes of their own, every store kept them as
// a field of the meeting. The JSON file still does. Wherever such a meeting
// is read from, the people in that field stay removed.
describe("removed invitees kept inside the meeting, as stores used to keep them", () => {
  const redisTest = redisServerPath ? it : it.skip;
  // A JSON file holding the meeting with its invitee removed.
  const jsonFileWithRemoval = async () => {
    const dir = useStore("json");
    const sfu = await startSfu("json");
    await scheduleIntroCall(sfu);
    await setRemoved(sfu, true);
    return dir;
  };
  const withRemovalInside = (record: string): string =>
    JSON.stringify({ ...(JSON.parse(record) as object), readmissionRequiredEmails: [INVITEE] });

  // An SFU process that moves the JSON file's meetings into its store and is
  // killed the moment it turns from one kind of write to the other: from
  // meetings to removed invitees, or the other way round.
  const importKilledHalfway = (kind: "sqlite" | "redis") =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          kind === "sqlite"
            ? `
              import { StatementSync } from "node:sqlite";
              const run = StatementSync.prototype.run;
              let first = null;
              StatementSync.prototype.run = function (...args) {
                const sql = this.sourceSQL;
                const write = sql.includes("scheduled_meeting_remov")
                  ? "removal"
                  : sql.includes("INSERT INTO scheduled_meetings")
                    ? "meeting"
                    : null;
                if (write) {
                  first ??= write;
                  if (write !== first) process.kill(process.pid, "SIGKILL");
                }
                return run.apply(this, args);
              };
              const { createScheduledMeetingPersistence } = await import("./server/scheduledMeetings.ts");
              createScheduledMeetingPersistence();
            `
            : `
              const { createScheduledMeetingPersistence } = await import("./server/scheduledMeetings.ts");
              const store = createScheduledMeetingPersistence();
              let first = null;
              const turned = (write) => {
                first ??= write;
                if (write === first) return false;
                void Promise.resolve(store.flush()).finally(() => process.kill(process.pid, "SIGKILL"));
                return true;
              };
              const save = store.save.bind(store);
              const setInviteeReadmission = store.setInviteeReadmission.bind(store);
              store.save = (...args) => (turned("meeting") ? undefined : save(...args));
              store.setInviteeReadmission = (...args) =>
                turned("removal") ? undefined : setInviteeReadmission(...args);
              await store.load();
              await new Promise((done) => setTimeout(done, 60_000));
            `,
        ],
        { cwd: join(import.meta.dirname, ".."), stdio: "ignore" },
      );
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

  it("come along when moving a JSON file into SQLite is cut off between its writes", async () => {
    const dir = await jsonFileWithRemoval();
    useStore("sqlite", dir);
    expect(await importKilledHalfway("sqlite")).toEqual({ code: null, signal: "SIGKILL" });

    expect(isInvited(await startSfu("sqlite"))).toBe(false);
  });

  redisTest("come along when moving into Redis is cut off between its writes", async () => {
    const dir = await jsonFileWithRemoval();
    useStore("redis", dir);
    expect(await importKilledHalfway("redis")).toEqual({ code: null, signal: "SIGKILL" });

    expect(isInvited(await startSfu("redis", dir))).toBe(false);
  });

  it("come along when a JSON file's meetings move into SQLite", async () => {
    const dir = await jsonFileWithRemoval();
    useStore("sqlite", dir);

    expect(isInvited(await startSfu("sqlite"))).toBe(false);
    expect(isInvited(await startSfu("sqlite"))).toBe(false);
  });

  redisTest("come along when a JSON file's meetings move into Redis", async () => {
    const dir = await jsonFileWithRemoval();
    useStore("redis", dir);
    expect(isInvited(await startSfu("redis", dir))).toBe(false);

    // Another host: no JSON file, a local copy of its own, the same Redis.
    vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(tempDir(), "none.json"));
    expect(isInvited(await startSfu("redis"))).toBe(false);
  });

  it("are read from a SQLite row that still carries them, and a host can bring the person back", async () => {
    const dir = useStore("sqlite");
    const meeting = await scheduleIntroCall(await startSfu("sqlite"));
    const db = openSqlite(join(dir, "conclave.sqlite"));
    const row = db
      .prepare("SELECT payload_json FROM scheduled_meetings WHERE id = ?")
      .get(meeting.id) as { payload_json: string };
    db.prepare("UPDATE scheduled_meetings SET payload_json = ? WHERE id = ?").run(
      withRemovalInside(row.payload_json),
      meeting.id,
    );
    db.close();

    const sfu = await startSfu("sqlite");
    expect(isInvited(sfu)).toBe(false);
    await setRemoved(sfu, false);
    expect(isInvited(await startSfu("sqlite"))).toBe(true);
  });

  redisTest("are read from a Redis record that still carries them, and a host can bring the person back", async () => {
    useStore("redis");
    const meeting = await scheduleIntroCall(await startSfu("redis"));
    const client = createClient({ url: process.env.SFU_PERSISTENCE_REDIS_URL });
    await client.connect();
    const key = `${process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX}:scheduled-meetings`;
    const record = await client.hGet(key, meeting.id);
    await client.hSet(key, meeting.id, withRemovalInside(record!));
    await client.quit();

    const sfu = await startSfu("redis");
    expect(isInvited(sfu)).toBe(false);
    await setRemoved(sfu, false);
    expect(isInvited(await startSfu("redis"))).toBe(true);
  });

  // What builds of this PR before removed invitees had writes of their own
  // do when they save a meeting: write their copy with the list inside.
  const earlierBuildSaves = async (kind: "sqlite" | "redis", dir: string, meetingId: string, carried: string[]) => {
    const inside = (record: string) =>
      JSON.stringify({ ...(JSON.parse(record) as object), readmissionRequiredEmails: carried });
    if (kind === "sqlite") {
      const db = openSqlite(join(dir, "conclave.sqlite"));
      const row = db
        .prepare("SELECT payload_json FROM scheduled_meetings WHERE id = ?")
        .get(meetingId) as { payload_json: string };
      db.prepare("UPDATE scheduled_meetings SET payload_json = ? WHERE id = ?").run(
        inside(row.payload_json),
        meetingId,
      );
      db.close();
      return;
    }
    const client = createClient({ url: process.env.SFU_PERSISTENCE_REDIS_URL });
    await client.connect();
    const key = `${process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX}:scheduled-meetings`;
    const record = await client.hGet(key, meetingId);
    await client.hSet(key, meetingId, inside(record!));
    await client.quit();
  };

  for (const kind of ["sqlite", "redis"] as const) {
    const storeTest = kind === "redis" ? redisTest : it;
    storeTest(`stay let back in on ${kind} when an earlier build saves its old copy with the list inside`, async () => {
      const dir = useStore(kind);
      const sfu = await startSfu(kind);
      const meeting = await scheduleIntroCall(sfu);
      await setRemoved(sfu, true);
      await setRemoved(sfu, false);
      expect(isInvited(await startSfu(kind))).toBe(true);

      await earlierBuildSaves(kind, dir, meeting.id, [INVITEE]);

      expect(isInvited(await startSfu(kind))).toBe(true);
    });
  }

  redisTest("are not lost when moving them fails part way", async () => {
    useStore("redis");
    const meeting = await scheduleIntroCall(await startSfu("redis"));
    const client = createClient({ url: process.env.SFU_PERSISTENCE_REDIS_URL });
    await client.connect();
    const prefix = process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX;
    const key = `${prefix}:scheduled-meetings`;
    const record = await client.hGet(key, meeting.id);
    const carried = withRemovalInside(record!);
    await client.hSet(key, meeting.id, carried);
    // A key of the wrong type where the removed invitees go.
    await client.set(`${key}:removed-invitees`, "not a set");

    await startSfu("redis");
    expect(await client.hGet(key, meeting.id)).toBe(carried);

    await client.del(`${key}:removed-invitees`);
    await client.quit();
    expect(isInvited(await startSfu("redis"))).toBe(false);
  });

  redisTest("are not put back by an SFU that read the old record before another moved them", async () => {
    useStore("redis");
    const meeting = await scheduleIntroCall(await startSfu("redis"));
    const client = createClient({ url: process.env.SFU_PERSISTENCE_REDIS_URL });
    await client.connect();
    const key = `${process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX}:scheduled-meetings`;
    const record = await client.hGet(key, meeting.id);
    await client.hSet(key, meeting.id, withRemovalInside(record!));
    await client.quit();

    // A slow SFU: Redis has answered its read of the old record, and it has
    // not acted on that answer yet.
    const slow = {
      persistence: createScheduledMeetingPersistence(),
      meetings: createScheduledMeetingStore(),
    };
    running.push(slow);
    const slowClient = (slow.persistence as unknown as {
      client: { hVals: (key: string) => Promise<string[]> };
    }).client;
    const hVals = slowClient.hVals.bind(slowClient);
    let answered = false;
    let goOn: () => void = () => {};
    const held = new Promise<void>((resolve) => (goOn = resolve));
    slowClient.hVals = async (hashKey) => {
      const values = await hVals(hashKey);
      answered = true;
      await held;
      return values;
    };
    const slowLoading = loadPersistedMeetings(slow.meetings, slow.persistence);
    await vi.waitFor(() => expect(answered).toBe(true), { timeout: 10_000, interval: 10 });

    // Meanwhile another SFU moves the removal, and a host lets the person in.
    const quick = await startSfu("redis");
    expect(isInvited(quick)).toBe(false);
    await setRemoved(quick, false);

    goOn();
    await slowLoading;
    expect(isInvited(slow)).toBe(true);
    expect(isInvited(await startSfu("redis"))).toBe(true);
  });
});

describe("a json schedule store whose file cannot be read", () => {
  it("is replaced by the next save, not left in the way of it", async () => {
    useStore("json");
    const sfu = await startSfu("json");
    await scheduleIntroCall(sfu);
    writeFileSync(process.env.SCHEDULED_MEETINGS_PATH!, "{not json");

    const [meeting] = [...sfu.meetings.byId.values()];
    await persistScheduledMeetingChanges(sfu.meetings, sfu.persistence, [meeting]);

    expect(isInvited(await startSfu("json"))).toBe(true);
  });
});

describe("reading a meeting fresh from the store", () => {
  const withMeeting = () => {
    const meetings = createScheduledMeetingStore();
    const meeting = createScheduledMeeting(
      meetings,
      {
        title: "Intro call",
        scheduledStartAt: Date.now(),
        roomCode: "abc-mnop-xyz",
        hostEmail: "host@example.com",
        attendeeEmail: "invitee@example.com",
      },
      {
        clientId: "conclave",
        createdBy: "host@example.com",
        defaultHostEmail: "host@example.com",
        defaultHostUserId: null,
      },
    );
    return { meetings, meeting };
  };
  const stored = (loadOne: ScheduledMeetingPersistence["loadOne"]) =>
    ({ save: () => {}, load: () => [], loadOne }) satisfies ScheduledMeetingPersistence;
  const invited = (meetings: ReturnType<typeof withMeeting>["meetings"]) =>
    isScheduledMeetingInvitee(meetings, "conclave", "abc-mnop-xyz", "invitee@example.com");

  it("keeps this SFU's copy of the meeting when the store's is older, but takes the store's removed invitees", async () => {
    const { meetings, meeting } = withMeeting();
    const older = {
      ...meeting,
      title: "Intro call, as first saved",
      readmissionRequiredEmails: ["invitee@example.com"],
      updatedAt: meeting.updatedAt - 1,
    };
    await refreshScheduledMeeting(meetings, stored(() => older), "conclave", "abc-mnop-xyz");
    expect(meetings.byId.get(meeting.id)?.title).toBe("Intro call");
    expect(invited(meetings)).toBe(false);
  });

  it("keeps this SFU's copy when the store fails or cannot be read one meeting at a time", async () => {
    const { meetings } = withMeeting();
    await refreshScheduledMeeting(
      meetings,
      stored(() => {
        throw new Error("store down");
      }),
      "conclave",
      "abc-mnop-xyz",
    );
    await refreshScheduledMeeting(
      meetings,
      { save: () => {}, load: () => [] },
      "conclave",
      "abc-mnop-xyz",
    );
    expect(invited(meetings)).toBe(true);
  });

  it("does not keep a room waiting on a store that never answers", async () => {
    vi.useFakeTimers();
    const { meetings } = withMeeting();
    const refreshed = refreshScheduledMeeting(
      meetings,
      stored(() => new Promise(() => {})),
      "conclave",
      "abc-mnop-xyz",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refreshed).resolves.toBeUndefined();
    expect(invited(meetings)).toBe(true);
  });
});
