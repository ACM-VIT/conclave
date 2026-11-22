import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../scripts/upload-posthog-sourcemaps.mjs");
const dirs: string[] = [];

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

// A built OpenNext asset folder with one chunk and its map, plus a bin folder
// holding a fake posthog-cli that exits with `cliExit` (none when null).
const buildFixture = (cliExit: number | null) => {
  const root = mkdtempSync(path.join(tmpdir(), "sourcemaps-"));
  dirs.push(root);
  const chunks = path.join(root, ".open-next/assets/_next/static/chunks");
  mkdirSync(chunks, { recursive: true });
  writeFileSync(path.join(chunks, "app.js"), "console.log(1);\n//# sourceMappingURL=app.js.map\n");
  writeFileSync(path.join(chunks, "app.js.map"), '{"version":3,"sources":[],"mappings":""}');
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  if (cliExit !== null) {
    const cli = path.join(bin, "posthog-cli");
    writeFileSync(cli, `#!/bin/sh\necho "posthog-cli $*"\nexit ${cliExit}\n`);
    chmodSync(cli, 0o755);
  }
  return { root, bin, chunks };
};

const runUpload = ({ root, bin }: { root: string; bin: string }) =>
  spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      POSTHOG_CLI_API_KEY: "phx_fake_not_real",
      POSTHOG_CLI_PROJECT_ID: "1",
      POSTHOG_CLI_HOST: "http://127.0.0.1:9",
    },
  });

const mapsLeft = (chunks: string) => readdirSync(chunks).filter((name) => name.endsWith(".map"));

describe("upload-posthog-sourcemaps", () => {
  it("warns and lets the deploy go on when the upload fails, with the maps removed", () => {
    const fixture = buildFixture(1);
    const result = runUpload(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\[sourcemaps\] upload failed/);
    expect(mapsLeft(fixture.chunks)).toEqual([]);
  });

  it("warns and goes on when posthog-cli is not installed", () => {
    const fixture = buildFixture(null);
    const result = runUpload(fixture);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/posthog-cli is not installed/);
    expect(mapsLeft(fixture.chunks)).toEqual([]);
  });

  it("uploads and removes the maps when posthog-cli succeeds", () => {
    const fixture = buildFixture(0);
    const result = runUpload(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/sourcemap inject/);
    expect(result.stdout).toMatch(/sourcemap upload/);
    expect(result.stdout).toMatch(/\[sourcemaps\] uploaded to PostHog/);
    expect(mapsLeft(fixture.chunks)).toEqual([]);
  });
});
