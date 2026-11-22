import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

// Runs the real deploy-sfu.sh against two fake SFUs (HTTP servers that report
// rooms and take drains) and a stand-in docker CLI. A recreate replaces the
// instance's container, so any rooms it still had are cut; the stand-in asks
// the fake SFU how many that was.

const run = promisify(execFile);
const scripts = import.meta.dirname;
const secret = "deploy-test-secret";

const startSfu = async (instanceId, { rooms = 0, statusAnswers = true } = {}) => {
  const sfu = { instanceId, rooms, draining: false, statusAnswers, drains: [], recreates: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://sfu");
    const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/health") return json({ status: "healthy" });
    if (url.pathname === "/status") {
      if (!sfu.statusAnswers) return json({ error: "unavailable" }, 503);
      return json({ instanceId, region: "local", healthy: true, rooms: sfu.rooms, draining: sfu.draining });
    }
    if (url.pathname === "/drain" && req.method === "POST") {
      const request = JSON.parse(body || "{}");
      sfu.drains.push(request);
      sfu.draining = request.draining === true;
      // A forced drain ends the instance's rooms after the notice.
      if (request.force) sfu.rooms = 0;
      return json({ draining: sfu.draining, forced: request.force === true });
    }
    if (url.pathname === "/stand-in/recreate") {
      sfu.recreates.push({ roomsCut: sfu.rooms });
      sfu.rooms = 0;
      sfu.draining = url.searchParams.get("draining") === "true";
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  sfu.port = server.address().port;
  sfu.close = () => new Promise((done) => server.close(done));
  return sfu;
};

const dockerStandIn = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const sfus = JSON.parse(process.env.DEPLOY_TEST_SFUS);
fs.appendFileSync(process.env.DEPLOY_TEST_DOCKER_LOG, JSON.stringify(args) + "\\n");
const out = (text) => process.stdout.write(text + "\\n");
const service = (name, sfu, index) => ({
  environment: {
    ANNOUNCED_IP: "127.0.0.1",
    RTC_MIN_PORT: String(40000 + index * 1000),
    RTC_MAX_PORT: String(40999 + index * 1000),
    SFU_INSTANCE_ID: name,
    SFU_PORT: String(sfu.port),
    SFU_PUBLIC_URL: "http://127.0.0.1:" + sfu.port,
    SFU_REDIS_URL: "redis://127.0.0.1:6379/0",
    SFU_REGION: "local",
    SFU_REQUIRE_REDIS_ADAPTER: "1",
    SFU_SECRET: process.env.SFU_SECRET,
  },
});
const main = async () => {
  if (args[0] === "compose") {
    const rest = args.slice(1).filter((arg, i, all) => !["--env-file", "-f"].includes(arg) && !["--env-file", "-f"].includes(all[i - 1]));
    const names = Object.keys(sfus);
    if (rest[0] === "config" && rest[1] === "--services") return out(names.join("\\n"));
    if (rest[0] === "config" && rest[1] === "--format") {
      return out(JSON.stringify({ name: "vm", services: Object.fromEntries(names.map((n, i) => [n, service(n, sfus[n], i)])) }));
    }
    if (rest[0] === "config" && rest[1] === "--hash") return out(rest[2] + " current-hash");
    if (rest[0] === "ps") return out("ctr-" + rest.at(-1));
    if (rest[0] === "up") {
      const name = rest.at(-1);
      const draining = process.env.SFU_START_DRAINING === "true";
      await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/recreate?draining=" + draining);
      return;
    }
    return;
  }
  if (args[0] === "inspect") {
    const format = args[2];
    if (format.includes(".State.Status")) return out("running");
    if (format.includes("config-hash")) return out("older-hash");
    if (format.includes(".Image")) return out("sha256:running");
    return out(args.at(-1));
  }
  if (args[0] === "image" && args[1] === "inspect") return args[2] === "-f" ? out("sha256:target") : undefined;
  // tag, rmi and the canary's docker run all succeed.
};
main();
`;

const deploy = async (sfus, extraArgs = []) => {
  // The real path: the preflight only runs when its own path has no symlink
  // in it, and macOS temp dirs sit behind one.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "conclave-deploy-")));
  try {
    const src = path.join(root, "src");
    await mkdir(path.join(src, "scripts"), { recursive: true });
    await copyFile(path.join(scripts, "deploy-sfu.sh"), path.join(src, "scripts", "deploy-sfu.sh"));
    await copyFile(path.join(scripts, "deploy-sfu-preflight.mjs"), path.join(src, "scripts", "deploy-sfu-preflight.mjs"));
    await copyFile(path.join(scripts, "..", "docker-compose.sfu.yml"), path.join(src, "docker-compose.sfu.yml"));
    const git = (...args) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
    await git("-C", src, "init", "-q");
    await git("-C", src, "add", ".");
    await git("-C", src, "commit", "-qm", "deploy test");
    await git("clone", "-q", "--bare", src, path.join(root, "origin.git"));
    const vm = path.join(root, "vm");
    await git("clone", "-q", path.join(root, "origin.git"), vm);
    await writeFile(
      path.join(vm, ".env"),
      [
        `SFU_SECRET=${secret}`,
        "REDIS_URL=redis://127.0.0.1:6379/0",
        ...Object.entries(sfus).map(([name, sfu]) => `SFU_${name.at(-1).toUpperCase()}_URL=http://127.0.0.1:${sfu.port}`),
      ].join("\n"),
    );
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "docker"), dockerStandIn);
    await chmod(path.join(bin, "docker"), 0o755);
    const dockerLog = path.join(root, "docker.log");
    await writeFile(dockerLog, "");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOY_TEST_SFUS: JSON.stringify(Object.fromEntries(Object.entries(sfus).map(([n, s]) => [n, { port: s.port }]))),
      DEPLOY_TEST_DOCKER_LOG: dockerLog,
      SFU_DEPLOY_STATE_DIR: path.join(root, "state"),
      DRAIN_TIMEOUT_SECONDS: "2",
      DRAIN_POLL_SECONDS: "0.2",
      PLACEMENT_SETTLE_SECONDS: "0",
      HEALTH_TIMEOUT_SECONDS: "5",
    };
    const result = await run("bash", [path.join(vm, "scripts", "deploy-sfu.sh"), ...extraArgs], { env }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` }),
    );
    assert.match(result.output, /SFU deployment preflight passed/, result.output);
    return { ...result, order: result.output.match(/^Deploy order: (.*)$/m)?.[1] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const withSfus = async (specs, body) => {
  const sfus = {};
  try {
    for (const [name, spec] of Object.entries(specs)) sfus[name] = await startSfu(name, spec);
    await body(sfus);
  } finally {
    await Promise.all(Object.values(sfus).map((sfu) => sfu.close()));
  }
};

const cutRooms = (sfus) => Object.values(sfus).flatMap((sfu) => sfu.recreates.map((r) => r.roomsCut));

test("with calls on both instances, the deploy rebuilds neither while those calls run", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a", "the instance with fewer calls goes first");
    assert.deepEqual(cutRooms(sfus), [], "no instance may be recreated while it has calls");
    assert.equal(sfus["sfu-b"].draining, false, "the waited-on instance goes back into service");
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("an idle instance is rebuilt first, and the one carrying calls is not touched", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.equal(sfus["sfu-b"].recreates.length, 2, "canary build, then the serving container");
    assert.equal(sfus["sfu-a"].recreates.length, 0);
    assert.deepEqual(cutRooms(sfus), [0, 0]);
  });
});

test("an instance whose rooms cannot be read is never taken for the idle one", async () => {
  await withSfus({ "sfu-a": { rooms: 2, statusAnswers: false }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.equal(sfus["sfu-b"].recreates.length, 2, "the idle instance is still deployed");
    assert.equal(sfus["sfu-a"].recreates.length, 0);
    assert.match(result.output, /sfu-a answers but its \/status cannot be read/);
  });
});

test("--force-drain is the one way to rebuild instances that carry calls", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, ["--force-drain"]);
    assert.equal(result.code, 0, result.output);
    for (const sfu of Object.values(sfus)) {
      assert.equal(sfu.drains[0].force, true);
      assert.equal(sfu.recreates.length, 2);
    }
    assert.deepEqual(cutRooms(sfus), [0, 0, 0, 0], "each instance is recreated only after its forced drain");
  });
});
