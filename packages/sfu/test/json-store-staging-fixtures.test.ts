import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { STAGING_COMMIT, stagingRollbackFixture, stagingRollbackStores, verifyStagingRollbackFixtures } from "../scripts/write-staging-rollback-fixtures.js";

const script = fileURLToPath(new URL("../scripts/write-staging-rollback-fixtures.ts", import.meta.url));
const fixtureDir = dirname(stagingRollbackFixture(stagingRollbackStores[0].name));
const temporary: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "staging-fixtures-"));
  temporary.push(dir);
  return dir;
};

const runScript = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, ...args], { encoding: "utf8", env });

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the staging rollback fixtures", () => {
  it("check out against their recorded hashes and read back through this SFU's stores", () => {
    expect(verifyStagingRollbackFixtures(fixtureDir)).toEqual([]);
  });

  it("are refused once any byte of one changes", () => {
    const copy = join(scratch(), "fixtures");
    cpSync(fixtureDir, copy, { recursive: true });
    const edited = join(copy, basename(stagingRollbackFixture("scheduled-meetings")));
    writeFileSync(edited, readFileSync(edited, "utf8").replace("Renamed during the rollback", "Renamed during the rollbacK"));

    expect(verifyStagingRollbackFixtures(copy)).toEqual([expect.stringContaining(basename(edited))]);
  });

  it("are checked by --check with no git on the path", () => {
    const checked = runScript(["--check"], { PATH: scratch(), HOME: scratch() });

    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
  });

  it("are regenerated only from staging's commit, and say how to fetch it when the clone lacks it", () => {
    const regenerated = runScript([], { PATH: process.env.PATH, HOME: scratch(), GIT_DIR: scratch() });

    expect(regenerated.status).toBe(1);
    expect(regenerated.stderr).toContain(`git fetch origin ${STAGING_COMMIT}`);
  });
});
