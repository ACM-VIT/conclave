import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLegacyImport } from "../server/controlPlane/legacyImport.js";
import { deleteMeeting, meetingById, updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import { disconnectHostCalendar, hostCalendar } from "../server/controlPlane/schedulingCommands.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import type { RedisPersistenceClient } from "../server/redisPersistence.js";
import { legacyCalendar, legacyMeeting, legacyProfile, startOldSfu, type OldMode, type OldSfu } from "./support/oldSfu.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

const SECRET = "import-model-secret";
const admin = { email: null, isAdmin: true };
const modes: OldMode[] = hasRedis ? ["sqlite", "json", "redis"] : ["sqlite", "json"];
const SEEDS = Number(process.env.CONTROL_PLANE_IMPORT_SEEDS ?? 8);
const SEED_FROM = Number(process.env.CONTROL_PLANE_IMPORT_SEED_FROM ?? 1);
const STEPS = Number(process.env.CONTROL_PLANE_IMPORT_STEPS ?? 40);
const TIMEOUT_MS = Number(process.env.CONTROL_PLANE_IMPORT_TIMEOUT_MS ?? 600_000);

let redis: RedisServer | null = null;
let dir = "";
let root = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const stores = new Set<ControlPlaneStore>();
const olds: OldSfu[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(6920);
});

afterAll(() => {
  redis?.stop();
});

const usePaths = (base: string) => {
  root = base;
  mkdirSync(join(root, "json"), { recursive: true });
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(root, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(root, "control-plane.json"));
  vi.stubEnv("SCHEDULING_PATH", join(root, "json", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(root, "json", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(root, "json", "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", `import-model:${Date.now()}:${Math.random()}`);
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(root, "recordings", "json-fallback-import"));
};

const useMode = (mode: OldMode) => {
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  if (mode === "redis") vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-import-model-"));
  usePaths(dir);
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", SECRET);
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of [...stores]) await store.close().catch(() => {});
  stores.clear();
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

const open = async (importLegacy = true): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig(), { importLegacy });
  stores.add(store);
  return store;
};

const shut = async (store: ControlPlaneStore) => {
  stores.delete(store);
  await store.close();
};

const fallback = () => join(root, "recordings", "json-fallback-import");

let archiveClock = 0;
const archiveName = (deployId: string) => `20261124T${String((archiveClock += 1)).padStart(9, "0")}Z-${deployId}`;

type ContainerState = { meetings: Map<string, { title: string; stamp: number }>; calendars: Map<string, { identity: string; stamp: number }> };

const writeSnapshot = (service: string, deployId: string, state: ContainerState): string => {
  const folder = join(fallback(), service, archiveName(deployId));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "scheduled-meetings.json"),
    JSON.stringify([...state.meetings].map(([id, meeting]) => legacyMeeting(id, { title: meeting.title, updatedAt: meeting.stamp }))),
  );
  writeFileSync(
    join(folder, "scheduling.json"),
    JSON.stringify({
      profiles: [],
      availability: [],
      eventTypes: [],
      calendars: [...state.calendars].map(([host, calendar]) => legacyCalendar(host, SECRET, { id: calendar.identity, updatedAt: calendar.stamp })),
    }),
  );
  return folder;
};

const leftCopies = (): string[] => {
  if (!existsSync(fallback())) return [];
  const found: string[] = [];
  const walk = (path: string, prefix: string) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) walk(child, `${prefix}${name}/`);
      else if (!name.includes(".adopted")) found.push(`${prefix}${name}`);
    }
  };
  walk(fallback(), "");
  return found.sort();
};

const unadopt = (): string[] => {
  const folders: string[] = [];
  if (!existsSync(fallback())) return folders;
  for (const service of readdirSync(fallback())) {
    for (const archive of readdirSync(join(fallback(), service))) {
      const folder = join(fallback(), service, archive);
      if (!statSync(folder).isDirectory()) continue;
      let any = false;
      for (const name of readdirSync(folder)) {
        const match = /^(.+\.json)\.adopted(?:-[0-9a-f]+)?$/.exec(name);
        if (!match) continue;
        renameSync(join(folder, name), join(folder, match[1]));
        any = true;
      }
      if (any) folders.push(`${service}/${archive}`);
    }
  }
  return folders;
};

const conflictsLogged = (): string[] =>
  warn.mock.calls
    .map((call) => String(call.join(" ")))
    .flatMap((line) => [...line.matchAll(/legacy (\w+) (\S+) (?:was|is|differs)/g)].map((match) => `${match[1]} ${match[2]}`));

const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

class Crash extends Error {}

const crashingAt = (inner: ControlPlaneStore, at: number, after: boolean): ControlPlaneStore => {
  let commits = 0;
  return {
    mode: inner.mode,
    read: (query) => inner.read(query),
    close: () => inner.close(),
    commit: async (command) => {
      commits += 1;
      if (commits === at && !after) throw new Crash(`crashed before import commit ${at}`);
      const result = await inner.commit(command);
      if (commits === at && after) throw new Crash(`crashed after import commit ${at}`);
      return result;
    },
  };
};

const legacyRedisFor = async (mode: OldMode) => {
  const client = mode === "redis" ? createClient({ url: redis!.url }) : null;
  if (client) await client.connect();
  return {
    option: client ? { client: client as unknown as RedisPersistenceClient, prefix: String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX) } : undefined,
    quit: async () => {
      await client?.quit().catch(() => {});
    },
  };
};

const importThatCrashes = async (
  mode: OldMode,
  at: number,
  after: boolean,
  redisOption?: { client: RedisPersistenceClient; prefix: string },
): Promise<boolean> => {
  const inner = await open(false);
  try {
    await runLegacyImport(crashingAt(inner, at, after), {
      mode,
      paths: resolveControlPlaneConfig().legacy,
      redis: redisOption,
      pollMs: 5,
    });
    return false;
  } catch (error) {
    if (error instanceof Crash) return true;
    throw error;
  } finally {
    await shut(inner);
  }
};

describe.each(modes)("Greptile's import cases on a %s store", (mode) => {
  beforeEach(() => useMode(mode));

  it("drop a meeting the old container deleted between its before-stop and after-stop copies", async () => {
    const before: ContainerState = {
      meetings: new Map([
        ["kept", { title: "Kept", stamp: 100 }],
        ["gone", { title: "Deleted before the stop", stamp: 100 }],
      ]),
      calendars: new Map(),
    };
    writeSnapshot("sfu-a", "sfu-deploy-1", before);
    before.meetings.delete("gone");
    writeSnapshot("sfu-a", "sfu-deploy-1", before);
    const store = await open();
    expect((await store.read(meetingById("kept")))?.title).toBe("Kept");
    expect(await store.read(meetingById("gone"))).toBeNull();
    expect(leftCopies()).toEqual([]);
  });

  it("delete a meeting a later copy of the same container drops, after an earlier start imported the first copy", async () => {
    const state: ContainerState = { meetings: new Map([["gone", { title: "Deleted later", stamp: 100 }]]), calendars: new Map() };
    writeSnapshot("sfu-a", "sfu-deploy-1", state);
    const first = await open();
    expect((await first.read(meetingById("gone")))?.title).toBe("Deleted later");
    state.meetings.delete("gone");
    writeSnapshot("sfu-a", "sfu-deploy-1", state);
    await shut(first);
    const second = await open();
    expect(await second.read(meetingById("gone"))).toBeNull();
  });

  it("keep a meeting a later copy added when a restart replays both copies an import did not mark adopted", async () => {
    const state: ContainerState = { meetings: new Map(), calendars: new Map() };
    writeSnapshot("sfu-a", "sfu-deploy-1", state);
    state.meetings.set("late", { title: "Made between the copies", stamp: 100 });
    writeSnapshot("sfu-a", "sfu-deploy-1", state);
    const first = await open();
    expect((await first.read(meetingById("late")))?.title).toBe("Made between the copies");
    await shut(first);
    expect(unadopt()).toHaveLength(2);
    const second = await open();
    expect((await second.read(meetingById("late")))?.title).toBe("Made between the copies");
    expect(leftCopies()).toEqual([]);
  });

  it("end an import that crashed at any commit, before or after it landed, with each copy applied once", async () => {
    const legacy = await legacyRedisFor(mode);
    let crashes = 0;
    try {
      for (const after of [false, true]) {
        for (let at = 1; ; at += 1) {
          usePaths(join(dir, `crash-${after ? "after" : "before"}-${at}`));
          const state: ContainerState = {
            meetings: new Map([
              ["kept", { title: "Kept", stamp: 100 }],
              ["gone", { title: "Deleted between the copies", stamp: 100 }],
            ]),
            calendars: new Map(),
          };
          writeSnapshot("sfu-a", "sfu-deploy-1", state);
          state.meetings.set("late", { title: "Made between the copies", stamp: 200 });
          state.meetings.delete("gone");
          writeSnapshot("sfu-a", "sfu-deploy-1", state);
          const crashed = await importThatCrashes(mode, at, after, legacy.option);
          const label = `${crashed ? "crashed" : "finished"} ${after ? "after" : "before"} commit ${at}`;
          for (const replay of ["", ", then a replay of both copies"]) {
            if (replay) expect(unadopt(), label).toHaveLength(2);
            const store = await open();
            expect((await store.read(meetingById("late")))?.title, label + replay).toBe("Made between the copies");
            expect((await store.read(meetingById("kept")))?.title, label + replay).toBe("Kept");
            expect(await store.read(meetingById("gone")), label + replay).toBeNull();
            expect(leftCopies(), label + replay).toEqual([]);
            await shut(store);
          }
          if (!crashed) break;
          crashes += 1;
        }
      }
    } finally {
      await legacy.quit();
    }
    expect(crashes).toBeGreaterThanOrEqual(6);
  });

  it("keep every connection a host disconnected deleted, not only the last", async () => {
    const old = await oldSfu(mode);
    await old.putProfile(legacyProfile("p"));
    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-a", updatedAt: 100 }));
    const first = await open();
    expect((await first.commit(disconnectHostCalendar("p"))).ok).toBe(true);
    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-b", updatedAt: 200 }));
    await shut(first);
    const second = await open();
    expect((await second.read(hostCalendar("p")))?.id).toBe("connection-b");
    expect((await second.commit(disconnectHostCalendar("p"))).ok).toBe(true);
    await old.putCalendar(legacyCalendar("p", SECRET, { id: "connection-a", updatedAt: 300 }));
    warn.mockClear();
    await shut(second);
    const third = await open();
    expect(await third.read(hostCalendar("p"))).toBeNull();
    expect(conflictsLogged()).toEqual(["calendar p"]);
  });
});

describe.each(modes.filter((mode) => mode !== "json"))("a claim another SFU takes over on a %s store", (mode) => {
  beforeEach(() => useMode(mode));

  it("does not stop startup; the newer import imports the copy", async () => {
    writeSnapshot("sfu-a", "sfu-deploy-1", { meetings: new Map([["m", { title: "Copied", stamp: 100 }]]), calendars: new Map() });
    const config = resolveControlPlaneConfig();
    const legacyRedis = mode === "redis" ? createClient({ url: redis!.url }) : null;
    if (legacyRedis) await legacyRedis.connect();
    const redisOption = legacyRedis
      ? { client: legacyRedis as unknown as RedisPersistenceClient, prefix: String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX) }
      : undefined;
    try {
      const [storeA, storeB] = [await open(false), await open(false)];
      const [claimedA, releaseA] = [gate(), gate()];
      const importA = runLegacyImport(storeA, {
        mode,
        paths: config.legacy,
        redis: redisOption,
        pollMs: 5,
        afterClaim: async () => {
          claimedA.open();
          await releaseA.opened;
        },
      });
      const paused = await Promise.race([claimedA.opened.then(() => true), importA.then(() => false, () => false)]);
      expect(paused, "the import offers no point between its claim and its read").toBe(true);
      expect(await runLegacyImport(storeB, { mode, paths: config.legacy, redis: redisOption })).toMatchObject({ superseded: false, inserted: 1 });
      releaseA.open();
      await expect(importA).resolves.toMatchObject({ superseded: true });
      expect((await storeA.read(meetingById("m")))?.title).toBe("Copied");
      expect(leftCopies()).toEqual([]);
    } finally {
      await legacyRedis?.quit();
    }
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

type Copy = { identity: string; tag: string; stamp: number };

type Live = Copy & { dirty: boolean };

type Entry = { live?: Live; removals: Copy[]; tomb: boolean; baselines: Map<string, Copy> };

type View = Map<string, Copy>;

type Snapshot = { source: string; order: string; view: View };

const same = (a: Copy | undefined, b: Copy | undefined) =>
  a !== undefined && b !== undefined && a.identity === b.identity && a.tag === b.tag && a.stamp === b.stamp;

const runSequence = async (mode: OldMode, seed: number) => {
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const config = resolveControlPlaneConfig();
  const old = await oldSfu(mode);
  const legacyRedis = mode === "redis" ? createClient({ url: redis!.url }) : null;
  if (legacyRedis) await legacyRedis.connect();
  const redisOption = legacyRedis
    ? { client: legacyRedis as unknown as RedisPersistenceClient, prefix: String(process.env.SFU_PERSISTENCE_REDIS_KEY_PREFIX) }
    : undefined;
  const meetingIds = ["m1", "m2", "m3"];
  const hosts = ["p0", "p1"];
  const usedStamps = new Set<number>();
  const stamp = (): number => {
    for (;;) {
      const next = Math.floor(random() * 5000) + 1;
      if (!usedStamps.has(next)) {
        usedStamps.add(next);
        return next;
      }
    }
  };
  const ledger = new Map<string, Entry>();
  const entry = (key: string): Entry => {
    let found = ledger.get(key);
    if (!found) {
      found = { removals: [], tomb: false, baselines: new Map() };
      ledger.set(key, found);
    }
    return found;
  };
  const primary: View = new Map();
  const containers = new Map<string, { deployId: string; generation: number; state: ContainerState }>();
  let pending: Snapshot[] = [];
  let pendingFolders: string[] = [];
  const trace: string[] = [];
  const serving: ControlPlaneStore[] = [];
  let conflicts: string[] = [];

  const conflict = (key: string) => conflicts.push(key.replace(":", " "));

  const reconcile = (source: string, key: string, now: Copy | undefined) => {
    const state = entry(key);
    const base = state.baselines.get(source);
    if (!now) {
      if (!base) return;
      state.baselines.delete(source);
      if (!state.live) return;
      if (!state.live.dirty && same(state.live, base)) {
        state.removals.push(state.live);
        state.live = undefined;
        state.tomb = true;
      } else if (state.live.dirty) {
        conflict(key);
      }
      return;
    }
    if (base && same(base, now)) return;
    const fromHere = base !== undefined && state.live !== undefined && !state.live.dirty && same(state.live, base);
    state.baselines.set(source, now);
    if (!state.live) {
      const matching = state.tomb ? state.removals.filter((removed) => removed.identity === now.identity) : [];
      if (matching.length === 0) state.live = { ...now, dirty: false };
      else if (!matching.some((removed) => same(removed, now))) conflict(key);
      return;
    }
    if (same(state.live, now)) return;
    if (!fromHere && state.live.dirty) {
      conflict(key);
      return;
    }
    if (!fromHere && now.stamp <= state.live.stamp) {
      if (now.stamp === state.live.stamp) conflict(key);
      return;
    }
    state.live = { ...now, dirty: false };
  };

  const applyView = (source: string, view: View) => {
    const keys = new Set([...view.keys(), ...[...ledger].filter(([, state]) => state.baselines.has(source)).map(([key]) => key)]);
    for (const key of keys) reconcile(source, key, view.get(key));
  };

  const expectImport = (primaryView: View, snapshots: Snapshot[]) => {
    applyView("", primaryView);
    for (const snapshot of [...snapshots].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))) {
      applyView(snapshot.source, snapshot.view);
    }
  };

  const check = async (label: string) => {
    const on = serving[0];
    for (const id of meetingIds.concat([...containers.keys()].flatMap((service) => meetingIds.map((m) => `${service}-${m}`)))) {
      const actual = await on.read(meetingById(id));
      const expected = ledger.get(`meeting:${id}`)?.live;
      expect(actual ? `${actual.title}` : null, `${label}: meeting ${id} after ${trace.join(", ")}`).toBe(expected ? expected.tag : null);
    }
    for (const host of hosts) {
      const actual = await on.read(hostCalendar(host));
      const expected = ledger.get(`calendar:${host}`)?.live;
      expect(actual ? `${actual.id}@${actual.updatedAt}` : null, `${label}: calendar ${host} after ${trace.join(", ")}`).toBe(
        expected ? `${expected.identity}@${expected.stamp}` : null,
      );
    }
    expect(leftCopies(), `${label}: copies left after ${trace.join(", ")}`).toEqual(pendingFolders.flatMap((folder) => [`${folder}/scheduled-meetings.json`, `${folder}/scheduling.json`]).sort());
  };

  const snapshotView = (state: ContainerState, service: string): View => {
    const view: View = new Map();
    for (const [id, meeting] of state.meetings) view.set(`meeting:${id}`, { identity: id, tag: meeting.title, stamp: meeting.stamp });
    for (const [host, calendar] of state.calendars) view.set(`calendar:${host}`, { identity: calendar.identity, tag: calendar.identity, stamp: calendar.stamp });
    void service;
    return view;
  };

  const oldStoreChange = async (step: number) => {
    if (random() < 0.55) {
      const id = pick(meetingIds);
      const key = `meeting:${id}`;
      if (primary.has(key) && random() < 0.3) {
        trace.push(`old removes ${id}`);
        await old.removeMeeting(id);
        primary.delete(key);
        return;
      }
      const copy = { identity: id, tag: `old ${step}`, stamp: stamp() };
      trace.push(`old writes ${id} as ${copy.tag}@${copy.stamp}`);
      await old.putMeeting(legacyMeeting(id, { title: copy.tag, updatedAt: copy.stamp }));
      primary.set(key, copy);
      return;
    }
    const host = pick(hosts);
    const key = `calendar:${host}`;
    const current = primary.get(key);
    const roll = random();
    if (current && roll < 0.35) {
      trace.push(`old disconnects ${host}`);
      await old.removeCalendar(host);
      primary.delete(key);
      return;
    }
    const identity = current && roll < 0.6 ? current.identity : `old-${seed}-${step}`;
    const copy = { identity, tag: identity, stamp: stamp() };
    trace.push(`old ${identity === current?.identity ? "refreshes" : "connects"} ${host} as ${identity}@${copy.stamp}`);
    await old.putCalendar(legacyCalendar(host, SECRET, { id: identity, updatedAt: copy.stamp }));
    primary.set(key, copy);
  };

  const containerChange = (step: number) => {
    const service = pick(["sfu-a", "sfu-b"]);
    let container = containers.get(service);
    if (!container || random() < 0.1) {
      const generation = (container?.generation ?? 0) + 1;
      container = { deployId: `sfu-${service}-${seed}-${generation}`, generation, state: { meetings: new Map(), calendars: new Map() } };
      containers.set(service, container);
      trace.push(`a new old container runs as ${service}`);
    }
    const roll = random();
    if (roll < 0.3) {
      const folder = writeSnapshot(service, container.deployId, container.state);
      const name = folder.slice(fallback().length + 1);
      trace.push(`deploy saves ${name}`);
      pending.push({ source: `${service}/${container.deployId}`, order: name.split("/")[1], view: snapshotView(container.state, service) });
      pendingFolders.push(name);
      return;
    }
    if (roll < 0.7) {
      const id = `${service}-${pick(meetingIds)}`;
      if (container.state.meetings.has(id) && random() < 0.35) {
        trace.push(`${service} removes ${id}`);
        container.state.meetings.delete(id);
      } else {
        const next = { title: `${service} ${step}`, stamp: stamp() };
        trace.push(`${service} writes ${id} as ${next.title}@${next.stamp}`);
        container.state.meetings.set(id, next);
      }
      return;
    }
    const host = pick(hosts);
    const current = container.state.calendars.get(host);
    if (current && random() < 0.4) {
      trace.push(`${service} disconnects ${host}`);
      container.state.calendars.delete(host);
      return;
    }
    const identity = current && random() < 0.5 ? current.identity : `${service}-${seed}-${step}`;
    const next = { identity, stamp: stamp() };
    trace.push(`${service} connects ${host} as ${identity}@${next.stamp}`);
    container.state.calendars.set(host, next);
  };

  const oldChange = async (step: number) => {
    if (random() < 0.5) await oldStoreChange(step);
    else containerChange(step);
  };

  const claimAll = () => {
    const claimed = pending;
    pending = [];
    pendingFolders = [];
    return claimed;
  };

  const settle = (label: string) => {
    expect(conflictsLogged().sort(), `${label}: conflicts after ${trace.join(", ")}`).toEqual(conflicts.sort());
  };

  const settleLoosely = (label: string) => {
    const expected = new Set(conflicts);
    for (const logged of conflictsLogged()) {
      expect(expected.has(logged), `${label}: logged ${logged}, which the merged history has no conflict for, after ${trace.join(", ")}`).toBe(true);
    }
  };

  const crashedRestart = async (step: number) => {
    const index = Math.floor(random() * Math.max(serving.length, 1));
    if (serving[index]) {
      await shut(serving[index]);
      serving.splice(index, 1);
    }
    const at = 1 + Math.floor(random() * 10);
    const after = random() < 0.5;
    warn.mockClear();
    conflicts = [];
    const snapshots = claimAll();
    const primaryView = new Map(primary);
    const crashed = await importThatCrashes(mode, at, after, redisOption);
    trace.push(crashed ? `an SFU crashed ${after ? "after" : "before"} import commit ${at}, and restarts` : "an SFU restarts");
    const next = await open();
    expectImport(primaryView, snapshots);
    serving.push(next);
    await check(`seed ${seed} step ${step}`);
    if (crashed) settleLoosely(`seed ${seed} step ${step}`);
    else settle(`seed ${seed} step ${step}`);
  };

  const restartOne = async (step: number) => {
    const index = Math.floor(random() * Math.max(serving.length, 1));
    if (serving[index]) {
      await shut(serving[index]);
      serving.splice(index, 1);
    }
    trace.push("an SFU restarts");
    warn.mockClear();
    conflicts = [];
    const snapshots = claimAll();
    const primaryView = new Map(primary);
    const next = await open();
    expectImport(primaryView, snapshots);
    serving.push(next);
    await check(`seed ${seed} step ${step}`);
    settle(`seed ${seed} step ${step}`);
  };

  const concurrentStarts = async (step: number) => {
    trace.push("two SFUs import at once");
    warn.mockClear();
    conflicts = [];
    const [storeA, storeB] = [await open(false), await open(false)];
    const [pausedA, releaseA] = [gate(), gate()];
    const afterClaim = random() < 0.5;
    const hold = async () => {
      pausedA.open();
      await releaseA.opened;
    };
    const importA = runLegacyImport(storeA, {
      mode,
      paths: config.legacy,
      redis: redisOption,
      pollMs: 5,
      ...(afterClaim
        ? { afterClaim: hold }
        : {
            read: async <T,>(run: () => Promise<T>): Promise<T> => {
              const view = await run();
              await hold();
              return view;
            },
          }),
    });
    const paused = await Promise.race([pausedA.opened.then(() => true), importA.then(() => false, () => false)]);
    expect(paused, `seed ${seed} step ${step}: the first import never paused ${afterClaim ? "after its claim" : "after its read"}`).toBe(true);
    for (let writes = Math.floor(random() * 3); writes > 0; writes -= 1) await oldChange(step);
    const snapshots = claimAll();
    const primaryView = new Map(primary);
    const resultB = await runLegacyImport(storeB, { mode, paths: config.legacy, redis: redisOption, pollMs: 5 });
    expect(resultB, `seed ${seed} step ${step}`).toMatchObject({ superseded: false });
    releaseA.open();
    await expect(importA, `seed ${seed} step ${step}: the superseded SFU failed to start after ${trace.join(", ")}`).resolves.toMatchObject({ superseded: true });
    expectImport(primaryView, snapshots);
    serving.push(storeB, storeA);
    await check(`seed ${seed} step ${step}`);
    settle(`seed ${seed} step ${step}`);
  };

  try {
    for (const host of hosts) await old.putProfile(legacyProfile(host, { userId: `user-${host}` }));
    if (mode === "json") await shut(await open());
    for (let step = 0; step < STEPS; step += 1) {
      const roll = random();
      if (serving.length === 0 || roll < 0.18) {
        if (serving.length > 0 || random() < 0.5) await oldChange(step);
        if (serving.length > 0) continue;
      }
      if (serving.length === 0 || roll < 0.32) {
        const how = random();
        if (mode !== "json" && serving.length > 0 && how < 0.35) await concurrentStarts(step);
        else if (how < 0.65) await crashedRestart(step);
        else await restartOne(step);
        continue;
      }
      if (roll < 0.62) {
        await oldChange(step);
        continue;
      }
      if (roll < 0.66) {
        const replayed = unadopt();
        if (replayed.length > 0) {
          trace.push(`an SFU crashed before marking ${replayed.join(" ")} adopted`);
          pendingFolders.push(...replayed);
        }
        continue;
      }
      const on = pick(serving);
      if (random() < 0.35) {
        const host = pick(hosts);
        const state = entry(`calendar:${host}`);
        if (!state.live) continue;
        trace.push(`live disconnects ${host}`);
        expect((await on.commit(disconnectHostCalendar(host))).ok).toBe(true);
        state.removals.push(state.live);
        state.live = undefined;
        state.tomb = true;
        continue;
      }
      const candidates = [...ledger].filter(([key, state]) => key.startsWith("meeting:") && state.live).map(([key]) => key.slice(8));
      if (candidates.length === 0) continue;
      const id = pick(candidates);
      const state = entry(`meeting:${id}`);
      if (random() < 0.6) {
        trace.push(`live edits ${id}`);
        expect((await on.commit(updateMeeting(id, { title: `live ${step}` }, admin))).ok).toBe(true);
        state.live = { identity: id, tag: `live ${step}`, stamp: -1, dirty: true };
      } else {
        trace.push(`live deletes ${id}`);
        expect((await on.commit(deleteMeeting(id, admin))).ok).toBe(true);
        state.removals.push(state.live!);
        state.live = undefined;
        state.tomb = true;
      }
    }
    if (mode === "json") {
      for (const store of serving.splice(0)) await shut(store);
    }
    await restartOne(STEPS);
  } finally {
    for (const store of serving.splice(0)) await shut(store).catch(() => {});
    await legacyRedis?.quit().catch(() => {});
    await old.close();
    olds.splice(olds.indexOf(old), 1);
  }
};

describe.each(modes)("the seeded import model on a %s store", (mode) => {
  beforeEach(() => useMode(mode));

  it(`ends every import with the merged history of every old source across ${SEEDS} sequences of ${STEPS} steps`, async () => {
    for (let seed = SEED_FROM; seed < SEED_FROM + SEEDS; seed += 1) {
      archiveClock = 0;
      usePaths(join(dir, `seed-${seed}`));
      await runSequence(mode, seed);
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
