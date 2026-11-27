import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deployProblems, parseWranglerConfig, recoveryConfig, writeRecovery } from "../scripts/worker-recovery.mjs";

const web = path.resolve(import.meta.dirname, "..");
const script = path.join(web, "scripts/worker-recovery.mjs");
const fixture = path.join(import.meta.dirname, "fixtures/wrangler-before-ingest-quota.jsonc");
const OPEN_NEXT_ENTRY = [
  "export { DOQueueHandler } from \"./.build/durable-objects/queue.js\";",
  "export { DOShardedTagCache } from \"./.build/durable-objects/sharded-tag-cache.js\";",
  "export default { async fetch() {} };",
].join("\n");

const read = async (file: string) => readFile(file, "utf8");
const current = async () => parseWranglerConfig(await read(path.join(web, "wrangler.jsonc")));
const before = async () => parseWranglerConfig(await read(fixture));

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const olderTree = async (config = fixture) => {
  const dir = await mkdtemp(path.join(tmpdir(), "worker-recovery-"));
  scratch.push(dir);
  await copyFile(config, path.join(dir, "wrangler.jsonc"));
  return dir;
};

describe("rolling the web Worker back past the IngestQuota migration", () => {
  it("deploys this tree over the state its own migrations leave", async () => {
    const config = await current();

    expect(deployProblems(config.migrations, config, await read(path.join(web, config.main)))).toEqual([]);
  });

  it("finds the Worker from before the migration unable to deploy over that state", async () => {
    const applied = (await current()).migrations;

    expect(deployProblems(applied, await before(), OPEN_NEXT_ENTRY)).toEqual([
      "its migrations (none) do not start with the applied v1",
      ".open-next/worker.js does not export the Durable Object class IngestQuota",
    ]);
  });

  it("writes a recovery build of the older tree that keeps the class, its binding and the migration", async () => {
    const dir = await olderTree();
    const run = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });

    expect(run.status, run.stderr).toBe(0);
    const written = parseWranglerConfig(await read(path.join(dir, "wrangler.jsonc")));
    const config = await current();
    expect(written).toEqual({
      ...(await before()),
      main: "worker.ts",
      durable_objects: config.durable_objects,
      migrations: config.migrations,
    });
    expect(await read(path.join(dir, "worker.ts"))).toBe(await read(path.join(web, "worker.ts")));
    expect(await read(path.join(dir, "src/app/lib/ingest-quota.ts"))).toBe(await read(path.join(web, "src/app/lib/ingest-quota.ts")));
    expect(deployProblems(config.migrations, written, await read(path.join(dir, written.main)))).toEqual([]);
  });

  it("leaves a tree that already carries the class as it is, and refuses one whose migrations diverge", async () => {
    const config = await current();

    expect(recoveryConfig(config, config)).toEqual(config);
    expect(() => recoveryConfig({ ...config, migrations: [{ tag: "v1-other", new_sqlite_classes: ["Other"] }] }, config)).toThrow(
      "migrations diverge",
    );
  });

  it("writes nothing to the older tree when its recovery build still could not deploy", async () => {
    const dir = await olderTree();
    const source = await mkdtemp(path.join(tmpdir(), "worker-recovery-source-"));
    scratch.push(source);
    const config = await current();
    await mkdir(path.join(source, "src/app/lib"), { recursive: true });
    await copyFile(path.join(web, "worker.ts"), path.join(source, "worker.ts"));
    await copyFile(path.join(web, "src/app/lib/ingest-quota.ts"), path.join(source, "src/app/lib/ingest-quota.ts"));
    await writeFile(
      path.join(source, "wrangler.jsonc"),
      JSON.stringify({ ...config, migrations: [...config.migrations, { tag: "v2", new_sqlite_classes: ["Missing"] }] }),
    );

    await expect(writeRecovery(dir, source)).rejects.toThrow("worker.ts does not export the Durable Object class Missing");
    expect(await readdir(dir)).toEqual(["wrangler.jsonc"]);
    expect(await read(path.join(dir, "wrangler.jsonc"))).toBe(await read(fixture));
  });
});
