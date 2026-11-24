import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLegacyDomains } from "../server/controlPlane/legacy.js";
import { specOf } from "../server/controlPlane/entities.js";
import { DATA_KINDS, legacyCopyKey } from "../server/controlPlane/model.js";
import { openControlPlane, resolveControlPlaneConfig } from "../server/controlPlane/open.js";
import type { ControlPlaneStore } from "../server/controlPlane/store.js";
import { STAGING_ROLLBACK_TOKEN_SECRET, stagingRollbackFixture, stagingRollbackStores } from "../scripts/write-staging-rollback-fixtures.js";

type Rows = Record<string, unknown>;

const fixturesDir = join(dirname(stagingRollbackFixture("x")), "..");
const modes = ["sqlite", "json"] as const;
let dir = "";
const stores: ControlPlaneStore[] = [];

const importDir = () => join(dir, "recordings", "json-fallback-import");
const saveArchive = (archive: string, file: string, source: string) => {
  const path = join(importDir(), "sfu-a", archive, file);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(source, path);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-staging-rollback-"));
  mkdirSync(join(dir, "old"));
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", STAGING_ROLLBACK_TOKEN_SECRET);
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONTROL_PLANE_JSON_PATH", join(dir, "control-plane.json"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
  vi.stubEnv("SCHEDULING_PATH", join(dir, "old", "scheduling.json"));
  vi.stubEnv("SCHEDULED_MEETINGS_PATH", join(dir, "old", "scheduled-meetings.json"));
  vi.stubEnv("SCHEDULED_WEBINARS_PATH", join(dir, "old", "scheduled-webinars.json"));
  for (const variable of ["REDIS_URL", "SFU_REDIS_URL", "SFU_PERSISTENCE_REDIS_URL", "SCHEDULING_PERSISTENCE", "SCHEDULED_MEETINGS_PERSISTENCE", "SCHEDULED_WEBINARS_PERSISTENCE", "SCHEDULING_SQLITE_PATH", "SCHEDULED_MEETINGS_SQLITE_PATH", "SCHEDULED_WEBINARS_SQLITE_PATH", "RECORDING_STORAGE_PATH"]) {
    vi.stubEnv(variable, "");
  }
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const start = async (): Promise<ControlPlaneStore> => {
  const store = await openControlPlane(resolveControlPlaneConfig());
  stores.push(store);
  return store;
};

const rows = (store: ControlPlaneStore): Promise<Rows> =>
  store.read((view) =>
    Object.fromEntries(
      DATA_KINDS.flatMap((kind) =>
        view.all(kind).map((stored) => [legacyCopyKey(kind, specOf(kind).id(stored.value as never)), stored.value]),
      ),
    ),
  );

const stagingRows = async (name: string): Promise<Rows> => {
  const alone = join(dir, "staging-alone");
  mkdirSync(alone, { recursive: true });
  copyFileSync(stagingRollbackFixture(name), join(alone, `${name}.json`));
  const domains = await readLegacyDomains({
    mode: "json",
    paths: {
      schedulingSqlite: join(alone, "unused.sqlite"),
      meetingsSqlite: join(alone, "unused.sqlite"),
      webinarsSqlite: join(alone, "unused.sqlite"),
      schedulingJson: join(alone, "scheduling.json"),
      meetingsJson: join(alone, "scheduled-meetings.json"),
      webinarsJson: join(alone, "scheduled-webinars.json"),
      fallbackDir: null,
    },
  });
  return Object.fromEntries(domains.flatMap((domain) => domain.records ?? []).map((record) => [record.key, record.value]));
};

describe.each(modes)("a %s store rolled back to staging and forward again", (mode) => {
  it.each(stagingRollbackStores)("keeps staging's $name changes and every untouched record", async (store) => {
    vi.stubEnv("CONTROL_PLANE_PERSISTENCE", mode);
    saveArchive("20260521T000000000Z-before-the-upgrade", `${store.name}.json`, join(fixturesDir, store.legacy));
    const first = await start();
    const upgraded = await rows(first);
    const staging = await stagingRows(store.name);

    saveArchive("20261124T000000000Z-after-the-rollback", `${store.name}.json`, stagingRollbackFixture(store.name));
    stores.splice(stores.indexOf(first), 1);
    await first.close();
    const rolledForward = await rows(await start());

    expect(Object.keys(rolledForward).sort()).toEqual(Object.keys(staging).sort());
    for (const [key, row] of Object.entries(upgraded)) expect([row, staging[key]], key).toContainEqual(rolledForward[key]);
    const added = Object.keys(rolledForward).filter((key) => !(key in upgraded));
    expect(added.length).toBeGreaterThan(0);
    expect(JSON.stringify(added.map((key) => rolledForward[key]))).toContain("Renamed during the rollback");
  });
});
