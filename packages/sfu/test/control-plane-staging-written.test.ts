import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { specOf } from "../server/controlPlane/entities.js";
import { readLegacyDomains, readLegacyFile } from "../server/controlPlane/legacy.js";
import { updateMeeting } from "../server/controlPlane/meetingCommands.js";
import { DATA_KINDS, legacyCopyKey, type LegacyDomain } from "../server/controlPlane/model.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import type { RedisPersistenceClient } from "../server/redisPersistence.js";
import {
  STAGING_LEGACY_MODES,
  STAGING_LEGACY_SECRET,
  stagingLegacyFile,
  verifyStagingLegacyFixtures,
  type RedisDump,
  type SqliteDump,
  type StagingLegacyMode,
  type StagingLegacyPhase,
} from "../scripts/write-staging-legacy-fixtures.js";
import { hasRedis, startRedis, type RedisServer } from "./support/redisServer.js";

type Rows = Record<string, unknown>;

const JSON_FILES = ["scheduling.json", "scheduled-meetings.json", "scheduled-webinars.json"] as const;
const DOMAIN_OF_FILE: Record<(typeof JSON_FILES)[number], LegacyDomain> = {
  "scheduling.json": "scheduling",
  "scheduled-meetings.json": "meetings",
  "scheduled-webinars.json": "webinars",
};
const modes = STAGING_LEGACY_MODES.filter((mode) => mode !== "redis" || hasRedis);

let redis: RedisServer | null = null;
let dir = "";
let prefix = "";
let warn: MockInstance<(...args: unknown[]) => void>;
const stores: ControlPlaneStore[] = [];

beforeAll(async () => {
  if (hasRedis) redis = await startRedis(7040);
});

afterAll(() => {
  redis?.stop();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-staging-written-"));
  prefix = `staging-written:${Date.now()}:${Math.random()}`;
  mkdirSync(join(dir, "old"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", STAGING_LEGACY_SECRET);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", join(dir, "import"));
  vi.stubEnv("SCHEDULING_PATH", join(dir, "old", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "old", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "old", "scheduled-webinars.json"));
  vi.stubEnv("SFU_PERSISTENCE_REDIS_KEY_PREFIX", prefix);
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const useMode = (mode: StagingLegacyMode) => {
  vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
  if (mode === "redis") vi.stubEnv("SFU_PERSISTENCE_REDIS_URL", redis!.url);
};

const loadTables = (dump: SqliteDump) => {
  const db = new DatabaseSync(join(dir, "conclave.sqlite"));
  try {
    for (const [name, table] of Object.entries(dump.tables)) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
      db.exec(table.sql);
      for (const row of table.rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
          ...columns.map((column) => row[column] as string | number | null),
        );
      }
    }
  } finally {
    db.close();
  }
};

const loadRedis = async (dump: RedisDump) => {
  const client = createClient({ url: redis!.url });
  await client.connect();
  try {
    const old = [...(await client.keys(`${prefix}:scheduled-meetings`)), ...(await client.keys(`${prefix}:scheduling:*`))];
    if (old.length > 0) await client.del(old);
    for (const [suffix, entry] of Object.entries(dump.redis)) {
      if (entry.type === "hash") await client.hSet(`${prefix}:${suffix}`, entry.value);
      else await client.set(`${prefix}:${suffix}`, entry.value);
    }
  } finally {
    await client.quit();
  }
};

const loadOld = async (mode: StagingLegacyMode, phase: StagingLegacyPhase) => {
  if (mode === "json") {
    for (const file of JSON_FILES) {
      const source = stagingLegacyFile(mode, phase, file);
      if (existsSync(source)) copyFileSync(source, join(dir, "old", file));
      else rmSync(join(dir, "old", file), { force: true });
    }
    return;
  }
  const dump = JSON.parse(readFileSync(stagingLegacyFile(mode, phase), "utf8")) as RedisDump;
  loadTables(dump);
  if (mode === "redis") await loadRedis(dump);
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

const stored = (store: ControlPlaneStore): Promise<Rows> =>
  store.read((view) =>
    Object.fromEntries(
      DATA_KINDS.flatMap((kind) =>
        view.all(kind).map((entry) => [legacyCopyKey(kind, specOf(kind).id(entry.value as never)), entry.value]),
      ),
    ),
  );

const decodedOld = async (mode: StagingLegacyMode): Promise<Rows> => {
  const legacyRedis = mode === "redis" ? createClient({ url: redis!.url }) : null;
  if (legacyRedis) await legacyRedis.connect();
  try {
    const domains = await readLegacyDomains({
      mode,
      paths: resolveControlPlaneConfig().legacy,
      redis: legacyRedis ? { client: legacyRedis as unknown as RedisPersistenceClient, prefix } : undefined,
    });
    return Object.fromEntries(domains.flatMap((domain) => domain.records ?? []).map((record) => [record.key, record.value]));
  } finally {
    await legacyRedis?.quit();
  }
};

const decodedFiles = (phase: StagingLegacyPhase): Rows =>
  Object.fromEntries(
    JSON_FILES.flatMap((file) =>
      readLegacyFile(DOMAIN_OF_FILE[file], readFileSync(stagingLegacyFile("json", phase, file), "utf8"), file),
    ).map((record) => [record.key, record.value]),
  );

const importWarnings = () =>
  warn.mock.calls.map((call) => String(call.join(" "))).filter((line) => /legacy |kept without|skipped an unreadable/.test(line));

const dataRevs = (store: ControlPlaneStore) =>
  store.read((view) => DATA_KINDS.flatMap((kind) => view.all(kind).map((entry) => `${kind}:${entry.rev}`)).sort());

const titled = (rows: Rows, title: string) =>
  Object.entries(rows).find(([key, value]) => key.startsWith("meeting:") && (value as { title?: string }).title === title);

describe("the staging legacy fixtures", () => {
  it("are the files staging's own code wrote", () => {
    expect(verifyStagingLegacyFixtures()).toEqual([]);
  });
});

describe.each(modes)("files staging's code wrote in %s mode", (mode) => {
  beforeEach(() => useMode(mode));

  it("import as this SFU decodes them, with no conflict, and a restart changes nothing", async () => {
    await loadOld(mode, "phase-1");
    const first = await start();
    const expected = await decodedOld(mode);
    expect(Object.keys(expected).length).toBeGreaterThan(8);
    expect(await stored(first)).toEqual(expected);
    expect(importWarnings()).toEqual([]);
    const revs = await dataRevs(first);
    const second = await restart(first);
    expect(await dataRevs(second)).toEqual(revs);
    expect(importWarnings()).toEqual([]);
  });

  it("follow the old SFU's edits, deletes and calendar reconnect from the deploy window, with no conflict", async () => {
    await loadOld(mode, "phase-1");
    const first = await start();
    const before = await stored(first);
    await loadOld(mode, "phase-2");
    const second = await restart(first);
    const after = await stored(second);
    expect(after).toEqual(await decodedOld(mode));
    expect(titled(before, "Daily")).toBeDefined();
    expect(titled(after, "Daily")).toBeUndefined();
    expect(titled(after, "Weekly, moved by the old SFU")).toBeDefined();
    expect(titled(after, "Added by the old SFU during the deploy")).toBeDefined();
    const calendar = (rows: Rows) => Object.entries(rows).find(([key]) => key.startsWith("calendar:"))?.[1] as { id: string; refreshToken: string };
    expect(calendar(after).id).not.toBe(calendar(before).id);
    expect(calendar(after).refreshToken).toBe("refresh-two");
    expect(importWarnings()).toEqual([]);
    const revs = await dataRevs(second);
    const third = await restart(second);
    expect(await dataRevs(third)).toEqual(revs);
  });
});

describe("one deploy's before-stop and after-stop copies, as staging's code wrote them", () => {
  beforeEach(() => useMode("sqlite"));

  it("import oldest first, so the store ends as the later copy, once", async () => {
    for (const [order, phase] of [["000000001", "phase-1"], ["000000002", "phase-2"]] as const) {
      const folder = join(dir, "import", "sfu-a", `20261124T${order}Z-sfu-deploy-1`);
      mkdirSync(folder, { recursive: true });
      for (const file of JSON_FILES) copyFileSync(stagingLegacyFile("json", phase, file), join(folder, file));
    }
    const first = await start();
    expect(await stored(first)).toEqual(decodedFiles("phase-2"));
    expect(importWarnings()).toEqual([]);
    const folders = readdirSync(join(dir, "import", "sfu-a"));
    for (const folder of folders) {
      expect(readdirSync(join(dir, "import", "sfu-a", folder)).every((name) => name.endsWith(".adopted"))).toBe(true);
    }
    const revs = await dataRevs(first);
    const second = await restart(first);
    expect(await dataRevs(second)).toEqual(revs);
  });
});

describe("a record staging's code edited after this store changed it", () => {
  beforeEach(() => useMode("sqlite"));

  it("keeps this store's version and is the only conflict logged", async () => {
    await loadOld("sqlite", "phase-1");
    const first = await start();
    const [key] = titled(await stored(first), "Weekly")!;
    const id = key.slice("meeting:".length);
    expect((await first.commit(updateMeeting(id, { title: "Renamed here" }, { email: null, isAdmin: true }))).ok).toBe(true);
    await loadOld("sqlite", "phase-2");
    const second = await restart(first);
    const after = await stored(second);
    expect((after[key] as { title: string }).title).toBe("Renamed here");
    expect(titled(after, "Daily")).toBeUndefined();
    expect(importWarnings()).toEqual([expect.stringContaining(`legacy meeting ${id} was changed in the old store and here`)]);
  });
});
