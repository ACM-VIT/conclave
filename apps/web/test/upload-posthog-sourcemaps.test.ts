import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../scripts/upload-posthog-sourcemaps.mjs");
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  const open = servers.splice(0);
  open.forEach((server) => server.closeAllConnections());
  await Promise.all(open.map((server) => new Promise((resolve) => server.close(resolve))));
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

/** Accepts the upload connection and never answers, like PostHog behind a dead route. */
const startStalledUploadHost = async () => {
  let connections = 0;
  const server = createServer(() => {});
  server.on("connection", () => {
    connections += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { host: `http://127.0.0.1:${port}`, connections: () => connections };
};

// A posthog-cli stand-in that starts its upload to the host and waits on it.
const installStallingCli = (bin: string, pidFile: string) => {
  const cli = path.join(bin, "posthog-cli");
  writeFileSync(
    cli,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const request = require("node:http").request(process.env.POSTHOG_CLI_HOST + "/api/sourcemaps", { method: "POST" });
request.on("error", () => {});
request.write("chunk");
setInterval(() => {}, 1000);
`,
  );
  chmodSync(cli, 0o755);
};

/** Records when each upload request arrives, and never answers. */
const startRecordingUploadHost = async () => {
  const requestTimes: number[] = [];
  const server = createServer((request) => {
    requestTimes.push(Date.now());
    request.resume();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { host: `http://127.0.0.1:${port}`, requestTimes };
};

// Shaped like the npm @posthog/cli: a node wrapper that runs the real
// uploader as its own child and waits on it. This uploader sends a request
// every 200 ms, never finishes, and ignores SIGTERM.
const installWrappedUploaderCli = (root: string, bin: string) => {
  const uploader = path.join(root, "uploader.cjs");
  writeFileSync(
    uploader,
    `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "uploader.pid"))}, String(process.pid));
process.on("SIGTERM", () => {});
const http = require("node:http");
setInterval(() => {
  const request = http.request(process.env.POSTHOG_CLI_HOST + "/api/sourcemaps", { method: "POST" });
  request.on("error", () => {});
  request.end("chunk");
}, 200);
`,
  );
  const cli = path.join(bin, "posthog-cli");
  writeFileSync(
    cli,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "wrapper.pid"))}, String(process.pid));
const result = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(uploader)}, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
  );
  chmodSync(cli, 0o755);
};

const runUploadAsync = (fixture: { root: string; bin: string }, env: Record<string, string>) =>
  new Promise<{ status: number | null; stderr: string; exitedAt: number }>((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: fixture.root,
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        HOME: fixture.root,
        POSTHOG_CLI_API_KEY: "phx_fake_not_real",
        POSTHOG_CLI_PROJECT_ID: "1",
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr, exitedAt: Date.now() }));
  });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it("gives up on an upload that stalls, kills posthog-cli and still removes the maps", async () => {
    const fixture = buildFixture(null);
    const pidFile = path.join(fixture.root, "cli.pid");
    installStallingCli(fixture.bin, pidFile);
    const uploadHost = await startStalledUploadHost();

    const startedAt = Date.now();
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd: fixture.root,
        env: {
          PATH: `${fixture.bin}:/usr/bin:/bin`,
          HOME: fixture.root,
          POSTHOG_CLI_API_KEY: "phx_fake_not_real",
          POSTHOG_CLI_PROJECT_ID: "1",
          POSTHOG_CLI_HOST: uploadHost.host,
          POSTHOG_SOURCEMAPS_TIMEOUT_MS: "1500",
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    const elapsedMs = Date.now() - startedAt;

    expect(uploadHost.connections()).toBeGreaterThan(0);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\[sourcemaps\] upload failed.*did not finish within 1\.5 s/);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(isRunning(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    expect(mapsLeft(fixture.chunks)).toEqual([]);
  }, 20_000);

  it("stops the uploader the npm wrapper started before removing the maps", async () => {
    const fixture = buildFixture(null);
    installWrappedUploaderCli(fixture.root, fixture.bin);
    const uploadHost = await startRecordingUploadHost();

    const result = await runUploadAsync(fixture, {
      POSTHOG_CLI_HOST: uploadHost.host,
      POSTHOG_SOURCEMAPS_TIMEOUT_MS: "1500",
    });
    const sentBeforeExit = uploadHost.requestTimes.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(sentBeforeExit).toBeGreaterThan(0);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/did not finish within 1\.5 s/);
    expect(isRunning(Number(readFileSync(path.join(fixture.root, "wrapper.pid"), "utf8")))).toBe(false);
    expect(isRunning(Number(readFileSync(path.join(fixture.root, "uploader.pid"), "utf8")))).toBe(false);
    expect(uploadHost.requestTimes.filter((at) => at > result.exitedAt)).toEqual([]);
    expect(mapsLeft(fixture.chunks)).toEqual([]);
  }, 30_000);

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
