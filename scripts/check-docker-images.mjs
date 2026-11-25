import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { contextProblems, repoRoot } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";

const BOOT_TIMEOUT_MS = 120_000;
const VM_DAEMON_SOCKET = "/var/run/docker.sock";
const LOCAL_BUILDER = "default";
const OWNER_LABEL = "conclave-check-images.owner";

export class Interrupted extends Error {
  constructor(signal) {
    super(`${signal}: stopped`);
    this.signal = signal;
  }
}

export class DockerSession {
  constructor() {
    this.signal = null;
    this.children = new Set();
  }

  get exitCode() {
    return 128 + constants.signals[this.signal];
  }

  interrupt(signal) {
    if (this.signal) return;
    this.signal = signal;
    for (const child of this.children) child.kill(signal);
  }

  run(args, env, { allowFailure = false, cleanup = false } = {}) {
    if (this.signal && !cleanup) return Promise.reject(new Interrupted(this.signal));
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { cwd: repoRoot, env, detached: cleanup, stdio: ["ignore", "pipe", "pipe"] });
      if (!cleanup) this.children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      let settled = false;
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        this.children.delete(child);
        if (error) reject(error);
        else resolve(result);
      };
      child.on("error", (error) => settle(error));
      child.on("close", (status) => {
        if (this.signal && !cleanup) return settle(new Interrupted(this.signal));
        if (status !== 0 && !allowFailure) return settle(new Error(`docker ${args.join(" ")} failed:\n${stderr.trim()}`));
        settle(null, { status, stdout, stderr });
      });
    });
  }
}

export function resolveDockerEndpoint(env = process.env, session = new DockerSession()) {
  const host = env.DOCKER_HOST?.trim();
  if (host) return Promise.resolve(host);
  return (async () => {
    const name = env.DOCKER_CONTEXT?.trim() || (await session.run(["context", "show"], env)).stdout.trim();
    return (await session.run(["context", "inspect", name, "--format", "{{.Endpoints.docker.Host}}"], env)).stdout.trim();
  })();
}

export function localSocket(endpoint) {
  const match = /^unix:\/\/(\/.+)$/.exec(endpoint);
  if (!match) throw new Error(`refusing to build: the effective Docker endpoint ${endpoint || "(none)"} is not a local unix socket`);
  return { host: endpoint, socket: match[1] };
}

const CONFIG_LOCATORS = new Set(["DOCKER_CONFIG", "BUILDX_CONFIG"]);

export function pinnedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => CONFIG_LOCATORS.has(name) || (!name.startsWith("DOCKER_") && !name.startsWith("BUILDX_"))));
}

export function pinnedDocker(daemon, env = process.env, session = new DockerSession()) {
  const clean = pinnedEnv(env);
  const docker = (args, options) => session.run(["--host", daemon.host, ...args], clean, options);
  docker.session = session;
  return docker;
}

export async function assertLocalBuilder(docker) {
  const text = (await docker(["buildx", "inspect", LOCAL_BUILDER])).stdout;
  const driver = /^Driver:\s*(\S+)/m.exec(text)?.[1];
  const endpoints = [...text.matchAll(/^Endpoint:\s*(\S+)/gm)].map((match) => match[1]);
  if (driver !== "docker" || endpoints.length !== 1 || endpoints[0] !== LOCAL_BUILDER) {
    throw new Error(`refusing to build: buildx builder "${LOCAL_BUILDER}" is not the docker driver on the checked endpoint (driver ${driver ?? "unknown"}, endpoint ${endpoints.join(", ") || "unknown"})`);
  }
  return LOCAL_BUILDER;
}

export async function browserSocketSource(docker, { socket, env = process.env, platform = process.platform }) {
  if (env.BROWSER_DOCKER_SOCKET) return env.BROWSER_DOCKER_SOCKET;
  const info = JSON.parse((await docker(["info", "--format", "{{json .}}"])).stdout);
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
    const probe = await docker(["exec", id, "node", "-e", healthProbe(port)], { allowFailure: true });
    if (probe.stdout.trim() === "200") return;
    last = probe.status === 0 ? `HTTP ${probe.stdout.trim()}` : probe.stderr.trim().split("\n").at(-1) || "exec failed";
    if ((await docker(["inspect", "-f", "{{.State.Running}}", id], { allowFailure: true })).stdout.trim() !== "true") {
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
      await docker(["exec", "-w", "/app/packages/sfu", id, "node", "--import", "tsx", "-e", 'await import("@conclave/apps-sdk/authority/server");']);
      return "/health answered 200 and @conclave/apps-sdk/authority/server imported";
    },
  },
  "packages/shared-browser/Dockerfile": {
    port: 3040,
    companions: [{ context: "packages/shared-browser/docker", env: "BROWSER_IMAGE_NAME", slug: "session" }],
    env: () => ({ BROWSER_SERVICE_HOST: "127.0.0.1", BROWSER_SERVICE_PORT: "3040", BROWSER_SERVICE_TOKEN: randomBytes(24).toString("hex") }),
    mounts: ({ socket }) => ["-v", `${socket}:/var/run/docker.sock`],
    async ready(docker, id, { socket }) {
      await waitForHealth(docker, id, 3040);
      return `/health answered 200 with ${socket} mounted and the session image from packages/shared-browser/docker`;
    },
  },
};

export class RunResources {
  constructor(docker) {
    this.docker = docker;
    this.owners = new Set();
    this.images = new Set();
  }

  claimContainer() {
    const owner = `${OWNER_LABEL}=${randomBytes(12).toString("hex")}`;
    this.owners.add(owner);
    return owner;
  }

  claimImage(tag) {
    this.images.add(tag);
    return tag;
  }

  async removeAll() {
    for (const owner of [...this.owners]) {
      const listed = await this.docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${owner}`], { allowFailure: true, cleanup: true });
      if (listed.status !== 0) continue;
      this.owners.delete(owner);
      for (const id of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        await this.docker(["rm", "-f", id], { allowFailure: true, cleanup: true });
      }
    }
    for (const image of [...this.images]) {
      this.images.delete(image);
      await this.docker(["rmi", image], { allowFailure: true, cleanup: true });
    }
  }
}

export async function startContainer(docker, resources, { name, tag, env, mounts }) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const owner = resources.claimContainer();
  const created = await docker(["create", "--name", name, "--label", owner, ...envArgs, ...mounts, tag], { allowFailure: true });
  const id = created.stdout.trim();
  if (created.status !== 0 || !/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`docker create failed: ${created.stderr.trim() || id}`);
  const started = await docker(["start", id], { allowFailure: true });
  if (started.status !== 0) throw new Error(`docker start failed: ${started.stderr.trim()}`);
  return id;
}

async function checkImage(build, { docker, resources, builder, socket, noCache, logDir, run }) {
  const boot = BOOTS[build.dockerfile];
  if (!boot) throw new Error(`no boot check for ${build.dockerfile}; add one to BOOTS in scripts/check-docker-images.mjs`);
  const slug = build.dockerfile.replace(/\/Dockerfile$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const buildImage = async ({ name, args, file, context }) => {
    const tag = resources.claimImage(`conclave-check-images/${name}:${run}`);
    const built = await docker(["buildx", "build", "--builder", builder, "--load", "--progress=plain", ...(noCache ? ["--no-cache"] : []), ...args, ...(file ? ["-f", file] : []), "-t", tag, context], { allowFailure: true });
    const log = path.join(logDir, `${name}-build.log`);
    writeFileSync(log, `${built.stdout}${built.stderr}`);
    return { tag, ok: built.status === 0, log };
  };
  const buildArgs = Object.entries(build.args).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
  const images = [
    { name: slug, args: buildArgs, file: build.dockerfile, context: "." },
    ...(boot.companions ?? []).map((companion) => ({ name: `${slug}-${companion.slug}`, args: [], context: companion.context, env: companion.env })),
  ];
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  let buildSeconds = null;
  let id = null;
  try {
    const env = boot.env();
    let tag = null;
    for (const image of images) {
      const built = await buildImage(image);
      if (!built.ok) return { dockerfile: build.dockerfile, ok: false, detail: `build failed after ${seconds()} s, see ${built.log}` };
      if (image.env) env[image.env] = built.tag;
      else tag = built.tag;
    }
    buildSeconds = seconds();
    id = await startContainer(docker, resources, { name: `conclave-check-images-${slug}-${run}`, tag, env, mounts: boot.mounts({ socket }) });
    const detail = await boot.ready(docker, id, { socket });
    return { dockerfile: build.dockerfile, ok: true, detail: `built in ${buildSeconds} s, ${detail}` };
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    const stage = buildSeconds === null ? `build failed after ${seconds()} s` : `built in ${buildSeconds} s, boot failed`;
    return { dockerfile: build.dockerfile, ok: false, detail: `${stage}: ${error.message}` };
  } finally {
    if (id && !docker.session.signal) {
      const logs = await docker(["logs", id], { allowFailure: true });
      writeFileSync(path.join(logDir, `${slug}-boot.log`), `${logs.stdout}${logs.stderr}`);
    }
    await resources.removeAll();
  }
}

async function main(session) {
  const noCache = process.argv.includes("--no-cache");
  const problems = contextProblems(repoRoot);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    throw new Error("pnpm check:docker-context fails; fix the build context first");
  }
  const daemon = localSocket(await resolveDockerEndpoint(process.env, session));
  const docker = pinnedDocker(daemon, process.env, session);
  const builder = await assertLocalBuilder(docker);
  const socket = await browserSocketSource(docker, { socket: daemon.socket });
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const run = `${head}-${randomBytes(6).toString("hex")}`;
  const logDir = mkdtempSync(path.join(tmpdir(), "conclave-check-images-"));
  console.log(`building root-context images at ${head} on ${daemon.host} with buildx builder ${builder}${noCache ? " without cache" : ""}; nothing is pushed`);
  const builds = [...new Map(rootContextBuilds(repoRoot).map((build) => [build.dockerfile, build])).values()];
  const resources = new RunResources(docker);
  const results = [];
  try {
    for (const build of builds) {
      const result = await checkImage(build, { docker, resources, builder, socket, noCache, logDir, run });
      console.log(`${result.ok ? "ok" : "FAIL"} ${result.dockerfile}: ${result.detail}`);
      results.push(result);
    }
  } finally {
    await resources.removeAll();
    console.log(`logs in ${logDir}`);
  }
  return results.every((result) => result.ok);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const session = new DockerSession();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!session.signal) console.error(`${signal}: stopping, then removing the containers and image tags this run created`);
      session.interrupt(signal);
    });
  }
  main(session).then(
    (ok) => {
      process.exitCode = session.signal ? session.exitCode : ok ? 0 : 1;
    },
    (error) => {
      if (!session.signal) console.error(error.message);
      process.exitCode = session.signal ? session.exitCode : 1;
    },
  );
}
