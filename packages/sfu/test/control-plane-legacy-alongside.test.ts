import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLegacyImport } from "../server/controlPlane/legacyImport.js";
import { deleteMeeting, meetingById, updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import {
  disconnectHostCalendar,
  hostCalendar,
  profileForUser,
  updateHostProfile,
} from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { webinarById } from "../server/controlPlane/webinarCommands.js";
import { createClient } from "redis";
import type { RedisPersistenceClient } from "../server/redisPersistence.js";
import {
  legacyCalendar,
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

const prng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const SECRET = "alongside-secret";
const MEETINGS = ["m1", "m2", "m3", "m4"];
const HOSTS = ["p0", "p1"];

type Copy = { identity: string; tag: string; stamp: number | null };

type Entry = { legacy?: Copy; baseline?: Copy; live?: Copy; removal?: Copy; dirty: boolean; tomb: boolean };

const sameCopy = (a: Copy | undefined, b: Copy | undefined) =>
  a !== undefined && b !== undefined && a.identity === b.identity && a.tag === b.tag && a.stamp === b.stamp;

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

const runSequence = async (mode: OldMode, seed: number) => {
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const old = await oldSfu(mode);
  const ledger = new Map<string, Entry>();
  const entry = (key: string): Entry => {
    const found = ledger.get(key);
    if (found) return found;
    const created: Entry = { dirty: false, tomb: false };
    ledger.set(key, created);
    return created;
  };
  const trace: string[] = [];
  const config = resolveControlPlaneConfig();
  const fallback = String(config.legacy.fallbackDir);
  type CopyFile = { service: string; records: Array<{ id: string; copy: Copy }>; claimed: boolean };
  let pending: CopyFile[] = [];
  const usedStamps = new Set<number>();
  const freshStamp = (): number => {
    for (;;) {
      const stamp = Math.floor(random() * 3000) + 1;
      if (!usedStamps.has(stamp)) {
        usedStamps.add(stamp);
        return stamp;
      }
    }
  };
  const saveCopy = (step: number) => {
    const service = pick(["sfu-a", "sfu-b"]);
    const records = MEETINGS.filter(() => random() < 0.5).map((id) => ({
      id,
      copy: { identity: id, tag: `copy ${step}`, stamp: freshStamp() },
    }));
    trace.push(`deploy saves ${service} copy ${records.map((record) => `${record.id}@${record.copy.stamp}`).join(" ")}`);
    const path = join(fallback, service, "scheduled-meetings.json");
    mkdirSync(join(fallback, service), { recursive: true });
    writeFileSync(path, JSON.stringify(records.map((record) => legacyMeeting(record.id, { title: record.copy.tag, updatedAt: record.copy.stamp }))));
    pending = pending.filter((file) => file.claimed || file.service !== service);
    pending.push({ service, records, claimed: false });
  };
  const claimPending = () => {
    const claimed = pending;
    pending = [];
    return claimed;
  };
  const legacyRedis = mode === "redis" ? createClient({ url: redis!.url }) : null;
  if (legacyRedis) await legacyRedis.connect();
  const redisOption = legacyRedis
    ? { client: legacyRedis as unknown as RedisPersistenceClient, prefix: String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX) }
    : undefined;
  let store: ControlPlaneStore | null = null;
  try {
    await sequenceSteps();
  } finally {
    if (store) await (store as ControlPlaneStore).close().catch(() => {});
    await legacyRedis?.quit().catch(() => {});
    await old.close();
    olds.splice(olds.indexOf(old), 1);
  }

  async function sequenceSteps(): Promise<void> {
    for (const host of HOSTS) await old.putProfile(legacyProfile(host, { userId: `user-${host}` }));

    const oldChange = async (step: number): Promise<() => void> => {
      if (random() < 0.15) {
        saveCopy(step);
        return () => {};
      }
      if (random() < 0.5) {
        const id = pick(MEETINGS);
        const current = entry(`meeting:${id}`);
        if (random() < 0.25 && current.legacy) {
          trace.push(`old removes ${id}`);
          await old.removeMeeting(id);
          return () => {
            current.legacy = undefined;
          };
        }
        const copy = { identity: id, tag: `old ${step}`, stamp: Math.floor(random() * 1000) + 1 };
        trace.push(`old writes ${id} as ${copy.tag}@${copy.stamp}`);
        await old.putMeeting(legacyMeeting(id, { title: copy.tag, updatedAt: copy.stamp }));
        return () => {
          current.legacy = copy;
        };
      }
      const host = pick(HOSTS);
      const current = entry(`calendar:${host}`);
      const roll = random();
      if (current.legacy && roll < 0.35) {
        trace.push(`old disconnects ${host}`);
        await old.removeCalendar(host);
        return () => {
          current.legacy = undefined;
        };
      }
      const stamp = Math.floor(random() * 1000) + 1;
      const identity = current.legacy && roll < 0.6 ? current.legacy.identity : `conn-${seed}-${step}`;
      const copy = { identity, tag: identity, stamp };
      trace.push(`old ${identity === current.legacy?.identity ? "refreshes" : "connects"} ${host} as ${identity}@${stamp}`);
      await old.putCalendar(legacyCalendar(host, SECRET, { id: identity, updatedAt: stamp }));
      return () => {
        current.legacy = copy;
      };
    };

    const expectedImport = (): string[] => {
      const conflicts: string[] = [];
      for (const [key, state] of ledger) {
        const now = state.legacy;
        if (!now && !state.baseline) continue;
        if (state.baseline && sameCopy(state.baseline, now)) continue;
        if (!now) {
          state.baseline = undefined;
          if (!state.live) continue;
          if (state.dirty) {
            conflicts.push(key.replace(":", " "));
          } else {
            state.removal = state.live;
            state.live = undefined;
            state.tomb = true;
          }
          continue;
        }
        const firstSeen = state.baseline === undefined;
        state.baseline = now;
        if (!state.live) {
          if (!state.tomb || (state.removal && state.removal.identity !== now.identity)) {
            state.live = now;
            state.dirty = false;
          } else if (!sameCopy(state.removal, now)) {
            conflicts.push(key.replace(":", " "));
          }
          continue;
        }
        if (sameCopy(state.live, now)) continue;
        if (state.dirty) {
          conflicts.push(key.replace(":", " "));
          continue;
        }
        if (firstSeen && (now.stamp ?? 0) <= (state.live.stamp ?? 0)) continue;
        state.live = now;
      }
      return conflicts.sort();
    };

    const adoptCopies = (files: CopyFile[]): string[] => {
      const conflicts: string[] = [];
      const winners = new Map<string, Copy>();
      for (const file of files) {
        for (const record of file.records) {
          const held = winners.get(record.id);
          if (!held || (record.copy.stamp ?? 0) > (held.stamp ?? 0)) winners.set(record.id, record.copy);
        }
      }
      for (const [id, copy] of winners) {
        const state = entry(`meeting:${id}`);
        if (state.live && sameCopy(state.live, copy)) continue;
        const superseded = state.baseline !== undefined && (sameCopy(state.baseline, copy) || (copy.stamp ?? 0) < (state.baseline.stamp ?? 0));
        if (!state.live) {
          if (!state.tomb || (state.removal && state.removal.identity !== copy.identity)) {
            state.live = copy;
            state.dirty = false;
          } else if (!sameCopy(state.removal, copy) && !superseded) {
            conflicts.push(`meeting ${id}`);
          }
          continue;
        }
        if (!state.dirty && copy.stamp !== state.live.stamp) {
          if ((copy.stamp ?? 0) > (state.live.stamp ?? 0)) state.live = copy;
          continue;
        }
        if (!superseded) conflicts.push(`meeting ${id}`);
      }
      return conflicts;
    };

    const importAll = (files: CopyFile[]): string[] => [...expectedImport(), ...adoptCopies(files)].sort();

    const checkCopies = (label: string) => {
      const left = existsSync(fallback)
        ? readdirSync(fallback).flatMap((service) =>
            readdirSync(join(fallback, service))
              .filter((name) => !name.includes(".adopted"))
              .map((name) => `${service}/${name}`),
          )
        : [];
      expect(left.sort(), `${label}: copies left after ${trace.join(", ")}`).toEqual(
        pending.map((file) => `${file.service}/scheduled-meetings.json`).sort(),
      );
    };

    const check = async (on: ControlPlaneStore, label: string) => {
      for (const id of MEETINGS) {
        const actual = await on.read(meetingById(id));
        expect(actual?.title ?? null, `${label}: meeting ${id} after ${trace.join(", ")}`).toBe(entry(`meeting:${id}`).live?.tag ?? null);
      }
      for (const host of HOSTS) {
        const actual = await on.read(hostCalendar(host));
        const expected = entry(`calendar:${host}`).live;
        expect(actual ? `${actual.id}@${actual.updatedAt}` : null, `${label}: calendar ${host} after ${trace.join(", ")}`).toBe(
          expected ? `${expected.identity}@${expected.stamp}` : null,
        );
      }
    };

    const expectConflicts = (expected: string[], label: string) => {
      expect(conflictsLogged().sort(), `${label} conflicts after ${trace.join(", ")}`).toEqual(expected);
    };

    const unimported = async () => openControlPlane(config, { importLegacy: false });

    const restartWithWriteDuringImport = async (step: number) => {
      trace.push("restart with an old write during the import");
      if (store) await store.close();
      const next = await unimported();
      const claimed = claimPending();
      let apply: (() => void) | null = null;
      await runLegacyImport(next, {
        mode,
        paths: config.legacy,
        redis: redisOption,
        read: async (run) => {
          const view = await run();
          apply = await oldChange(step);
          return view;
        },
      });
      const conflicts = importAll(claimed);
      (apply as (() => void) | null)?.();
      store = next;
      return conflicts;
    };

    const deployRestart = async (step: number) => {
      trace.push("two SFUs import at once");
      if (store) await store.close();
      const [storeA, storeB] = [await unimported(), await unimported()];
      const [readA, releaseA, readB, releaseB] = [gate(), gate(), gate(), gate()];
      const paused = (read: ReturnType<typeof gate>, release: ReturnType<typeof gate>) =>
        async <T,>(run: () => Promise<T>): Promise<T> => {
          const view = await run();
          read.open();
          await release.opened;
          return view;
        };
      const importA = runLegacyImport(storeA, { mode, paths: config.legacy, redis: redisOption, pollMs: 5, read: paused(readA, releaseA) });
      await readA.opened;
      for (const file of pending) file.claimed = true;
      const apply = await oldChange(step);
      apply();
      const claimed = claimPending();
      const importB = runLegacyImport(storeB, { mode, paths: config.legacy, redis: redisOption, pollMs: 5, read: paused(readB, releaseB) });
      await readB.opened;
      releaseA.open();
      expect(await settledWithin(importA, 25), `seed ${seed} step ${step}: the superseded import served before the newer one finished, after ${trace.join(", ")}`).toBe(false);
      releaseB.open();
      expect(await importB).toMatchObject({ superseded: false });
      expect(await importA).toMatchObject({ superseded: true });
      const conflicts = importAll(claimed);
      await check(storeA, `seed ${seed} step ${step} first SFU`);
      await storeA.close();
      store = storeB;
      return conflicts;
    };

    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      if (roll < 0.35 || !store) {
        (await oldChange(step))();
        if (store) continue;
      }
      if (!store || roll >= 0.8) {
        warn.mockClear();
        const flavor = random();
        let conflicts: string[];
        if (!store || flavor < 0.5) {
          trace.push("restart");
          if (store) await store.close();
          const claimed = claimPending();
          store = await openControlPlane(config);
          conflicts = importAll(claimed);
        } else if (flavor < 0.75 || mode === "json") {
          conflicts = await restartWithWriteDuringImport(step);
        } else {
          conflicts = await deployRestart(step);
        }
        await check(store, `seed ${seed} step ${step}`);
        checkCopies(`seed ${seed} step ${step}`);
        expectConflicts(conflicts, `seed ${seed} step ${step}`);
        continue;
      }
      if (random() < 0.3) {
        const host = pick(HOSTS);
        const current = entry(`calendar:${host}`);
        if (!current.live) continue;
        trace.push(`live disconnects ${host}`);
        expect((await store.commit(disconnectHostCalendar(host))).ok).toBe(true);
        current.removal = current.live;
        current.live = undefined;
        current.tomb = true;
        current.dirty = true;
        continue;
      }
      const id = pick(MEETINGS);
      const current = entry(`meeting:${id}`);
      if (!current.live) continue;
      if (roll < 0.65) {
        trace.push(`live edits ${id}`);
        expect((await store.commit(updateMeeting(id, { title: `live ${step}` }, admin))).ok).toBe(true);
        current.live = { identity: id, tag: `live ${step}`, stamp: null };
        current.dirty = true;
      } else {
        trace.push(`live deletes ${id}`);
        expect((await store.commit(deleteMeeting(id, admin))).ok).toBe(true);
        current.removal = current.live;
        current.live = undefined;
        current.tomb = true;
        current.dirty = true;
      }
    }
    if (store) await check(store, `seed ${seed} end`);
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
