import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLegacyImport } from "../server/controlPlane/legacyImport.js";
import { meetingById } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import {
  disconnectHostCalendar,
  ensureHostProfile,
  hostCalendar,
  profileForUser,
} from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import {
  legacyCalendar,
  legacyMeeting,
  legacyProfile,
  startOldSfu,
  type OldMode,
  type OldSfu,
} from "./support/oldSfu.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const SECRET = "protocol-secret";
const modes: OldMode[] = hasRedis ? ["sqlite", "json", "redis"] : ["sqlite", "json"];

let redis: RedisServer | null = null;
let dir = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const stores: ControlPlaneStore[] = [];
const olds: OldSfu[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6880);
});

afterAll(() => {
  redis?.stop();
});

const useMode = (mode: OldMode) => {
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  if (mode === "redis") vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
};

const importDir = () => join(dir, "recordings", "json-fallback-import");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-import-protocol-"));
  mkdirSync(join(dir, "json"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "json", "scheduled-webinars.json"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `protocol:${Date.now()}:${Math.random()}`);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const old of olds.splice(0)) await old.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const oldSfu = async (mode: OldMode): Promise<OldSfu> => {
  const old = await startOldSfu(mode, {
    sqlite: join(dir, "conclave.sqlite"),
    jsonDir: join(dir, "json"),
    redisUrl: redis?.url,
    prefix: process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX,
  });
  olds.push(old);
  return old;
};

const start = async (): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  stores.push(store);
  return store;
};

const restart = async (store: ControlPlaneStore): Promise<ControlPlaneStore> => {
  stores.splice(stores.indexOf(store), 1);
  await store.close();
  return start();
};

const unimported = async (): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig(), { importLegacy: false });
  stores.push(store);
  return store;
};

const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
};

const conflictsLogged = (): string[] =>
  warn.mock.calls
    .map((call) => String(call.join(" ")))
    .flatMap((line) => [...line.matchAll(/legacy (\w+) (\S+) (?:was|is|differs)/g)].map((match) => `${match[1]} ${match[2]}`));

describe.each(modes)("a %s store following an old SFU's calendar", (mode) => {
  beforeEach(() => useMode(mode));

  it("takes a reconnect the old SFU made after it disconnected the host", async () => {
    const old = await oldSfu(mode);
    await old.putProfile(legacyProfile("p"));
    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-1" }));
    const first = await start();
    expect((await first.read(hostCalendar("p")))?.id).toBe("connection-1");

    await old.removeCalendar("p");
    const second = await restart(first);
    expect(await second.read(hostCalendar("p"))).toBeNull();

    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-2", updatedAt: 400 }));
    const third = await restart(second);
    expect(await third.read(hostCalendar("p"))).toMatchObject({ id: "connection-2", refreshToken: "refresh-token-value" });
    expect(conflictsLogged()).toEqual([]);
  });

  it("takes a connection the old SFU made after the host disconnected here, but not a refresh of the one disconnected", async () => {
    const old = await oldSfu(mode);
    await old.putProfile(legacyProfile("p"));
    await old.putProfile(legacyProfile("q"));
    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-p" }));
    await old.putCalendar(legacyCalendar("q", SECRET, { id: "connection-q" }));
    const first = await start();
    expect((await first.commit(disconnectHostCalendar("p"))).ok).toBe(true);
    expect((await first.commit(disconnectHostCalendar("q"))).ok).toBe(true);

    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-p2", updatedAt: 500 }));
    await old.putCalendar(legacyCalendar("q", SECRET, { id: "connection-q", updatedAt: 500 }));
    const second = await restart(first);

    expect((await second.read(hostCalendar("p")))?.id).toBe("connection-p2");
    expect(await second.read(hostCalendar("q"))).toBeNull();
    expect(conflictsLogged()).toEqual(["calendar q"]);
  });
});

describe("an SFU whose import a newer one superseded", () => {
  beforeEach(() => useMode("sqlite"));

  it("serves nothing until the newer import has finished, so a first visit finds the old profile", async () => {
    const old = await oldSfu("sqlite");
    await old.putProfile(legacyProfile("old-profile", { userId: "host-user" }));
    const [storeA, storeB] = [await unimported(), await unimported()];
    const config = resolveControlPlaneConfig();
    const [readA, releaseA, readB, releaseB] = [gate(), gate(), gate(), gate()];
    const paused = (read: ReturnType<typeof gate>, release: ReturnType<typeof gate>) =>
      async <T>(run: () => Promise<T>): Promise<T> => {
        const view = await run();
        read.open();
        await release.opened;
        return view;
      };

    const importA = runLegacyImport(storeA, { mode: "sqlite", paths: config.legacy, read: paused(readA, releaseA) });
    await readA.opened;
    const importB = runLegacyImport(storeB, { mode: "sqlite", paths: config.legacy, read: paused(readB, releaseB) });
    await readB.opened;
    releaseA.open();

    expect(await settledWithin(importA, 300)).toBe(false);
    releaseB.open();
    expect(await importB).toMatchObject({ superseded: false, inserted: 1 });
    expect(await importA).toMatchObject({ superseded: true });

    const visit = await storeA.commit(
      ensureHostProfile({ clientId: "conclave", userId: "host-user", email: "old-profile@example.test", name: "Host" }, { syncIdentity: false }),
    );
    expect(visit).toMatchObject({ ok: true, value: { id: "old-profile" } });
    expect((await storeB.read(profileForUser("conclave", "host-user")))?.id).toBe("old-profile");
  });

  it("fails loudly when the newer import never finishes", async () => {
    const old = await oldSfu("sqlite");
    await old.putMeeting(legacyMeeting("m"));
    const [storeA, storeB] = [await unimported(), await unimported()];
    const config = resolveControlPlaneConfig();
    const [readB, never] = [gate(), gate()];
    const blockedA = gate();

    const importA = runLegacyImport(storeA, {
      mode: "sqlite",
      paths: config.legacy,
      waitMs: 400,
      read: async (run) => {
        const view = await run();
        await blockedA.opened;
        return view;
      },
    });
    const importB = runLegacyImport(storeB, {
      mode: "sqlite",
      paths: config.legacy,
      read: async (run) => {
        const view = await run();
        readB.open();
        await never.opened;
        return view;
      },
    });
    await readB.opened;
    blockedA.open();

    await expect(importA).rejects.toThrow(/newer legacy import .* did not finish/);
    never.open();
    await importB;
  });
});

const writeCopy = (service: string, meetings: unknown[]) => {
  const path = join(importDir(), service, "scheduled-meetings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(meetings));
  return path;
};

describe("a container copy the deploy replaces while an import runs", () => {
  beforeEach(() => useMode("sqlite"));

  it("is imported at the next start instead of being marked adopted unread", async () => {
    const path = writeCopy("sfu-a", [legacyMeeting("m1", { title: "First copy", updatedAt: 100 })]);
    const store = await unimported();
    const config = resolveControlPlaneConfig();
    let readDone = false;
    let replaced = false;
    const replacing: ControlPlaneStore = {
      mode: store.mode,
      read: (query) => store.read(query),
      close: () => store.close(),
      commit: async (command) => {
        if (readDone && !replaced) {
          replaced = true;
          writeCopy("sfu-a", [
            legacyMeeting("m1", { title: "Second copy", updatedAt: 200 }),
            legacyMeeting("m2", { title: "Only in the second copy", updatedAt: 200 }),
          ]);
        }
        return store.commit(command);
      },
    };
    await runLegacyImport(replacing, {
      mode: "sqlite",
      paths: config.legacy,
      read: async (run) => {
        const view = await run();
        readDone = true;
        return view;
      },
    });
    expect(replaced).toBe(true);

    const next = await restart(store);
    expect((await next.read(meetingById("m1")))?.title).toBe("Second copy");
    expect((await next.read(meetingById("m2")))?.title).toBe("Only in the second copy");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dirname(path)).filter((name) => !name.includes(".adopted"))).toEqual([]);
  });

  it("is taken over by a newer import when an older one claimed it and was superseded", async () => {
    const path = writeCopy("sfu-a", [legacyMeeting("m1", { title: "Copied", updatedAt: 100 })]);
    const [storeA, storeB] = [await unimported(), await unimported()];
    const config = resolveControlPlaneConfig();
    const [readA, releaseA] = [gate(), gate()];

    const importA = runLegacyImport(storeA, {
      mode: "sqlite",
      paths: config.legacy,
      read: async (run) => {
        const view = await run();
        readA.open();
        await releaseA.opened;
        return view;
      },
    });
    await readA.opened;
    await runLegacyImport(storeB, { mode: "sqlite", paths: config.legacy });
    releaseA.open();
    await importA;

    expect((await storeB.read(meetingById("m1")))?.title).toBe("Copied");
    expect(readdirSync(dirname(path)).sort()).toEqual(["scheduled-meetings.json.adopted"]);
  });

  it("is imported by a second round when a superseded import claimed it after the newer import looked", async () => {
    const [storeA, storeB] = [await unimported(), await unimported()];
    const config = resolveControlPlaneConfig();
    const [begunA, releaseA] = [gate(), gate()];
    let commits = 0;
    const pausedAfterBegin: ControlPlaneStore = {
      mode: storeA.mode,
      read: (query) => storeA.read(query),
      close: () => storeA.close(),
      commit: async (command) => {
        const result = await storeA.commit(command);
        commits += 1;
        if (commits === 1) {
          begunA.open();
          await releaseA.opened;
        }
        return result;
      },
    };

    const importA = runLegacyImport(pausedAfterBegin, { mode: "sqlite", paths: config.legacy, pollMs: 10 });
    await begunA.opened;
    expect(await runLegacyImport(storeB, { mode: "sqlite", paths: config.legacy })).toMatchObject({ superseded: false });
    const path = writeCopy("sfu-b", [legacyMeeting("late", { title: "Saved after the newer import looked", updatedAt: 300 })]);
    releaseA.open();

    expect(await importA).toMatchObject({ superseded: true, inserted: 1 });
    expect((await storeB.read(meetingById("late")))?.title).toBe("Saved after the newer import looked");
    expect(readdirSync(dirname(path)).sort()).toEqual(["scheduled-meetings.json.adopted"]);
  });
});
