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
  createScheduledMeeting,
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

  redisTest("come along when the JSON file is all an SFU has besides Redis", async () => {
    const dir = await jsonFileWithRemoval();
    useStore("redis", dir);
    // No SQLite can be opened under a path that runs through a file.
    const unusable = join(dir, "scheduled-meetings.json", "no-such-folder");
    expect(isInvited(await startSfu("redis", unusable))).toBe(false);

    vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(tempDir(), "none.json"));
    expect(isInvited(await startSfu("redis"))).toBe(false);
  });

  it("are read from a SQLite row that still carries them, and a host can bring the person back", async () => {
    const dir = useStore("sqlite");
    const meeting = await scheduleIntroCall(await startSfu("sqlite"));
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare: (sql: string) => { get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown };
        close: () => void;
      };
    };
    const db = new DatabaseSync(join(dir, "conclave.sqlite"));
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
