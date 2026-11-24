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
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify({ args: process.argv.slice(2), DOCKER_HOST: process.env.DOCKER_HOST ?? null, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? null, BUILDX_BUILDER: process.env.BUILDX_BUILDER ?? null }) + "\\n");
const contexts = JSON.parse(process.env.FAKE_DOCKER_CONTEXTS ?? "{}");
const args = process.argv[2] === "--host" ? process.argv.slice(4) : process.argv.slice(2);
if (args[0] === "context" && args[1] === "show") process.stdout.write((process.env.FAKE_DOCKER_CURRENT ?? "default") + "\\n");
else if (args[0] === "context" && args[1] === "inspect") {
  if (!(args[2] in contexts)) { process.stderr.write("context not found\\n"); process.exit(1); }
  process.stdout.write(contexts[args[2]] + "\\n");
} else if (args[0] === "buildx" && args[1] === "inspect") process.stdout.write(process.env.FAKE_DOCKER_BUILDER ?? "Name: default\\nDriver: docker\\n\\nNodes:\\nName: default\\nEndpoint: default\\nStatus: running\\n");
else if (args[0] === "run" && process.env.FAKE_DOCKER_RUN_CONFLICT) { process.stderr.write("Conflict. The container name is already in use by container \\"0ther0ther0ther0\\".\\n"); process.exit(125); }
else if (args[0] === "run") process.stdout.write("0123456789abcdef0123\\n");
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
    FAKE_DOCKER_CONTEXTS: JSON.stringify(contexts),
    FAKE_DOCKER_CURRENT: current,
    ...extra,
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { env, calls };
}

test("DOCKER_HOST wins over DOCKER_CONTEXT without asking docker", (t) => {
  const fake = fakeDocker(t, { contexts: { remote: "tcp://203.0.113.1:2376" } });
  assert.equal(resolveDockerEndpoint({ ...fake.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "remote" }), "unix:///var/run/docker.sock");
  assert.deepEqual(fake.calls(), []);
});

test("DOCKER_CONTEXT, then the current context, decide the endpoint when DOCKER_HOST is unset", (t) => {
  const fake = fakeDocker(t, { current: "rootless", contexts: { remote: "tcp://203.0.113.1:2376", rootless: "unix:///run/user/1000/docker.sock" } });
  assert.equal(resolveDockerEndpoint({ ...fake.env, DOCKER_CONTEXT: "remote" }), "tcp://203.0.113.1:2376");
  assert.equal(resolveDockerEndpoint(fake.env), "unix:///run/user/1000/docker.sock");
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

test("every docker call after the check is pinned to the checked endpoint", (t) => {
  const fake = fakeDocker(t);
  const docker = pinnedDocker({ host: "unix:///run/user/1000/docker.sock" }, { ...fake.env, DOCKER_HOST: "unix:///elsewhere.sock", DOCKER_CONTEXT: "remote", BUILDX_BUILDER: "olympus-ec2" });
  docker(["build", "."]);
  docker(["run", "-d", "x"]);
  assert.deepEqual(fake.calls(), [
    { args: ["--host", "unix:///run/user/1000/docker.sock", "build", "."], DOCKER_HOST: null, DOCKER_CONTEXT: null, BUILDX_BUILDER: null },
    { args: ["--host", "unix:///run/user/1000/docker.sock", "run", "-d", "x"], DOCKER_HOST: null, DOCKER_CONTEXT: null, BUILDX_BUILDER: null },
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

test("the shared browser mounts the daemon-side socket: the VM path for VM daemons, the resolved path for a native Linux engine", (t) => {
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
    assert.equal(browserSocketSource(docker, { socket, env: fake.env, platform }), expected, name);
    assert.deepEqual(fake.calls().map((call) => call.args.slice(2)), [["info", "--format", "{{json .}}"]], name);
  }
});

test("BROWSER_DOCKER_SOCKET overrides the mount source without asking docker", (t) => {
  const fake = fakeDocker(t);
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  assert.equal(browserSocketSource(docker, { socket: "/var/run/docker.sock", env: { ...fake.env, BROWSER_DOCKER_SOCKET: "/srv/docker.sock" }, platform: "linux" }), "/srv/docker.sock");
  assert.deepEqual(fake.calls(), []);
});

test("the child environment carries no DOCKER_ or BUILDX_ selector", () => {
  const clean = pinnedEnv({ PATH: "/bin", HOME: "/home/x", DOCKER_HOST: "a", DOCKER_CONTEXT: "b", DOCKER_CONFIG: "c", BUILDX_BUILDER: "olympus-ec2", BUILDX_CONFIG: "d", BROWSER_DOCKER_SOCKET: "/s" });
  assert.deepEqual(clean, { PATH: "/bin", HOME: "/home/x", BROWSER_DOCKER_SOCKET: "/s" });
});

test("only the docker driver on the checked endpoint is accepted as the builder", (t) => {
  const local = fakeDocker(t);
  assert.equal(assertLocalBuilder(pinnedDocker({ host: "unix:///var/run/docker.sock" }, local.env)), "default");
  assert.deepEqual(local.calls().map((call) => call.args.slice(2)), [["buildx", "inspect", "default"]]);
  for (const [name, text] of [
    ["container driver", "Name: default\nDriver: docker-container\n\nNodes:\nName: default0\nEndpoint: unix:///var/run/docker.sock\n"],
    ["remote driver", "Name: default\nDriver: remote\n\nNodes:\nName: default0\nEndpoint: tcp://203.0.113.1:1234\n"],
    ["ssh endpoint", "Name: default\nDriver: docker\n\nNodes:\nName: olympus-ec2\nEndpoint: olympus-ec2\n"],
  ]) {
    const fake = fakeDocker(t, { FAKE_DOCKER_BUILDER: text });
    assert.throws(() => assertLocalBuilder(pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env)), /refusing to build: buildx builder "default"/, name);
  }
});

test("a container name conflict removes nothing, because containers are only removed by the id docker run returned", async (t) => {
  const fake = fakeDocker(t, { FAKE_DOCKER_RUN_CONFLICT: "1" });
  const docker = pinnedDocker({ host: "unix:///var/run/docker.sock" }, fake.env);
  const resources = new RunResources(docker);
  await assert.rejects(startContainer(docker, resources, { name: "conclave-check-images-taken", tag: "t", env: {}, mounts: [] }), /docker run failed: Conflict/);
  resources.removeAll();
  assert.deepEqual(fake.calls().map((call) => call.args[2]), ["run"]);
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
