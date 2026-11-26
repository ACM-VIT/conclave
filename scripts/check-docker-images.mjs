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
const PROBE_MARGIN_MS = 1_000;
const PROBE_ANSWER = /^(?:[1-5][0-9]{2}|0|timeout)$/;
const LOGS_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 15_000;
const CLEANUP_BUDGET_MS = 60_000;
const CLEANUP_COMMAND_TIMEOUT_MS = 20_000;
const EXIT_DRAIN_MS = 2_000;
const VM_DAEMON_SOCKET = "/var/run/docker.sock";
const LOCAL_BUILDER = "default";
const OWNER_LABEL = "conclave-check-images.owner";

export class Interrupted extends Error {
  constructor(signal) {
    super(`${signal}: stopped`);
    this.signal = signal;
  }
}

export function completed(result) {
  return result.status === 0 && !result.incomplete && !result.timedOut;
}

export class DockerSession {
  constructor({ graceMs = INTERRUPT_GRACE_MS, drainMs = EXIT_DRAIN_MS } = {}) {
    this.graceMs = graceMs;
    this.drainMs = drainMs;
    this.signal = null;
    this.running = new Set();
  }

  get exitCode() {
    return 128 + constants.signals[this.signal];
  }

  interrupt(signal) {
    if (this.signal) return;
    this.signal = signal;
    for (const command of this.running) {
      command.signal(signal);
      command.escalate(this.graceMs);
    }
  }

  run(args, env, { allowFailure = false, cleanup = false, timeoutMs } = {}) {
    if (this.signal && !cleanup) return Promise.reject(new Interrupted(this.signal));
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { cwd: repoRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      let exited = false;
      let settled = false;
      let timedOut = false;
      const timers = new Set();
      const later = (ms, action) => timers.add(setTimeout(action, Math.max(0, ms)));
      const command = {
        signal: (name) => {
          if (exited || settled) return;
          try {
            process.kill(-child.pid, name);
          } catch {}
        },
        escalate: (ms) => later(ms, () => command.signal("SIGKILL")),
      };
      if (!cleanup) this.running.add(command);
      const stop = () => {
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        this.running.delete(command);
      };
      const finish = (status, incomplete) => {
        if (settled) return;
        stop();
        child.stdout.destroy();
        child.stderr.destroy();
        if (this.signal && !cleanup) return reject(new Interrupted(this.signal));
        if (timedOut) {
          if (!allowFailure) return reject(new Error(`docker ${args.join(" ")} did not finish within ${timeoutMs / 1000} s`));
          return resolve({ status: null, timedOut: true, stdout, stderr });
        }
        if (incomplete && !allowFailure) return reject(new Error(`docker ${args.join(" ")} exited but did not close its output within ${this.drainMs / 1000} s`));
        if (status !== 0 && !allowFailure) return reject(new Error(`docker ${args.join(" ")} failed:\n${stderr.trim()}`));
        resolve(incomplete ? { status, incomplete: true, stdout, stderr } : { status, stdout, stderr });
      };
      if (timeoutMs !== undefined) {
        later(timeoutMs, () => {
          timedOut = true;
          if (exited) finish(null, false);
          else command.signal("SIGKILL");
        });
      }
      child.on("error", (error) => {
        if (settled) return;
        stop();
        reject(error);
      });
      child.on("exit", (status) => {
        exited = true;
        later(this.drainMs, () => finish(status, true));
      });
      child.on("close", (status) => finish(status, false));
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

export function healthProbe(port, ms) {
  return [
    `const say = (value) => process.stdout.write(String(value) + "\\n");`,
    `const stop = setTimeout(() => { say("timeout"); process.exit(3); }, ${ms});`,
    `fetch("http://127.0.0.1:${port}/health", { signal: AbortSignal.timeout(${ms}) })`,
    `  .then(async (response) => { await response.text(); say(response.status); })`,
    `  .catch(() => say(0))`,
    `  .finally(() => clearTimeout(stop));`,
  ].join("\n");
}

function insideTimeout(remaining) {
  return Math.max(100, remaining - PROBE_MARGIN_MS);
}

export function probeVerdict(probe) {
  const answer = probe.stdout.trim();
  if (probe.timedOut || answer === "timeout") return { healthy: false, last: "the probe did not finish" };
  if (probe.incomplete) return { healthy: false, last: "the probe output was cut off" };
  if (!answer && probe.status !== 0) return { healthy: false, last: probe.stderr.trim().split("\n").at(-1) || "exec failed" };
  if (!PROBE_ANSWER.test(answer)) return { healthy: false, last: `unexpected probe output ${JSON.stringify(answer)}` };
  if (answer === "200") return { healthy: true, last: "HTTP 200" };
  return { healthy: false, last: answer === "0" ? "no connection" : `HTTP ${answer}` };
}

export async function waitForHealth(docker, id, port, { deadline = Date.now() + BOOT_TIMEOUT_MS } = {}) {
  const remaining = () => deadline - Date.now();
  let last = "no answer";
  while (remaining() > 0) {
    const probe = await docker(["exec", id, "node", "-e", healthProbe(port, insideTimeout(remaining()))], { allowFailure: true, timeoutMs: remaining() });
    const verdict = probeVerdict(probe);
    if (verdict.healthy) return;
    last = verdict.last;
    if (remaining() <= 0) break;
    const state = await docker(["inspect", "-f", "{{.State.Running}}", id], { allowFailure: true, timeoutMs: remaining() });
    if (state.timedOut) break;
    if (!state.incomplete && state.stdout.trim() !== "true") throw new Error(`the container exited before /health answered 200 (last: ${last})`);
    await sleep(Math.max(0, Math.min(500, remaining())));
  }
  throw new Error(`/health did not answer 200 before the boot deadline (last: ${last})`);
}

function importCheck(ms) {
  return `const stop = setTimeout(() => { process.stderr.write("the import did not finish\\n"); process.exit(3); }, ${ms}); await import("@conclave/apps-sdk/authority/server"); clearTimeout(stop);`;
}

export const BOOTS = {
  "packages/sfu/Dockerfile": {
    port: 3031,
    env: () => ({ SFU_PORT: "3031", SFU_SECRET: randomBytes(24).toString("hex"), NODE_ENV: "development" }),
    mounts: () => [],
    async ready(docker, id, { deadline }) {
      await waitForHealth(docker, id, 3031, { deadline });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("the boot deadline passed before the @conclave/apps-sdk import check");
      await docker(["exec", "-w", "/app/packages/sfu", id, "node", "--import", "tsx", "-e", importCheck(insideTimeout(remaining))], { timeoutMs: remaining });
      return "/health answered 200 and @conclave/apps-sdk/authority/server imported";
    },
  },
  "packages/shared-browser/Dockerfile": {
    port: 3040,
    companions: [{ context: "packages/shared-browser/docker", env: "BROWSER_IMAGE_NAME", slug: "session" }],
    env: () => ({ BROWSER_SERVICE_HOST: "127.0.0.1", BROWSER_SERVICE_PORT: "3040", BROWSER_SERVICE_TOKEN: randomBytes(24).toString("hex") }),
    mounts: ({ socket }) => ["-v", `${socket}:/var/run/docker.sock`],
    async ready(docker, id, { socket, deadline }) {
      await waitForHealth(docker, id, 3040, { deadline });
      return `/health answered 200 with ${socket} mounted and the session image from packages/shared-browser/docker`;
    },
  },
};

export class RunResources {
  constructor(docker, { budgetMs = CLEANUP_BUDGET_MS, commandTimeoutMs = CLEANUP_COMMAND_TIMEOUT_MS } = {}) {
    this.docker = docker;
    this.budgetMs = budgetMs;
    this.commandTimeoutMs = commandTimeoutMs;
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
    const deadline = Date.now() + this.budgetMs;
    const cleanup = async (args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: null, timedOut: true, stdout: "", stderr: "" };
      return this.docker(args, { allowFailure: true, cleanup: true, timeoutMs: Math.min(this.commandTimeoutMs, remaining) });
    };
    for (const owner of [...this.owners]) {
      const listed = await cleanup(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${owner}`]);
      if (!completed(listed)) continue;
      let removed = true;
      for (const id of listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        removed = completed(await cleanup(["rm", "-f", id])) && removed;
      }
      if (removed) this.owners.delete(owner);
    }
    for (const image of [...this.images]) {
      if (completed(await cleanup(["rmi", image]))) {
        this.images.delete(image);
        continue;
      }
      const listed = await cleanup(["image", "ls", "-q", "--filter", `reference=${image}`]);
      if (completed(listed) && !listed.stdout.trim()) this.images.delete(image);
    }
  }

  leftovers() {
    return [...[...this.owners].map((owner) => `containers labelled ${owner}`), ...this.images];
  }
}

export async function startContainer(docker, resources, { name, tag, env, mounts }) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const owner = resources.claimContainer();
  const created = await docker(["create", "--name", name, "--label", owner, ...envArgs, ...mounts, tag], { allowFailure: true });
  const id = created.stdout.trim();
  if (!completed(created) || !/^[0-9a-f]{12,64}$/.test(id)) throw new Error(`docker create failed: ${created.stderr.trim() || id}`);
  const started = await docker(["start", id], { allowFailure: true });
  if (!completed(started)) throw new Error(`docker start failed: ${started.stderr.trim()}`);
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
    return { tag, ok: completed(built), log };
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
    const detail = await boot.ready(docker, id, { socket, deadline: Date.now() + BOOT_TIMEOUT_MS });
    return { dockerfile: build.dockerfile, ok: true, detail: `built in ${buildSeconds} s, ${detail}` };
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    const stage = buildSeconds === null ? `build failed after ${seconds()} s` : `built in ${buildSeconds} s, boot failed`;
    return { dockerfile: build.dockerfile, ok: false, detail: `${stage}: ${error.message}` };
  } finally {
    if (id && !docker.session.signal) {
      const logs = await docker(["logs", id], { allowFailure: true, timeoutMs: LOGS_TIMEOUT_MS });
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
  let cleanedUp = false;
  try {
    for (const build of builds) {
      if (session.signal) throw new Interrupted(session.signal);
      const result = await checkImage(build, { docker, resources, builder, socket, noCache, logDir, run });
      console.log(`${result.ok ? "ok" : "FAIL"} ${result.dockerfile}: ${result.detail}`);
      results.push(result);
    }
  } finally {
    await resources.removeAll();
    const left = resources.leftovers();
    if (left.length) console.error(`cleanup could not confirm the removal of ${left.join(", ")}; remove them by hand`);
    cleanedUp = left.length === 0;
    console.log(`logs in ${logDir}`);
  }
  return cleanedUp && results.every((result) => result.ok);
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
