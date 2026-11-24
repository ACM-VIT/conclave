import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { contextProblems, repoRoot } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";

const BOOT_TIMEOUT_MS = 120_000;
const VM_DAEMON_SOCKET = "/var/run/docker.sock";
const LOCAL_BUILDER = "default";

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

export function pinnedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("DOCKER_") && !name.startsWith("BUILDX_")));
}

export function pinnedDocker(daemon, env = process.env) {
  const clean = pinnedEnv(env);
  return (args, options) => runDocker(["--host", daemon.host, ...args], clean, options);
}

export function assertLocalBuilder(docker) {
  const text = docker(["buildx", "inspect", LOCAL_BUILDER]).stdout;
  const driver = /^Driver:\s*(\S+)/m.exec(text)?.[1];
  const endpoints = [...text.matchAll(/^Endpoint:\s*(\S+)/gm)].map((match) => match[1]);
  if (driver !== "docker" || endpoints.length !== 1 || endpoints[0] !== LOCAL_BUILDER) {
    throw new Error(`refusing to build: buildx builder "${LOCAL_BUILDER}" is not the docker driver on the checked endpoint (driver ${driver ?? "unknown"}, endpoint ${endpoints.join(", ") || "unknown"})`);
  }
  return LOCAL_BUILDER;
}

export function browserSocketSource(docker, { socket, env = process.env, platform = process.platform }) {
  if (env.BROWSER_DOCKER_SOCKET) return env.BROWSER_DOCKER_SOCKET;
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"]).stdout);
  const inVm = platform !== "linux" || /docker desktop|orbstack/i.test(info.OperatingSystem ?? "") || /^(colima|lima)/i.test(info.Name ?? "");
  return inVm ? VM_DAEMON_SOCKET : socket;
}

function healthProbe(port) {
  return `fetch("http://127.0.0.1:${port}/health").then((r) => { console.log(r.status); }, () => { console.log(0); })`;
}

async function waitForHealth(docker, id, port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let last = "no answer";
  while (Date.now() < deadline) {
    const probe = docker(["exec", id, "node", "-e", healthProbe(port)], { allowFailure: true });
    if (probe.stdout.trim() === "200") return;
    last = probe.status === 0 ? `HTTP ${probe.stdout.trim()}` : probe.stderr.trim().split("\n").at(-1) || "exec failed";
    if (docker(["inspect", "-f", "{{.State.Running}}", id], { allowFailure: true }).stdout.trim() !== "true") {
      throw new Error(`the container exited before /health answered 200 (last: ${last})`);
    }
    await sleep(500);
  }
  throw new Error(`/health did not answer 200 within ${BOOT_TIMEOUT_MS / 1000} s (last: ${last})`);
}

const BOOTS = {
  "packages/sfu/Dockerfile": {
    port: 3031,
    env: () => ({ SFU_PORT: "3031", SFU_SECRET: randomBytes(24).toString("hex"), NODE_ENV: "development" }),
    mounts: () => [],
    async ready(docker, id) {
      await waitForHealth(docker, id, 3031);
      docker(["exec", "-w", "/app/packages/sfu", id, "node", "--import", "tsx", "-e", 'await import("@conclave/apps-sdk/authority/server");']);
      return "/health answered 200 and @conclave/apps-sdk/authority/server imported";
    },
  },
  "packages/shared-browser/Dockerfile": {
    port: 3040,
    env: () => ({ BROWSER_SERVICE_HOST: "127.0.0.1", BROWSER_SERVICE_PORT: "3040", BROWSER_SERVICE_TOKEN: randomBytes(24).toString("hex") }),
    mounts: ({ socket }) => ["-v", `${socket}:/var/run/docker.sock`],
    async ready(docker, id, { socket }) {
      await waitForHealth(docker, id, 3040);
      return `/health answered 200 with ${socket} mounted`;
    },
  },
};

export class RunResources {
  constructor(docker) {
    this.docker = docker;
    this.containers = new Set();
    this.images = new Set();
  }

  removeAll() {
    for (const id of this.containers) this.docker(["rm", "-f", id], { allowFailure: true });
    for (const image of this.images) this.docker(["rmi", image], { allowFailure: true });
    this.containers.clear();
    this.images.clear();
  }
}

export async function startContainer(docker, resources, { name, tag, env, mounts }) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const started = docker(["run", "-d", "--name", name, ...envArgs, ...mounts, tag], { allowFailure: true });
  const id = started.stdout.trim();
  if (started.status !== 0 || !/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`docker run failed: ${started.stderr.trim() || id}`);
  resources.containers.add(id);
  return id;
}

async function checkImage(build, { docker, resources, builder, socket, noCache, logDir, run }) {
  const boot = BOOTS[build.dockerfile];
  if (!boot) throw new Error(`no boot check for ${build.dockerfile}; add one to BOOTS in scripts/check-docker-images.mjs`);
  const slug = build.dockerfile.replace(/\/Dockerfile$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const tag = `conclave-check-images/${slug}:${run}`;
  const buildArgs = Object.entries(build.args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
  resources.images.add(tag);
  const started = Date.now();
  const built = docker(["buildx", "build", "--builder", builder, "--load", "--progress=plain", ...(noCache ? ["--no-cache"] : []), ...buildArgs, "-f", build.dockerfile, "-t", tag, "."], { allowFailure: true });
  const buildLog = path.join(logDir, `${slug}-build.log`);
  writeFileSync(buildLog, `${built.stdout}${built.stderr}`);
  const buildSeconds = Math.round((Date.now() - started) / 1000);
  let id = null;
  try {
    if (built.status !== 0) return { dockerfile: build.dockerfile, ok: false, detail: `build failed after ${buildSeconds} s, see ${buildLog}` };
    id = await startContainer(docker, resources, { name: `conclave-check-images-${slug}-${run}`, tag, env: boot.env(), mounts: boot.mounts({ socket }) });
    const detail = await boot.ready(docker, id, { socket });
    return { dockerfile: build.dockerfile, ok: true, detail: `built in ${buildSeconds} s, ${detail}` };
  } catch (error) {
    return { dockerfile: build.dockerfile, ok: false, detail: `built in ${buildSeconds} s, boot failed: ${error.message}` };
  } finally {
    if (id) {
      const logs = docker(["logs", id], { allowFailure: true });
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
  const builder = assertLocalBuilder(docker);
  const resources = new RunResources(docker);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      console.error(`${signal}: removing the containers and image tags this run created`);
      resources.removeAll();
      process.exit(code);
    });
  }
  const socket = browserSocketSource(docker, { socket: daemon.socket });
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const run = `${head}-${randomBytes(6).toString("hex")}`;
  const logDir = mkdtempSync(path.join(tmpdir(), "conclave-check-images-"));
  console.log(`building root-context images at ${head} on ${daemon.host} with buildx builder ${builder}${noCache ? " without cache" : ""}; nothing is pushed`);
  const builds = [...new Map(rootContextBuilds(repoRoot).map((build) => [build.dockerfile, build])).values()];
  const results = [];
  for (const build of builds) {
    const result = await checkImage(build, { docker, resources, builder, socket, noCache, logDir, run });
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
