import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { repoRoot } from "./check-docker-context.mjs";
import { BOOTS, DockerSession, Interrupted, RunResources, healthProbe, probeVerdict, waitForHealth, assertLocalBuilder, browserSocketSource, localSocket, pinnedDocker, pinnedEnv, resolveDockerEndpoint, startContainer } from "./check-docker-images.mjs";

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args: process.argv.slice(2), DOCKER_HOST: process.env.DOCKER_HOST ?? null, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? null, BUILDX_BUILDER: process.env.BUILDX_BUILDER ?? null, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? null }) + "\\n");
const contexts = JSON.parse(process.env.FAKE_DOCKER_CONTEXTS ?? "{}");
const args = process.argv[2] === "--host" ? process.argv.slice(4) : process.argv.slice(2);
if (args[0] === "context" && args[1] === "show") process.stdout.write((process.env.FAKE_DOCKER_CURRENT ?? "default") + "\\n");
else if (args[0] === "context" && args[1] === "inspect") {
  if (!(args[2] in contexts)) { process.stderr.write("context not found\\n"); process.exit(1); }
  process.stdout.write(contexts[args[2]] + "\\n");
} else if (args[0] === "buildx" && args[1] === "inspect") process.stdout.write(process.env.FAKE_DOCKER_BUILDER ?? "Name: default\\nDriver: docker\\n\\nNodes:\\nName: default\\nEndpoint: default\\nStatus: running\\n");
else if (args[0] === "create" && process.env.FAKE_DOCKER_RUN_CONFLICT) { process.stderr.write("Conflict. The container name is already in use by container \\"0ther0ther0ther0\\".\\n"); process.exit(125); }
else if (args[0] === "create") {
  const labels = args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg] : []));
  const created = fs.existsSync(process.env.FAKE_DOCKER_STATE) ? fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8").split("\\n").filter((line) => line.includes('"id"')).length : 0;
  const id = "0123456789abcdef" + (0x0123 + created).toString(16).padStart(4, "0");
  fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ id, labels }) + "\\n");
  process.stdout.write(id + "\\n");
  if (process.env.FAKE_DOCKER_CREATE_HANG) {
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ received: signal }) + "\\n"); process.exit(1); });
    setTimeout(() => process.exit(70), 60000);
  }
} else if (args[0] === "ps" && process.env.FAKE_DOCKER_FAIL_ONCE?.split(",").includes("ps") && !fs.existsSync(process.env.FAKE_DOCKER_STATE + ".ps-failed")) {
  fs.writeFileSync(process.env.FAKE_DOCKER_STATE + ".ps-failed", "");
  process.stderr.write("Cannot connect to the Docker daemon\\n");
  process.exit(1);
} else if (args[0] === "rm" && process.env.FAKE_DOCKER_RM_HANG) {
  fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ execPid: process.pid }) + "\\n");
  setTimeout(() => process.exit(70), 60000);
} else if (args[0] === "rm" && process.env.FAKE_DOCKER_FAIL_ONCE?.split(",").includes("rm") && !fs.existsSync(process.env.FAKE_DOCKER_STATE + ".rm-failed")) {
  fs.writeFileSync(process.env.FAKE_DOCKER_STATE + ".rm-failed", "");
  process.stderr.write("Error response from daemon: removal already in progress\\n");
  process.exit(1);
} else if (args[0] === "rm") {
  fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ removed: args[2] }) + "\\n");
} else if (args[0] === "rmi" || (args[0] === "image" && args[1] === "ls")) {
  const state = fs.existsSync(process.env.FAKE_DOCKER_STATE) ? fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const removed = new Set(state.filter((entry) => entry.removed).map((entry) => entry.removed));
  const tag = args[0] === "rmi" ? args[1] : args[args.indexOf("--filter") + 1].replace(/^reference=/, "");
  const live = state.filter((entry) => entry.image === tag).length > state.filter((entry) => entry.removedImage === tag).length;
  if (args[0] === "image") { if (live) process.stdout.write("sha256:0f0f0f0f0f0f\\n"); }
  else if (!live) { process.stderr.write("Error response from daemon: No such image: " + tag + "\\n"); process.exit(1); }
  else if (process.env.FAKE_DOCKER_RMI_FAIL) { process.stderr.write("Error response from daemon: dial unix docker.sock: connect: connection refused\\n"); process.exit(1); }
  else if (state.some((entry) => entry.id && !removed.has(entry.id))) { process.stderr.write("conflict: unable to remove repository reference (must force) - container is using its referenced image\\n"); process.exit(1); }
  else {
    const remove = () => fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ removedImage: tag }) + "\\n");
    if (process.env.FAKE_DOCKER_RMI_RELEASE) {
      const wait = setInterval(() => {
        if (!fs.existsSync(process.env.FAKE_DOCKER_RMI_RELEASE)) return;
        clearInterval(wait);
        remove();
      }, 20);
    } else remove();
  }
} else if (args[0] === "ps") {
  const filter = args[args.indexOf("--filter") + 1].replace(/^label=/, "");
  const state = fs.existsSync(process.env.FAKE_DOCKER_STATE) ? fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const removed = new Set(state.filter((entry) => entry.removed).map((entry) => entry.removed));
  for (const container of state) if (container.id && !removed.has(container.id) && container.labels.includes(filter)) process.stdout.write(container.id + "\\n");
}
else if (args[0] === "start" && process.env.FAKE_DOCKER_START_FAIL) { process.stderr.write("failed to create task for container: exec: \\"bad\\": executable file not found\\n"); process.exit(1); }
else if (args[0] === "buildx" && args[1] === "build" && process.env.FAKE_DOCKER_BUILD_HANG && !fs.existsSync(process.env.FAKE_DOCKER_BUILD_HANG)) {
  fs.writeFileSync(process.env.FAKE_DOCKER_BUILD_HANG, "");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ received: signal }) + "\\n"); if (!process.env.FAKE_DOCKER_IGNORE_SIGNALS) process.exit(1); });
  const ready = () => {
    fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ ready: true, buildPid: process.pid }) + "\\n");
    if (process.env.FAKE_DOCKER_BUILD_EXIT_AFTER_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_DOCKER_BUILD_EXIT_AFTER_MS));
  };
  if (process.env.FAKE_DOCKER_GRANDCHILD) {
    const plugin = require("node:child_process").spawn(process.execPath, ["-e", "for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {}); const socket = require('node:path').join(require('node:path').dirname(process.env.FAKE_DOCKER_LOG), 'p' + process.pid + '.sock'); require('node:net').createServer(() => process.exit(0)).listen(socket, () => require('node:fs').appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ pluginPid: process.pid, pluginSocket: socket }) + String.fromCharCode(10))); setTimeout(() => process.exit(0), 60000);"], { stdio: ["ignore", "inherit", "inherit"] });
    const waiting = setInterval(() => {
      if (fs.readFileSync(process.env.FAKE_DOCKER_LOG, "utf8").includes('"pluginPid":' + plugin.pid)) {
        clearInterval(waiting);
        ready();
      }
    }, 20);
  } else ready();
  setTimeout(() => process.exit(70), 60000);
} else if (args[0] === "buildx" && args[1] === "build" && process.env.FAKE_DOCKER_BUILD_FAIL && args[args.indexOf("-t") + 1].includes(process.env.FAKE_DOCKER_BUILD_FAIL)) { process.stderr.write("build failed\\n"); process.exit(1); }
else if (args[0] === "buildx" && args[1] === "build") fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ image: args[args.indexOf("-t") + 1] }) + "\\n");
else if ((args[0] === "exec" && process.env.FAKE_DOCKER_EXEC_HANG) || (args[0] === "exec" && args.includes("--import") && process.env.FAKE_DOCKER_IMPORT_HANG)) {
  fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ execPid: process.pid }) + "\\n");
  setTimeout(() => process.exit(70), 60000);
}
else if (args[0] === "exec" && process.env.FAKE_DOCKER_PROBE_OUTPUT) process.stdout.write(process.env.FAKE_DOCKER_PROBE_OUTPUT);
else if (args[0] === "exec" && process.env.FAKE_DOCKER_HEALTHY) process.stdout.write("200\\n");
else if (args[0] === "inspect") process.stdout.write("true\\n");
else if (args[0] === "info") process.stdout.write((process.env.FAKE_DOCKER_INFO ?? JSON.stringify({ OperatingSystem: "OrbStack", Name: "orbstack" })) + "\\n");
`;

const pluginSockets = [];
const fixtureDirs = [];

function recordedPluginSockets(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.pluginSocket).map((entry) => entry.pluginSocket);
}

function stopPlugin(socket) {
  return new Promise((resolve) => {
    const connection = createConnection(socket);
    const timer = setTimeout(() => {
      connection.destroy();
      resolve(false);
    }, 2000);
    connection.on("connect", () => connection.on("close", () => {
      clearTimeout(timer);
      resolve(true);
    }));
    connection.on("error", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function pluginGone(socket) {
  return new Promise((resolve) => {
    const connection = createConnection(socket);
    connection.on("connect", () => {
      connection.destroy();
      resolve(false);
    });
    connection.on("error", () => resolve(true));
  });
}

after(async () => {
  const alive = [];
  for (const socket of pluginSockets) if (!(await pluginGone(socket))) alive.push(socket);
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(alive, []);
});

function fakeDocker(t, { contexts = {}, current = "default", ...extra } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
  fixtureDirs.push(dir);
  t.after(async () => {
    for (const socket of recordedPluginSockets(path.join(dir, "calls.jsonl"))) {
      pluginSockets.push(socket);
      await stopPlugin(socket);
    }
  });
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "docker"), FAKE_DOCKER);
  chmodSync(path.join(dir, "bin", "docker"), 0o755);
  const log = path.join(dir, "calls.jsonl");
  const env = {
    PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
    HOME: process.env.HOME,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_STATE: path.join(dir, "containers.jsonl"),
    FAKE_DOCKER_CONTEXTS: JSON.stringify(contexts),
    FAKE_DOCKER_CURRENT: current,
    ...extra,
  };
  const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const calls = () => entries().filter((entry) => entry.args);
  const received = () => entries().filter((entry) => entry.received).map((entry) => entry.received);
  return { env, calls, received, dir };
}

test("DOCKER_HOST wins over DOCKER_CONTEXT without asking docker", async (t) => {
  const fake = fakeDocker(t, { contexts: { remote: "tcp://203.0.113.1:2376" } });
  assert.equal(await resolveDockerEndpoint({ ...fake.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "remote" }), "unix:///var/run/docker.sock");
  assert.deepEqual(fake.calls(), []);
});

test("DOCKER_CONTEXT, then the current context, decide the endpoint when DOCKER_HOST is unset", async (t) => {
  const fake = fakeDocker(t, { current: "rootless", contexts: { remote: "tcp://203.0.113.1:2376", rootless: "unix:///run/user/1000/docker.sock" } });
  assert.equal(await resolveDockerEndpoint({ ...fake.env, DOCKER_CONTEXT: "remote" }), "tcp://203.0.113.1:2376");
  assert.equal(await resolveDockerEndpoint(fake.env), "unix:///run/user/1000/docker.sock");
  assert.deepEqual(fake.calls().map((call) => call.args), [
    ["context", "inspect", "remote", "--format", "{{.Endpoints.docker.Host}}"],
    ["context", "show"],
    ["context", "inspect", "rootless", "--format", "{{.Endpoints.docker.Host}}"],
  ]);
});

test("only a local unix socket is accepted", () => {
  assert.deepEqual(localSocket("unix:///run/user/1000/docker.sock"), { host: "unix:///run/user/1000/docker.sock", socket: "/run/user/1000/docker.sock" });
  for (const endpoint of ["tcp://203.0.113.1:2376", "ssh://deploy@example.com", "npipe:////./pipe/docker_engine", "unix://docker.sock", ""]) {
    assert.throws(() => localSocket(endpoint), /is not a local unix socket/, endpoint);
  }
});

test("every docker call after the check is pinned to the checked endpoint", async (t) => {
  const fake = fakeDocker(t);
  const docker = pinnedDocker({ host: "unix:///run/user/1000/docker.sock" }, { ...fake.env, DOCKER_HOST: "unix:///elsewhere.sock", DOCKER_CONTEXT: "remote", BUILDX_BUILDER: "olympus-ec2" });
  await docker(["build", "."]);
  await docker(["run", "-d", "x"]);
  assert.deepEqual(fake.calls(), [
    { args: ["--host", "unix:///run/user/1000/docker.sock", "build", "."], DOCKER_HOST: null, DOCKER_CONTEXT: null, BUILDX_BUILDER: null, DOCKER_CONFIG: null },
    { args: ["--host", "unix:///run/user/1000/docker.sock", "run", "-d", "x"], DOCKER_HOST: null, DOCKER_CONTEXT: null, BUILDX_BUILDER: null, DOCKER_CONFIG: null },
  ]);
});

test("a remote effective endpoint stops the run before anything is built", async (t) => {
  const fake = fakeDocker(t, { contexts: { remote: "tcp://203.0.113.1:2376" } });
  const child = spawn(process.execPath, ["scripts/check-docker-images.mjs"], { cwd: repoRoot, env: { ...fake.env, DOCKER_CONTEXT: "remote" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(stderr, /tcp:\/\/203\.0\.113\.1:2376 is not a local unix socket/);
  assert.deepEqual(fake.calls().map((call) => call.args[0]), ["context"]);
});

test("SIGINT during the readiness wait removes the container and image tag this run created", async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const child = spawn(process.execPath, ["scripts/check-docker-images.mjs"], { cwd: repoRoot, env: fake.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  while (!fake.calls().some((call) => call.args.includes("exec")) && Date.now() < deadline) await sleep(50);
  child.kill("SIGINT");
  const { code } = await exited;
  assert.equal(code, 130);
  const calls = fake.calls().map((call) => call.args);
  const tag = calls.find((args) => args[2] === "buildx" && args[3] === "build").at(-2);
  assert.match(tag, /^conclave-check-images\/packages-sfu:[0-9a-f]+-[0-9a-f]{12}$/);
  assert.ok(calls.some((args) => args.slice(2).join(" ") === "rm -f 0123456789abcdef0123"), JSON.stringify(calls));
  assert.ok(calls.some((args) => args.slice(2).join(" ") === `rmi ${tag}`), JSON.stringify(calls));
  assert.ok(calls.every((args) => args[0] === "context" || args[1] === "unix:///run/fake-docker.sock"));
});

test("the shared browser mounts the daemon-side socket: the VM path for VM daemons, the resolved path for a native Linux engine", async (t) => {
  const socket = "/run/user/1000/docker.sock";
  const cases = [
    ["OrbStack on macOS", "darwin", { OperatingSystem: "OrbStack", Name: "orbstack" }, "/var/run/docker.sock"],
    ["Docker Desktop on macOS", "darwin", { OperatingSystem: "Docker Desktop", Name: "docker-desktop" }, "/var/run/docker.sock"],
    ["Docker Desktop on Linux", "linux", { OperatingSystem: "Docker Desktop", Name: "docker-desktop" }, "/var/run/docker.sock"],
    ["Colima on macOS", "darwin", { OperatingSystem: "Ubuntu 24.04.1 LTS", Name: "colima" }, "/var/run/docker.sock"],
    ["Colima on Linux", "linux", { OperatingSystem: "Ubuntu 24.04.1 LTS", Name: "colima" }, "/var/run/docker.sock"],
    ["rootless engine on Linux", "linux", { OperatingSystem: "Ubuntu 24.04.1 LTS", Name: "build-box" }, socket],
    ["system engine on Linux", "linux", { OperatingSystem: "Debian GNU/Linux 13 (trixie)", Name: "build-box" }, socket],
  ];
  for (const [name, platform, info, expected] of cases) {
    const fake = fakeDocker(t, { FAKE_DOCKER_INFO: JSON.stringify(info) });
    const docker = pinnedDocker({ host: `unix://${socket}` }, fake.env);
    assert.equal(await browserSocketSource(docker, { socket, env: fake.env, platform }), expected, name);
    assert.deepEqual(fake.calls().map((call) => call.args.slice(2)), [["info", "--format", "{{json .}}"]], name);
  }
});

test("BROWSER_DOCKER_SOCKET overrides the mount source without asking docker", async (t) => {
  const fake = fakeDocker(t);
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  assert.equal(await browserSocketSource(docker, { socket: "/var/run/docker.sock", env: { ...fake.env, BROWSER_DOCKER_SOCKET: "/srv/docker.sock" }, platform: "linux" }), "/srv/docker.sock");
  assert.deepEqual(fake.calls(), []);
});

test("the child environment keeps config locations and drops endpoint, TLS and builder selectors", () => {
  const clean = pinnedEnv({ PATH: "/bin", HOME: "/home/x", DOCKER_HOST: "a", DOCKER_CONTEXT: "b", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/certs", DOCKER_CONFIG: "/cfg", BUILDX_BUILDER: "olympus-ec2", BUILDX_CONFIG: "/bx", BROWSER_DOCKER_SOCKET: "/s" });
  assert.deepEqual(clean, { PATH: "/bin", HOME: "/home/x", DOCKER_CONFIG: "/cfg", BUILDX_CONFIG: "/bx", BROWSER_DOCKER_SOCKET: "/s" });
});

test("a custom DOCKER_CONFIG folder reaches every pinned docker call", async (t) => {
  const config = mkdtempSync(path.join(tmpdir(), "docker-config-"));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  writeFileSync(path.join(config, "config.json"), JSON.stringify({ proxies: { default: { httpProxy: "http://proxy.invalid:3128" } } }));
  const fake = fakeDocker(t);
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, { ...fake.env, DOCKER_CONFIG: config, DOCKER_CONTEXT: "remote" });
  assert.equal(await assertLocalBuilder(docker), "default");
  await docker(["build", "."]);
  assert.deepEqual(fake.calls().map((call) => [call.args[2], call.DOCKER_CONFIG, call.DOCKER_CONTEXT]), [["buildx", config, null], ["build", config, null]]);
});

test("a container that is created but fails to start is still removed by the id its owner label lists", async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_START_FAIL: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const resources = new RunResources(docker);
  await assert.rejects(startContainer(docker, resources, { name: "conclave-check-images-x", tag: "t", env: {}, mounts: [] }), /docker start failed: .*executable file not found/);
  await resources.removeAll();
  const calls = fake.calls().map((call) => call.args.slice(2));
  const label = calls[0][calls[0].indexOf("--label") + 1];
  assert.match(label, /^conclave-check-images\.owner=[0-9a-f]{24}$/);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [["create", "--name", "conclave-check-images-x"], ["start", "0123456789abcdef0123"], ["ps", "-a", "-q"], ["rm", "-f", "0123456789abcdef0123"]]);
  assert.deepEqual(calls[2], ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${label}`]);
});

test("only the docker driver on the checked endpoint is accepted as the builder", async (t) => {
  const local = fakeDocker(t);
  assert.equal(await assertLocalBuilder(pinnedDocker({ host: "unix:///var/run/docker.sock" }, local.env)), "default");
  assert.deepEqual(local.calls().map((call) => call.args.slice(2)), [["buildx", "inspect", "default"]]);
  for (const [name, text] of [
    ["container driver", "Name: default\nDriver: docker-container\n\nNodes:\nName: default0\nEndpoint: unix:///var/run/docker.sock\n"],
    ["remote driver", "Name: default\nDriver: remote\n\nNodes:\nName: default0\nEndpoint: tcp://203.0.113.1:1234\n"],
    ["ssh endpoint", "Name: default\nDriver: docker\n\nNodes:\nName: olympus-ec2\nEndpoint: olympus-ec2\n"],
  ]) {
    const fake = fakeDocker(t, { FAKE_DOCKER_BUILDER: text });
    await assert.rejects(assertLocalBuilder(pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env)), /refusing to build: buildx builder "default"/, name);
  }
});

test("a container name conflict removes nothing, because containers are only removed through the owner label this run chose", async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_RUN_CONFLICT: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const resources = new RunResources(docker);
  await assert.rejects(startContainer(docker, resources, { name: "conclave-check-images-taken", tag: "t", env: {}, mounts: [] }), /docker create failed: Conflict/);
  await resources.removeAll();
  assert.deepEqual(fake.calls().map((call) => call.args[2]), ["create", "ps"]);
});

test("every image build goes to the pinned local builder", async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const child = spawn(process.execPath, ["scripts/check-docker-images.mjs"], { cwd: repoRoot, env: { ...fake.env, BUILDX_BUILDER: "olympus-ec2" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 20_000;
  while (!fake.calls().some((call) => call.args.includes("exec")) && Date.now() < deadline) await sleep(50);
  child.kill("SIGINT");
  await exited;
  const builds = fake.calls().filter((call) => call.args[2] === "buildx" && call.args[3] === "build");
  assert.ok(builds.length > 0);
  for (const call of builds) {
    assert.deepEqual(call.args.slice(0, 6), ["--host", "unix:///run/fake-docker.sock", "buildx", "build", "--builder", "default"]);
    assert.equal(call.BUILDX_BUILDER, null);
  }
});

async function waitFor(condition, what) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function runScript(t, env, { detached = false } = {}) {
  const child = spawn(process.execPath, ["scripts/check-docker-images.mjs"], { cwd: repoRoot, env, detached, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(detached ? -child.pid : child.pid, "SIGKILL");
    } catch {}
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, exited };
}

const isBuild = (args) => args[2] === "buildx" && args[3] === "build";
const tagOf = (args) => args[args.indexOf("-t") + 1];

function assertStoppedDuringFirstBuild(calls) {
  const builds = calls.filter(isBuild);
  assert.equal(builds.length, 1, JSON.stringify(calls));
  const tag = tagOf(builds[0]);
  assert.match(tag, /^conclave-check-images\/packages-sfu:[0-9a-f]+-[0-9a-f]{12}$/);
  const after = calls.slice(calls.indexOf(builds[0]) + 1).map((args) => args.slice(2).join(" "));
  assert.deepEqual(after, [`rmi ${tag}`, `image ls -q --filter reference=${tag}`]);
}

test("SIGINT to the process group during an image build stops the run before any later step and removes the tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_BUILD_HANG: path.join(fake.dir, "hang") }, { detached: true });
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "ready").length > 0, "the first build");
  process.kill(-child.pid, "SIGINT");
  const { code, stderr } = await exited;
  assert.equal(code, 130, stderr);
  assertStoppedDuringFirstBuild(fake.calls().map((call) => call.args));
});

test("SIGTERM to the script during an image build is forwarded to docker, stops the run and removes the tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_BUILD_HANG: path.join(fake.dir, "hang") });
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "ready").length > 0, "the first build");
  child.kill("SIGTERM");
  const { code, stderr } = await exited;
  assert.equal(code, 143, stderr);
  assert.deepEqual(fake.received(), ["SIGTERM"]);
  assertStoppedDuringFirstBuild(fake.calls().map((call) => call.args));
});

test("SIGINT during the first image cleanup never claims or removes a second image tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" }, FAKE_DOCKER_HEALTHY: "1" });
  const release = path.join(fake.dir, "release-rmi");
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_RMI_RELEASE: release });
  let signalLogged = false;
  child.stderr.on("data", (chunk) => {
    if (chunk.toString().includes("SIGINT: stopping")) signalLogged = true;
  });
  try {
    await waitFor(() => fake.calls().some(({ args }) => args[2] === "rmi"), "the first image cleanup");
    assert.equal(child.kill("SIGINT"), true);
    await waitFor(() => signalLogged, "the SIGINT handler");
  } finally {
    writeFileSync(release, "");
  }
  const { code, stderr } = await exited;
  assert.equal(code, 130, stderr);
  const calls = fake.calls().map(({ args }) => args);
  const tags = calls.filter(isBuild).map(tagOf);
  assert.equal(tags.length, 1);
  assert.deepEqual(calls.filter((args) => args[2] === "rmi").map((args) => args[3]), tags);
  assert.deepEqual(fakeState(fake).filter(({ removedImage }) => removedImage).map(({ removedImage }) => removedImage), tags);
});

test("a failed image build skips its companion builds and its boot, and removes its tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { exited } = runScript(t, { ...fake.env, FAKE_DOCKER_HEALTHY: "1", FAKE_DOCKER_BUILD_FAIL: "packages-shared-browser:" });
  const { code, stderr } = await exited;
  assert.equal(code, 1, stderr);
  const calls = fake.calls().map((call) => call.args);
  const tags = calls.filter(isBuild).map(tagOf);
  assert.deepEqual(tags.map((tag) => tag.split(":")[0]), ["conclave-check-images/packages-sfu", "conclave-check-images/packages-shared-browser"]);
  const failed = calls.findIndex((args) => isBuild(args) && tagOf(args) === tags[1]);
  assert.deepEqual(calls.slice(failed + 1).map((args) => args.slice(2).join(" ")), [`rmi ${tags[1]}`, `image ls -q --filter reference=${tags[1]}`]);
  assert.doesNotMatch(stderr, /cleanup could not confirm the removal of/);
});

test("SIGTERM after docker create made the container but before it exited still removes that container", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_CREATE_HANG: "1" });
  await waitFor(() => fake.calls().some((call) => call.args[2] === "create") && existsSync(fake.env.FAKE_DOCKER_STATE), "docker create");
  await sleep(200);
  child.kill("SIGTERM");
  const { code, stderr } = await exited;
  assert.equal(code, 143, stderr);
  assert.deepEqual(fake.received(), ["SIGTERM"]);
  const calls = fake.calls().map((call) => call.args.slice(2).join(" "));
  const created = calls.findIndex((args) => args.startsWith("create "));
  const tag = calls.find((args) => args.startsWith("buildx build ")).split(" -t ")[1].split(" ")[0];
  assert.deepEqual(calls.slice(created + 1).map((args) => args.replace(/owner=[0-9a-f]+/, "owner=X")), ["ps -a -q --no-trunc --filter label=conclave-check-images.owner=X", "rm -f 0123456789abcdef0123", `rmi ${tag}`]);
});

test("a container or tag whose removal failed stays registered and is removed on the next pass", async (t) => {
  for (const failing of ["ps", "rm"]) {
    const fake = fakeDocker(t, { FAKE_DOCKER_FAIL_ONCE: failing });
    const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
    const resources = new RunResources(docker);
    const tag = resources.claimImage("conclave-check-images/x:run");
    await docker(["buildx", "build", "-t", tag, "."]);
    await startContainer(docker, resources, { name: "conclave-check-images-x", tag, env: {}, mounts: [] });
    await resources.removeAll();
    assert.equal(resources.owners.size, 1, failing);
    assert.deepEqual([...resources.images], [tag], failing);
    await resources.removeAll();
    assert.equal(resources.owners.size, 0, failing);
    assert.deepEqual([...resources.images], [], failing);
    const calls = fake.calls().map((call) => call.args.slice(2, 4).join(" "));
    assert.deepEqual(calls.slice(3), failing === "ps" ? ["ps -a", "rmi " + tag, "image ls", "ps -a", "rm -f", "rmi " + tag] : ["ps -a", "rm -f", "rmi " + tag, "image ls", "ps -a", "rm -f", "rmi " + tag], failing);
  }
});

function fakeState(fake) {
  return existsSync(fake.env.FAKE_DOCKER_STATE) ? readFileSync(fake.env.FAKE_DOCKER_STATE, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function assertEachRemovedOnce(fake, count) {
  const state = fakeState(fake);
  const created = state.filter((entry) => entry.id).map((entry) => entry.id);
  assert.equal(created.length, count, JSON.stringify(state));
  assert.equal(new Set(created).size, count, JSON.stringify(created));
  assert.deepEqual(state.filter((entry) => entry.removed).map((entry) => entry.removed).sort(), [...created].sort());
}

test("several containers are each removed exactly once when one removal fails and is retried", async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_FAIL_ONCE: "rm" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const resources = new RunResources(docker);
  const tag = resources.claimImage("conclave-check-images/x:run");
  await docker(["buildx", "build", "-t", tag, "."]);
  for (const name of ["a", "b", "c"]) await startContainer(docker, resources, { name: `conclave-check-images-${name}`, tag, env: {}, mounts: [] });
  await resources.removeAll();
  assert.equal(resources.owners.size, 1);
  assert.deepEqual([...resources.images], [tag]);
  await resources.removeAll();
  assert.equal(resources.owners.size, 0);
  assert.deepEqual([...resources.images], []);
  assertEachRemovedOnce(fake, 3);
  const rms = fake.calls().map((call) => call.args.slice(2)).filter((args) => args[0] === "rm").map((args) => args[2]);
  assert.deepEqual(rms, ["0123456789abcdef0123", "0123456789abcdef0124", "0123456789abcdef0125", "0123456789abcdef0123"]);
});

test("a full run removes every container it created exactly once", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { exited } = runScript(t, { ...fake.env, FAKE_DOCKER_HEALTHY: "1" });
  const { code, stderr } = await exited;
  assert.equal(code, 0, stderr);
  assertEachRemovedOnce(fake, 2);
});

test("the readiness wait is bounded even when a /health probe hangs inside docker exec", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_EXEC_HANG: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const started = Date.now();
  await assert.rejects(waitForHealth(docker, "0123456789abcdef0123", 3031, { deadline: Date.now() + 1500 }), /\/health did not answer 200 before the boot deadline \(last: the probe did not finish\)/);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  const pids = readFileSync(fake.env.FAKE_DOCKER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.execPid).map((entry) => entry.execPid);
  assert.ok(pids.length >= 1);
  await sleep(200);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a cleanup failure left after the final pass fails the run and names what is left", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { exited } = runScript(t, { ...fake.env, FAKE_DOCKER_HEALTHY: "1", FAKE_DOCKER_RMI_FAIL: "1" });
  const { code, stderr } = await exited;
  assert.equal(code, 1, stderr);
  const tags = fake.calls().map((call) => call.args).filter(isBuild).map(tagOf);
  assert.equal(tags.length, 3);
  assert.match(stderr, /cleanup could not confirm the removal of /);
  for (const tag of tags) assert.ok(stderr.includes(tag), `${tag} missing from ${stderr}`);
  assertEachRemovedOnce(fake, 2);
});

function loggedPids(fake, key) {
  return readFileSync(fake.env.FAKE_DOCKER_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry[key]).map((entry) => entry[key]);
}

function assertGone(pids) {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `pid ${pid} is still running`);
}

test("the SFU import check shares the boot deadline with the /health wait", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_HEALTHY: "1", FAKE_DOCKER_IMPORT_HANG: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const started = Date.now();
  await assert.rejects(BOOTS["packages/sfu/Dockerfile"].ready(docker, "0123456789abcdef0123", { deadline: Date.now() + 1500 }), /did not finish within/);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  await sleep(200);
  assertGone(loggedPids(fake, "execPid"));
});

async function probeAgainst(t, handler, ms) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.closeAllConnections() || server.close());
  const child = spawn(process.execPath, ["-e", healthProbe(server.address().port, ms)], { env: { ...process.env, FORCE_COLOR: "3" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const started = Date.now();
  const code = await new Promise((resolve) => child.on("exit", (exitCode) => resolve(exitCode)));
  return { stdout: stdout.trim(), code, elapsed: Date.now() - started };
}

test("the /health probe reports 200 only after the whole response, and stops itself at its own deadline", { timeout: 15_000 }, async (t) => {
  const complete = await probeAgainst(t, (req, res) => res.end('{"ok":true}'), 2000);
  assert.equal(complete.stdout, "200");
  const failing = await probeAgainst(t, (req, res) => {
    res.writeHead(503);
    res.end("down");
  }, 2000);
  assert.equal(failing.stdout, "503");
  const stalled = await probeAgainst(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
  }, 800);
  assert.notEqual(stalled.stdout, "200");
  assert.ok(stalled.elapsed < 8000, `took ${stalled.elapsed} ms`);
  const silent = await probeAgainst(t, () => {}, 800);
  assert.notEqual(silent.stdout, "200");
  assert.ok(silent.elapsed < 8000, `took ${silent.elapsed} ms`);
});

test("cleanup commands are bounded, and what they could not confirm removed stays reported", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_RM_HANG: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const resources = new RunResources(docker, { budgetMs: 1500, commandTimeoutMs: 600 });
  const tag = resources.claimImage("conclave-check-images/x:run");
  await docker(["buildx", "build", "-t", tag, "."]);
  await startContainer(docker, resources, { name: "conclave-check-images-a", tag, env: {}, mounts: [] });
  const started = Date.now();
  await resources.removeAll();
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  const left = resources.leftovers();
  assert.equal(left.length, 2, JSON.stringify(left));
  assert.match(left[0], /^containers labelled conclave-check-images\.owner=[0-9a-f]{24}$/);
  assert.equal(left[1], tag);
  await sleep(200);
  assertGone(loggedPids(fake, "execPid"));
});

test("after a signal, a docker command that ignores it is killed once the grace period ends", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang"), FAKE_DOCKER_IGNORE_SIGNALS: "1" });
  const session = new DockerSession({ graceMs: 600 });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env, session);
  const build = docker(["buildx", "build", "-t", "conclave-check-images/x:run", "."]);
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "ready").length > 0, "the build");
  const started = Date.now();
  session.interrupt("SIGTERM");
  await assert.rejects(build, Interrupted);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.deepEqual(fake.received(), ["SIGTERM"]);
  assertGone(loggedPids(fake, "buildPid"));
});

function fake0(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-marker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("only a probe line that is exactly a status, 0 or timeout counts, so coloured or extra output never passes as 200", { timeout: 30_000 }, async (t) => {
  const verdict = (stdout, extra = {}) => probeVerdict({ status: 0, stdout, stderr: "", ...extra });
  const cases = [
    ["200\n", { healthy: true, last: "HTTP 200" }],
    ["200\r\n", { healthy: true, last: "HTTP 200" }],
    ["503\n", { healthy: false, last: "HTTP 503" }],
    ["0\n", { healthy: false, last: "no connection" }],
    ["timeout\n", { healthy: false, last: "the probe did not finish" }],
    ["\u001b[33m200\u001b[39m\n", { healthy: false, last: 'unexpected probe output "\\u001b[33m200\\u001b[39m"' }],
    ["200 OK\n", { healthy: false, last: 'unexpected probe output "200 OK"' }],
    ["200\n200\n", { healthy: false, last: 'unexpected probe output "200\\n200"' }],
    [" 2000\n", { healthy: false, last: 'unexpected probe output "2000"' }],
    ["", { healthy: false, last: "exec failed" }, { status: 1 }],
    ["", { healthy: false, last: "OCI runtime exec failed" }, { status: 126, stderr: "x\nOCI runtime exec failed\n" }],
    ["200\n", { healthy: false, last: "the probe did not finish" }, { status: null, timedOut: true }],
  ];
  for (const [stdout, expected, extra] of cases) assert.deepEqual(verdict(stdout, extra), expected, JSON.stringify(stdout));
  const fake = fakeDocker(t, { FAKE_DOCKER_PROBE_OUTPUT: "\u001b[33m200\u001b[39m\n" });
  await assert.rejects(waitForHealth(pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env), "0123456789abcdef0123", 3031, { deadline: Date.now() + 1500 }), /did not answer 200/);
});

function spyOnKill(t) {
  const original = process.kill;
  const calls = [];
  process.kill = (pid, signal) => {
    calls.push([pid, signal]);
    return original.call(process, pid, signal);
  };
  t.after(() => {
    process.kill = original;
  });
  return calls;
}


test("a plugin that ignores the signal is stopped with its docker command while that command is still running", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang"), FAKE_DOCKER_GRANDCHILD: "1", FAKE_DOCKER_IGNORE_SIGNALS: "1" });
  const session = new DockerSession({ graceMs: 600, drainMs: 300 });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env, session);
  const build = docker(["buildx", "build", "-t", "conclave-check-images/x:run", "."]);
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "ready").length > 0, "the plugin");
  const started = Date.now();
  session.interrupt("SIGTERM");
  await assert.rejects(build, Interrupted);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  assert.deepEqual(fake.received(), ["SIGTERM"]);
  await sleep(300);
  assertGone([...loggedPids(fake, "buildPid"), ...loggedPids(fake, "pluginPid")]);
});

test("no process group is signalled after its docker command settled", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang") });
  const kills = spyOnKill(t);
  const session = new DockerSession({ graceMs: 400, drainMs: 300 });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env, session);
  const build = docker(["buildx", "build", "-t", "conclave-check-images/x:run", "."]);
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "ready").length > 0, "the build");
  const [pid] = loggedPids(fake, "buildPid");
  session.interrupt("SIGTERM");
  await assert.rejects(build, Interrupted);
  await sleep(800);
  assert.deepEqual(kills.filter(([target]) => target === -pid), [[-pid, "SIGTERM"]]);
});

test("a docker command that exits while a plugin keeps its output open settles as incomplete, and its group is not signalled after it exited", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_GRANDCHILD: "1", FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang"), FAKE_DOCKER_BUILD_EXIT_AFTER_MS: "300" });
  const kills = spyOnKill(t);
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env, new DockerSession({ drainMs: 300 }));
  const started = Date.now();
  const result = await docker(["buildx", "build", "-t", "conclave-check-images/x:run", "."], { allowFailure: true });
  assert.equal(result.status, 0);
  assert.equal(result.incomplete, true);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
  await sleep(300);
  const [pid] = loggedPids(fake, "buildPid");
  assert.deepEqual(kills.filter(([target]) => target === -pid), []);
  const strict = fakeDocker(t, { FAKE_DOCKER_GRANDCHILD: "1", FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang"), FAKE_DOCKER_BUILD_EXIT_AFTER_MS: "300" });
  await assert.rejects(pinnedDocker({ host: "unix:///var/run/docker.sock" }, strict.env, new DockerSession({ drainMs: 300 }))(["buildx", "build", "-t", "x", "."]), /did not close its output/);
});

test("interrupting during output drain never signals the exited docker leader's group", { timeout: 15_000 }, async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_GRANDCHILD: "1", FAKE_DOCKER_BUILD_HANG: path.join(fake0(t), "hang"), FAKE_DOCKER_BUILD_EXIT_AFTER_MS: "100" });
  const session = new DockerSession({ graceMs: 100, drainMs: 1_000 });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env, session);
  let settled = false;
  const build = docker(["buildx", "build", "-t", "x", "."]).finally(() => { settled = true; });
  const rejected = assert.rejects(build, Interrupted);
  rejected.catch(() => {});
  await waitFor(() => existsSync(fake.env.FAKE_DOCKER_LOG) && loggedPids(fake, "buildPid").length > 0, "the docker leader");
  const [pid] = loggedPids(fake, "buildPid");
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  }, "the docker leader to exit");
  const kill = t.mock.method(process, "kill", () => true);
  assert.equal(settled, false);
  session.interrupt("SIGTERM");
  await rejected;
  assert.deepEqual(kill.mock.calls.map(({ arguments: args }) => args).filter(([target]) => target === -pid), []);
});

test("output cut off by the drain never counts as a healthy probe or a confirmed removal", async () => {
  assert.deepEqual(probeVerdict({ status: 0, stdout: "200\n", stderr: "", incomplete: true }), { healthy: false, last: "the probe output was cut off" });
  const calls = [];
  const stub = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return { status: 0, stdout: "0123456789abcdef0123\n", stderr: "", incomplete: true };
    return { status: 0, stdout: "", stderr: "", incomplete: true };
  };
  const resources = new RunResources(stub);
  resources.owners.add("conclave-check-images.owner=aaaaaaaaaaaaaaaaaaaaaaaa");
  resources.claimImage("conclave-check-images/x:run");
  await resources.removeAll();
  assert.deepEqual(resources.leftovers(), ["containers labelled conclave-check-images.owner=aaaaaaaaaaaaaaaaaaaaaaaa", "conclave-check-images/x:run"]);
  assert.deepEqual(calls, ["ps -a -q --no-trunc --filter label=conclave-check-images.owner=aaaaaaaaaaaaaaaaaaaaaaaa", "rmi conclave-check-images/x:run", "image ls -q --filter reference=conclave-check-images/x:run"]);
});
