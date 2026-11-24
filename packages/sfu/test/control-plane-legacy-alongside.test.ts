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
const SEEDS = Number(process.env.CONTROL_PLANE_LEGACY_SEEDS ?? 25);
const SEED_FROM = Number(process.env.CONTROL_PLANE_LEGACY_SEED_FROM ?? 1);
const STEPS = Number(process.env.CONTROL_PLANE_LEGACY_STEPS ?? 30);
const TIMEOUT_MS = Number(process.env.CONTROL_PLANE_LEGACY_TIMEOUT_MS ?? 600_000);

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
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-legacy-alongside-"));
  usePaths(dir);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH", "CONCLAVE_FALLBACK_IMPORT_DIR"]) {
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

const prng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

type Copy = { title: string; stamp: number | null };

const sameCopy = (a: Copy | undefined, b: Copy | undefined) =>
  a !== undefined && b !== undefined && a.title === b.title && a.stamp === b.stamp;

const runSequence = async (mode: OldMode, seed: number) => {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const ids = ["m1", "m2", "m3", "m4", "m5"];
  const old = await oldSfu(mode);
  const legacy = new Map<string, Copy>();
  const baseline = new Map<string, Copy>();
  const live = new Map<string, Copy>();
  const dirty = new Set<string>();
  const deletedHere = new Set<string>();
  const trace: string[] = [];
  let store: ControlPlaneStore | null = null;

  const expectedImport = (): string[] => {
    const conflicts: string[] = [];
    for (const id of new Set([...legacy.keys(), ...baseline.keys()])) {
      const now = legacy.get(id);
      if (baseline.has(id) && sameCopy(baseline.get(id), now)) continue;
      if (!now) {
        baseline.delete(id);
        if (!live.has(id)) continue;
        if (dirty.has(id)) {
          conflicts.push(`meeting ${id}`);
        } else {
          live.delete(id);
          deletedHere.add(id);
        }
        continue;
      }
      baseline.set(id, now);
      if (!live.has(id)) {
        if (deletedHere.has(id)) {
          conflicts.push(`meeting ${id}`);
        } else {
          live.set(id, now);
          dirty.delete(id);
        }
        continue;
      }
      if (sameCopy(live.get(id), now)) continue;
      if (dirty.has(id)) {
        conflicts.push(`meeting ${id}`);
        continue;
      }
      live.set(id, now);
      dirty.delete(id);
    }
    return conflicts.sort();
  };

  const check = async (label: string) => {
    for (const id of ids) {
      const actual = await store!.read(meetingById(id));
      expect(actual?.title ?? null, `${label}: meeting ${id} after ${trace.join(", ")}`).toBe(live.get(id)?.title ?? null);
    }
  };

  for (let step = 0; step < STEPS; step += 1) {
    const roll = random();
    const id = pick(ids);
    if (roll < 0.3 || !store) {
      const copy = { title: `old ${step}`, stamp: Math.floor(random() * 1000) + 1 };
      if (random() < 0.25 && legacy.has(id)) {
        trace.push(`old removes ${id}`);
        await old.removeMeeting(id);
        legacy.delete(id);
      } else {
        trace.push(`old writes ${id} as ${copy.title}@${copy.stamp}`);
        await old.putMeeting(legacyMeeting(id, { title: copy.title, updatedAt: copy.stamp }));
        legacy.set(id, copy);
      }
      if (store) continue;
    }
    if (!store || roll >= 0.8) {
      warn.mockClear();
      trace.push("restart");
      store = store ? await restart(store) : await start();
      const expectedConflicts = expectedImport();
      await check(`seed ${seed} step ${step}`);
      expect(conflictsLogged().sort(), `seed ${seed} step ${step} conflicts after ${trace.join(", ")}`).toEqual(expectedConflicts);
      continue;
    }
    if (!live.has(id)) continue;
    if (roll < 0.65) {
      trace.push(`live edits ${id}`);
      const result = await store.commit(updateMeeting(id, { title: `live ${step}` }, admin));
      expect(result.ok).toBe(true);
      live.set(id, { title: `live ${step}`, stamp: null });
      dirty.add(id);
    } else {
      trace.push(`live deletes ${id}`);
      const result = await store.commit(deleteMeeting(id, admin));
      expect(result.ok).toBe(true);
      live.delete(id);
      deletedHere.add(id);
      dirty.add(id);
    }
  }
  await check(`seed ${seed} end`);
  await old.close();
  olds.splice(olds.indexOf(old), 1);
  if (store) {
    stores.splice(stores.indexOf(store), 1);
    await store.close();
  }
};

describe.each(modes)("seeded old-SFU and live changes on a %s store", (mode) => {
  beforeEach(() => useMode(mode));

  it(`loses no change silently across ${SEEDS} sequences of ${STEPS} steps`, async () => {
    for (let seed = SEED_FROM; seed < SEED_FROM + SEEDS; seed += 1) {
      usePaths(join(dir, `seed-${seed}`));
      await runSequence(mode, seed);
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
