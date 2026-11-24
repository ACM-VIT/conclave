import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { contextProblems, repoRoot } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";

const BOOT_TIMEOUT_MS = 120_000;

function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(container, check) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = docker(["logs", container], { allowFailure: true });
    if (await check(`${logs.stdout}${logs.stderr}`)) return;
    if (docker(["inspect", "-f", "{{.State.Running}}", container], { allowFailure: true }).stdout.trim() !== "true") {
      throw new Error(`${container} exited before it was ready`);
    }
    await sleep(500);
  }
  throw new Error(`${container} was not ready after ${BOOT_TIMEOUT_MS / 1000} s`);
}

const BOOTS = {
  "packages/sfu/Dockerfile": {
    run: () => ["-e", "SFU_SECRET=check-docker-images-only", "-e", "NODE_ENV=development"],
    async ready(container) {
      await waitFor(container, (logs) => /Server running on port \d+/.test(logs));
      docker(["exec", "-w", "/app/packages/sfu", container, "node", "--import", "tsx", "-e", 'await import("@conclave/apps-sdk/authority/server");']);
      return "logged Server running and imported @conclave/apps-sdk/authority/server";
    },
  },
  "packages/shared-browser/Dockerfile": {
    run: ({ port }) => ["-p", `127.0.0.1:${port}:3040`, "-e", "BROWSER_SERVICE_PORT=3040", "-v", "/var/run/docker.sock:/var/run/docker.sock"],
    async ready(container, { port }) {
      await waitFor(container, (logs) => /Shared Browser Service running on port \d+/.test(logs));
      await waitFor(container, async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 200);
      return "logged Shared Browser Service running and /health returned 200";
    },
  },
};

function assertLocalDaemon() {
  const host = process.env.DOCKER_HOST ?? docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.trim();
  if (!host.startsWith("unix://")) throw new Error(`refusing to build: the Docker endpoint ${host} is not a local socket`);
  return host;
}

async function checkImage(build, { noCache, logDir, run }) {
  const boot = BOOTS[build.dockerfile];
  if (!boot) throw new Error(`no boot check for ${build.dockerfile}; add one to BOOTS in scripts/check-docker-images.mjs`);
  const slug = build.dockerfile.replace(/\/Dockerfile$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const tag = `conclave-check-images/${slug}:${run}`;
  const container = `conclave-check-images-${slug}-${run}`;
  const buildArgs = Object.entries(build.args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
  const started = Date.now();
  const built = docker(["build", "--progress=plain", ...(noCache ? ["--no-cache"] : []), ...buildArgs, "-f", build.dockerfile, "-t", tag, "."], { allowFailure: true });
  const buildLog = path.join(logDir, `${slug}-build.log`);
  writeFileSync(buildLog, `${built.stdout}${built.stderr}`);
  const buildSeconds = Math.round((Date.now() - started) / 1000);
  if (built.status !== 0) return { dockerfile: build.dockerfile, ok: false, detail: `build failed after ${buildSeconds} s, see ${buildLog}` };
  try {
    const port = await freePort();
    docker(["run", "-d", "--name", container, ...boot.run({ port }), tag]);
    const detail = await boot.ready(container, { port });
    return { dockerfile: build.dockerfile, ok: true, detail: `built in ${buildSeconds} s, ${detail}` };
  } catch (error) {
    return { dockerfile: build.dockerfile, ok: false, detail: `built in ${buildSeconds} s, boot failed: ${error.message}` };
  } finally {
    const logs = docker(["logs", container], { allowFailure: true });
    writeFileSync(path.join(logDir, `${slug}-boot.log`), `${logs.stdout}${logs.stderr}`);
    docker(["rm", "-f", container], { allowFailure: true });
    docker(["rmi", tag], { allowFailure: true });
  }
}

async function main() {
  const noCache = process.argv.includes("--no-cache");
  const problems = contextProblems(repoRoot);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    throw new Error("pnpm check:docker-context fails; fix the build context first");
  }
  const host = assertLocalDaemon();
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const run = `${head}-${process.pid}`;
  const logDir = mkdtempSync(path.join(tmpdir(), "conclave-check-images-"));
  console.log(`building root-context images at ${head} on ${host}${noCache ? " without cache" : ""}; nothing is pushed`);
  const dockerfiles = [...new Map(rootContextBuilds(repoRoot).map((build) => [build.dockerfile, build])).values()];
  const results = [];
  for (const build of dockerfiles) {
    const result = await checkImage(build, { noCache, logDir, run });
    console.log(`${result.ok ? "ok" : "FAIL"} ${result.dockerfile}: ${result.detail}`);
    results.push(result);
  }
  console.log(`logs in ${logDir}`);
  if (results.some((result) => !result.ok)) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
