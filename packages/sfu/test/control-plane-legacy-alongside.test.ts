import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLegacyImport } from "../server/controlPlane/legacyImport.js";
import { deleteMeeting, meetingById, updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { profileForUser, updateHostProfile } from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { webinarById } from "../server/controlPlane/webinarCommands.js";
import {
  legacyMeeting,
  legacyProfile,
  legacyWebinar,
  startOldSfu,
  type OldMode,
  type OldSfu,
} from "./support/oldSfu.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const admin = { email: null, isAdmin: true };
const modes: OldMode[] = hasRedis ? ["sqlite", "json", "redis"] : ["sqlite", "json"];

let redis: RedisServer | null = null;
let dir = "";
let root = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const stores: ControlPlaneStore[] = [];
const olds: OldSfu[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6760);
});

afterAll(() => {
  redis?.stop();
});

const useMode = (mode: OldMode) => {
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  if (mode === "redis") vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
};

const usePaths = (base: string) => {
  root = base;
  mkdirSync(join(root, "json"), { recursive: true });
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(root, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(root, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(root, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(root, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(root, "json", "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `alongside:${Date.now()}:${Math.random()}`);
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(root, "recordings", "json-fallback-import"));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-legacy-alongside-"));
  usePaths(dir);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
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
    sqlite: join(root, "conclave.sqlite"),
    jsonDir: join(root, "json"),
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

const title = async (store: ControlPlaneStore, id: string) => (await store.read(meetingById(id)))?.title ?? null;

const conflictsLogged = (): string[] =>
  warn.mock.calls
    .map((call) => String(call.join(" ")))
    .flatMap((line) => [...line.matchAll(/legacy (\w+) (\S+) (?:was|is|differs)/g)].map((match) => `${match[1]} ${match[2]}`));

const dataRevs = (store: ControlPlaneStore) =>
  store.read((view) =>
    [...view.all("meeting"), ...view.all("webinar"), ...view.all("profile")].map((stored) => [stored.value.id, stored.rev]),
  );

describe.each(modes)("a %s store beside an old SFU that keeps running during the deploy", (mode) => {
  beforeEach(() => useMode(mode));

  it("takes the old SFU's edits, deletes and new records at its next start, whatever their stamps", async () => {
    const old = await oldSfu(mode);
    await old.putMeeting(legacyMeeting("a"));
    await old.putMeeting(legacyMeeting("b"));
    await old.putWebinar(legacyWebinar("w"));
    await old.putProfile(legacyProfile("p"));
    const first = await start();
    expect(await title(first, "b")).toBe("Meeting b");

    await old.putMeeting(legacyMeeting("a", { title: "Edited there", updatedAt: 50 }));
    await old.removeMeeting("b");
    await old.putMeeting(legacyMeeting("c", { title: "Made there" }));
    await old.putWebinar(legacyWebinar("w", { title: "Webinar edited there", updatedAt: 90 }));
    await old.putProfile(legacyProfile("p", { name: "Renamed there", updatedAt: 200 }));
    const second = await restart(first);

    expect([await title(second, "a"), await title(second, "b"), await title(second, "c")]).toEqual(["Edited there", null, "Made there"]);
    expect((await second.read(webinarById("w")))?.title).toBe("Webinar edited there");
    expect((await second.read(profileForUser("conclave", "user-p")))?.name).toBe("Renamed there");
    expect(await second.read((view) => view.tombstone("meeting", "b"))).not.toBeNull();
    expect(conflictsLogged()).toEqual([]);

    const revs = await dataRevs(second);
    const third = await restart(second);
    expect(await dataRevs(third)).toEqual(revs);
    expect(await title(third, "b")).toBeNull();
  });

  it("keeps this store's change when the old SFU changed the same record, and logs the record", async () => {
    const old = await oldSfu(mode);
    for (const id of ["a", "b", "c"]) await old.putMeeting(legacyMeeting(id));
    await old.putProfile(legacyProfile("p"));
    await old.putProfile(legacyProfile("q"));
    const first = await start();
    expect((await first.commit(updateMeeting("a", { title: "Here" }, admin))).ok).toBe(true);
    expect((await first.commit(updateMeeting("b", { title: "Here" }, admin))).ok).toBe(true);
    expect((await first.commit(deleteMeeting("c", admin))).ok).toBe(true);
    const q = await first.read(profileForUser("conclave", "user-q"));
    expect((await first.commit(updateHostProfile(q!.id, { name: "Renamed here" }))).ok).toBe(true);

    await old.putMeeting(legacyMeeting("a", { title: "There", updatedAt: 900 }));
    await old.removeMeeting("b");
    await old.putMeeting(legacyMeeting("c", { title: "There", updatedAt: 900 }));
    await old.removeProfile("p");
    await old.removeProfile("q");
    const second = await restart(first);

    expect([await title(second, "a"), await title(second, "b"), await title(second, "c")]).toEqual(["Here", "Here", null]);
    expect(await second.read(profileForUser("conclave", "user-p"))).toBeNull();
    expect((await second.read(profileForUser("conclave", "user-q")))?.name).toBe("Renamed here");
    expect(conflictsLogged().sort()).toEqual(["meeting a", "meeting b", "meeting c", "profile q"]);

    warn.mockClear();
    await restart(second);
    expect(conflictsLogged()).toEqual([]);
  });
});

describe.skipIf(!hasRedis)("a Redis store beside an old SFU on Redis", () => {
  beforeEach(() => useMode("redis"));

  it("follows the old Redis meetings after the old SFU removes the last one, and never reads the SQLite mirror", async () => {
    const old = await oldSfu("redis");
    await old.putMeeting(legacyMeeting("a"));
    const first = await start();
    expect(await title(first, "a")).toBe("Meeting a");
    const mirror = await startOldSfu("sqlite", { sqlite: join(root, "conclave.sqlite"), jsonDir: join(root, "json") });
    await mirror.putMeeting(legacyMeeting("mirror-only", { title: "Stale mirror" }));
    await mirror.putMeeting(legacyMeeting("a", { title: "Stale mirror" }));

    await old.removeMeeting("a");
    const second = await restart(first);
    expect(await title(second, "a")).toBeNull();
    expect(await title(second, "mirror-only")).toBeNull();
  });
});

describe("two SFUs importing the old store at once", () => {
  beforeEach(() => useMode("sqlite"));

  it("let the import that started last decide, so a slow import never writes an older view", async () => {
    const old = await oldSfu("sqlite");
    await old.putMeeting(legacyMeeting("a", { title: "First" }));
    const store = await start();
    const config = resolveControlPlaneConfig();
    await old.putMeeting(legacyMeeting("a", { title: "Second", updatedAt: 200 }));
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readDone = () => {};
    const slowRead = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    const slow = runLegacyImport(store, {
      mode: "sqlite",
      paths: config.legacy,
      read: async (run) => {
        const view = await run();
        readDone();
        await held;
        return view;
      },
    });
    await slowRead;
    await old.putMeeting(legacyMeeting("a", { title: "Third", updatedAt: 300 }));
    expect(await runLegacyImport(store, { mode: "sqlite", paths: config.legacy })).toMatchObject({ refreshed: 1, superseded: false });
    release();
    expect(await slow).toMatchObject({ superseded: true });
    expect(await title(store, "a")).toBe("Third");
  });
});
