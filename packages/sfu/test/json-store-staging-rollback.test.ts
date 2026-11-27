import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledMeetingPersistence } from "../server/scheduledMeetings.js";
import { createScheduledWebinarPersistence } from "../server/scheduledWebinars.js";
import { createSchedulingPersistence } from "../server/scheduling.js";
import { STAGING_ROLLBACK_TOKEN_SECRET, stagingRollbackFixture, stagingRollbackStores } from "../scripts/write-staging-rollback-fixtures.js";

type Row = { id: string };

const loaders: { [name: string]: () => Promise<Row[]> } = {
  "scheduled-meetings": async () => createScheduledMeetingPersistence().load(),
  "scheduled-webinars": async () => createScheduledWebinarPersistence().load(),
  scheduling: async () => {
    const snapshot = await createSchedulingPersistence().load();
    return [...snapshot.profiles, ...snapshot.eventTypes, ...snapshot.calendars, ...snapshot.availability.map((entry) => ({ ...entry, id: `availability-${entry.profileId}` }))];
  },
};

const fixturesDir = join(dirname(stagingRollbackFixture("x")), "..");
let dir = "";
const importDir = () => join(dir, "recordings", "json-fallback-import");
const saveArchive = (archive: string, file: string, source: string) => {
  const path = join(importDir(), "sfu-a", archive, file);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(source, path);
  return path;
};
const byId = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.id, row]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sfu-json-staging-rollback-"));
  vi.stubEnv("CONCLAVE_SQLITE_PATH", join(dir, "conclave.sqlite"));
  vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());
  vi.stubEnv("SCHEDULING_TOKEN_SECRET", STAGING_ROLLBACK_TOKEN_SECRET);
  for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(stagingRollbackStores)("rolling back to staging's $name store and forward again", (store) => {
  it("keeps the rollback edit and untouched records after adoption or manual reconciliation", async () => {
    vi.stubEnv(store.modeVariable, "json");
    const activePath = join(dir, "recordings", `${store.name}.json`);
    vi.stubEnv(store.pathVariable, activePath);
    saveArchive("20260521T000000000Z-before-the-upgrade", `${store.name}.json`, join(fixturesDir, store.legacy));
    const upgraded = byId(await loaders[store.name]());

    vi.stubEnv(store.pathVariable, join(dir, "staging-alone", `${store.name}.json`));
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", "");
    mkdirSync(join(dir, "staging-alone"));
    copyFileSync(stagingRollbackFixture(store.name), join(dir, "staging-alone", `${store.name}.json`));
    const stagingRows = byId(await loaders[store.name]());
    vi.stubEnv(store.pathVariable, activePath);
    vi.stubEnv("CONCLAVE_FALLBACK_IMPORT_DIR", importDir());

    const archive = saveArchive("20261124T000000000Z-after-the-rollback", `${store.name}.json`, stagingRollbackFixture(store.name));
    if (store.name !== "scheduling") {
      const originalActive = readFileSync(activePath, "utf8");
      await expect(loaders[store.name]()).rejects.toThrow(/possible deletion/);
      expect(readFileSync(activePath, "utf8")).toBe(originalActive);
      expect(readFileSync(archive, "utf8")).toBe(readFileSync(stagingRollbackFixture(store.name), "utf8"));
      copyFileSync(archive, activePath);
      renameSync(archive, `${archive}.adopted`);
    }
    const rolledForward = byId(await loaders[store.name]());

    expect(Object.keys(rolledForward).sort()).toEqual(Object.keys(stagingRows).sort());
    for (const [id, row] of Object.entries(upgraded)) expect([row, stagingRows[id]], id).toContainEqual(rolledForward[id]);
    const added = Object.values(rolledForward).filter((row) => !(row.id in upgraded));
    expect(added.length).toBeGreaterThan(0);
    expect(JSON.stringify(added)).toContain("Renamed during the rollback");
  });
});
