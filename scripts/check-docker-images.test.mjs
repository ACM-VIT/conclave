import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { repoRoot } from "./check-docker-context.mjs";
import { RunResources, assertLocalBuilder, browserSocketSource, localSocket, pinnedDocker, pinnedEnv, resolveDockerEndpoint, startContainer } from "./check-docker-images.mjs";

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
  fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ id: "0123456789abcdef0123", labels }) + "\\n");
  process.stdout.write("0123456789abcdef0123\\n");
  if (process.env.FAKE_DOCKER_CREATE_HANG) {
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ received: signal }) + "\\n"); process.exit(1); });
    setInterval(() => {}, 1000);
  }
} else if (args[0] === "ps" && process.env.FAKE_DOCKER_FAIL_ONCE?.split(",").includes("ps") && !fs.existsSync(process.env.FAKE_DOCKER_STATE + ".ps-failed")) {
  fs.writeFileSync(process.env.FAKE_DOCKER_STATE + ".ps-failed", "");
  process.stderr.write("Cannot connect to the Docker daemon\\n");
  process.exit(1);
} else if (args[0] === "rm" && process.env.FAKE_DOCKER_FAIL_ONCE?.split(",").includes("rm") && !fs.existsSync(process.env.FAKE_DOCKER_STATE + ".rm-failed")) {
  fs.writeFileSync(process.env.FAKE_DOCKER_STATE + ".rm-failed", "");
  process.stderr.write("Error response from daemon: removal already in progress\\n");
  process.exit(1);
} else if (args[0] === "rm") {
  fs.appendFileSync(process.env.FAKE_DOCKER_STATE, JSON.stringify({ removed: args[2] }) + "\\n");
} else if (args[0] === "rmi") {
  const state = fs.existsSync(process.env.FAKE_DOCKER_STATE) ? fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const removed = new Set(state.filter((entry) => entry.removed).map((entry) => entry.removed));
  if (state.some((entry) => entry.id && !removed.has(entry.id))) { process.stderr.write("conflict: unable to remove repository reference (must force) - container is using its referenced image\\n"); process.exit(1); }
} else if (args[0] === "ps") {
  const filter = args[args.indexOf("--filter") + 1].replace(/^label=/, "");
  const state = fs.existsSync(process.env.FAKE_DOCKER_STATE) ? fs.readFileSync(process.env.FAKE_DOCKER_STATE, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const removed = new Set(state.filter((entry) => entry.removed).map((entry) => entry.removed));
  for (const container of state) if (container.id && !removed.has(container.id) && container.labels.includes(filter)) process.stdout.write(container.id + "\\n");
}
else if (args[0] === "start" && process.env.FAKE_DOCKER_START_FAIL) { process.stderr.write("failed to create task for container: exec: \\"bad\\": executable file not found\\n"); process.exit(1); }
else if (args[0] === "buildx" && args[1] === "build" && process.env.FAKE_DOCKER_BUILD_HANG && !fs.existsSync(process.env.FAKE_DOCKER_BUILD_HANG)) {
  fs.writeFileSync(process.env.FAKE_DOCKER_BUILD_HANG, "");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ received: signal }) + "\\n"); process.exit(1); });
  setInterval(() => {}, 1000);
} else if (args[0] === "buildx" && args[1] === "build" && process.env.FAKE_DOCKER_BUILD_FAIL && args[args.indexOf("-t") + 1].includes(process.env.FAKE_DOCKER_BUILD_FAIL)) { process.stderr.write("build failed\\n"); process.exit(1); }
else if (args[0] === "exec" && process.env.FAKE_DOCKER_HEALTHY) process.stdout.write("200\\n");
else if (args[0] === "inspect") process.stdout.write("true\\n");
else if (args[0] === "info") process.stdout.write((process.env.FAKE_DOCKER_INFO ?? JSON.stringify({ OperatingSystem: "OrbStack", Name: "orbstack" })) + "\\n");
`;

function fakeDocker(t, { contexts = {}, current = "default", ...extra } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-docker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  assert.deepEqual(after, [`rmi ${tag}`]);
}

test("SIGINT to the process group during an image build stops the run before any later step and removes the tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_BUILD_HANG: path.join(fake.dir, "hang") }, { detached: true });
  await waitFor(() => fake.calls().some((call) => isBuild(call.args)), "the first build");
  await sleep(200);
  process.kill(-child.pid, "SIGINT");
  const { code, stderr } = await exited;
  assert.equal(code, 130, stderr);
  assertStoppedDuringFirstBuild(fake.calls().map((call) => call.args));
});

test("SIGTERM to the script during an image build is forwarded to docker, stops the run and removes the tag", { timeout: 30_000 }, async (t) => {
  const fake = fakeDocker(t, { contexts: { default: "unix:///run/fake-docker.sock" } });
  const { child, exited } = runScript(t, { ...fake.env, FAKE_DOCKER_BUILD_HANG: path.join(fake.dir, "hang") });
  await waitFor(() => fake.calls().some((call) => isBuild(call.args)), "the first build");
  await sleep(200);
  child.kill("SIGTERM");
  const { code, stderr } = await exited;
  assert.equal(code, 143, stderr);
  assert.deepEqual(fake.received(), ["SIGTERM"]);
  assertStoppedDuringFirstBuild(fake.calls().map((call) => call.args));
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
  assert.deepEqual(calls.slice(failed + 1).map((args) => args.slice(2).join(" ")), [`rmi ${tags[1]}`]);
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
    await startContainer(docker, resources, { name: "conclave-check-images-x", tag, env: {}, mounts: [] });
    await resources.removeAll();
    assert.equal(resources.owners.size, 1, failing);
    assert.deepEqual([...resources.images], [tag], failing);
    await resources.removeAll();
    assert.equal(resources.owners.size, 0, failing);
    assert.deepEqual([...resources.images], [], failing);
    const calls = fake.calls().map((call) => call.args.slice(2, 4).join(" "));
    assert.deepEqual(calls.slice(2), failing === "ps" ? ["ps -a", "rmi " + tag, "ps -a", "rm -f", "rmi " + tag] : ["ps -a", "rm -f", "rmi " + tag, "ps -a", "rm -f", "rmi " + tag], failing);
  }
});
