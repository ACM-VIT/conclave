import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { contextProblems, repoRoot } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";

const BOOT_TIMEOUT_MS = 120_000;

function runDocker(args, env, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result;
}

export function resolveDockerEndpoint(env = process.env) {
  const host = env.DOCKER_HOST?.trim();
  if (host) return host;
  const name = env.DOCKER_CONTEXT?.trim() || runDocker(["context", "show"], env).stdout.trim();
  return runDocker(["context", "inspect", name, "--format", "{{.Endpoints.docker.Host}}"], env).stdout.trim();
}

export function localSocket(endpoint) {
  const match = /^unix:\/\/(\/.+)$/.exec(endpoint);
  if (!match) throw new Error(`refusing to build: the effective Docker endpoint ${endpoint || "(none)"} is not a local unix socket`);
  return { host: endpoint, socket: match[1] };
}

export function pinnedDocker(daemon, env = process.env) {
  const { DOCKER_HOST, DOCKER_CONTEXT, ...rest } = env;
  return (args, options) => runDocker(["--host", daemon.host, ...args], rest, options);
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

async function waitFor(docker, container, check) {
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
    async ready(docker, container) {
      await waitFor(docker, container, (logs) => /Server running on port \d+/.test(logs));
      docker(["exec", "-w", "/app/packages/sfu", container, "node", "--import", "tsx", "-e", 'await import("@conclave/apps-sdk/authority/server");']);
      return "logged Server running and imported @conclave/apps-sdk/authority/server";
    },
  },
  "packages/shared-browser/Dockerfile": {
    run: ({ port, socket }) => ["-p", `127.0.0.1:${port}:3040`, "-e", "BROWSER_SERVICE_PORT=3040", "-v", `${socket}:/var/run/docker.sock`],
    async ready(docker, container, { port, socket }) {
      await waitFor(docker, container, (logs) => /Shared Browser Service running on port \d+/.test(logs));
      await waitFor(docker, container, async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status === 200);
      return `logged Shared Browser Service running and /health returned 200 with ${socket} mounted`;
    },
  },
};

export class RunResources {
  constructor(docker) {
    this.docker = docker;
    this.containers = new Map();
    this.images = new Set();
  }

  addContainer(name, id = null) {
    this.containers.set(name, id);
  }

  removeAll() {
    for (const [name, id] of this.containers) this.docker(["rm", "-f", id || name], { allowFailure: true });
    for (const image of this.images) this.docker(["rmi", image], { allowFailure: true });
    this.containers.clear();
    this.images.clear();
  }
}

async function checkImage(build, { docker, resources, socket, noCache, logDir, run }) {
  const boot = BOOTS[build.dockerfile];
  if (!boot) throw new Error(`no boot check for ${build.dockerfile}; add one to BOOTS in scripts/check-docker-images.mjs`);
  const slug = build.dockerfile.replace(/\/Dockerfile$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const tag = `conclave-check-images/${slug}:${run}`;
  const container = `conclave-check-images-${slug}-${run}`;
  const buildArgs = Object.entries(build.args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
  resources.images.add(tag);
  const started = Date.now();
  const built = docker(["build", "--progress=plain", ...(noCache ? ["--no-cache"] : []), ...buildArgs, "-f", build.dockerfile, "-t", tag, "."], { allowFailure: true });
  const buildLog = path.join(logDir, `${slug}-build.log`);
  writeFileSync(buildLog, `${built.stdout}${built.stderr}`);
  const buildSeconds = Math.round((Date.now() - started) / 1000);
  try {
    if (built.status !== 0) return { dockerfile: build.dockerfile, ok: false, detail: `build failed after ${buildSeconds} s, see ${buildLog}` };
    const port = await freePort();
    resources.addContainer(container);
    const id = docker(["run", "-d", "--name", container, ...boot.run({ port, socket }), tag]).stdout.trim();
    resources.addContainer(container, id);
    const detail = await boot.ready(docker, id, { port, socket });
    return { dockerfile: build.dockerfile, ok: true, detail: `built in ${buildSeconds} s, ${detail}` };
  } catch (error) {
    return { dockerfile: build.dockerfile, ok: false, detail: `built in ${buildSeconds} s, boot failed: ${error.message}` };
  } finally {
    if (resources.containers.has(container)) {
      const logs = docker(["logs", resources.containers.get(container) || container], { allowFailure: true });
      writeFileSync(path.join(logDir, `${slug}-boot.log`), `${logs.stdout}${logs.stderr}`);
    }
    resources.removeAll();
  }
}

async function main() {
  const noCache = process.argv.includes("--no-cache");
  const problems = contextProblems(repoRoot);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    throw new Error("pnpm check:docker-context fails; fix the build context first");
  }
  const daemon = localSocket(resolveDockerEndpoint());
  const docker = pinnedDocker(daemon);
  const resources = new RunResources(docker);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      console.error(`${signal}: removing the containers and image tags this run created`);
      resources.removeAll();
      process.exit(code);
    });
  }
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const run = `${head}-${process.pid}`;
  const logDir = mkdtempSync(path.join(tmpdir(), "conclave-check-images-"));
  console.log(`building root-context images at ${head} on ${daemon.host}${noCache ? " without cache" : ""}; nothing is pushed`);
  const builds = [...new Map(rootContextBuilds(repoRoot).map((build) => [build.dockerfile, build])).values()];
  const results = [];
  for (const build of builds) {
    const result = await checkImage(build, { docker, resources, socket: process.env.BROWSER_DOCKER_SOCKET || daemon.socket, noCache, logDir, run });
    console.log(`${result.ok ? "ok" : "FAIL"} ${result.dockerfile}: ${result.detail}`);
    results.push(result);
  }
  console.log(`logs in ${logDir}`);
  if (results.some((result) => !result.ok)) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
