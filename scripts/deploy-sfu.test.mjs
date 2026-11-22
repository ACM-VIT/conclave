import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// Every drain and recreate across the fake SFUs, in the order they happened.
const events = [];

// container: "running" for an hour, "exited", "crash-looping" (restarted
// seconds ago) or "hung" (running for an hour). Only "running" answers HTTP
// until a recreate. replacementHealthy: false for a build whose containers
// never report healthy. onTarget: already runs the target image with the
// current compose config.
const startSfu = async (
  instanceId,
  { rooms = 0, statusAnswers = true, container = "running", replacementHealthy = true, draining = false, onTarget = false } = {},
) => {
  const sfu = {
    instanceId,
    rooms,
    draining,
    statusAnswers,
    container,
    healthy: true,
    image: onTarget ? "sha256:target" : "sha256:running",
    configHash: onTarget ? "current-hash" : "older-hash",
    drains: [],
    recreates: [],
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://sfu");
    const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/stand-in/state") {
      const startedAt = new Date(Date.now() - (sfu.container === "crash-looping" ? 3_000 : 3_600_000)).toISOString();
      return json({ status: sfu.container === "exited" ? "exited" : "running", startedAt, image: sfu.image, configHash: sfu.configHash });
    }
    if (sfu.container !== "running" && !url.pathname.startsWith("/stand-in/")) return req.socket.destroy();
    if (url.pathname === "/health") return sfu.healthy ? json({ status: "healthy" }) : json({ status: "starting" }, 503);
    if (url.pathname === "/status") {
      if (!sfu.statusAnswers) return json({ error: "unavailable" }, 503);
      return json({ instanceId, region: "local", healthy: true, rooms: sfu.rooms, draining: sfu.draining });
    }
    if (url.pathname === "/drain" && req.method === "POST") {
      const request = JSON.parse(body || "{}");
      sfu.drains.push(request);
      events.push(`drain ${instanceId}`);
      sfu.draining = request.draining === true;
      // A forced drain ends the instance's rooms after the notice.
      if (request.force) sfu.rooms = 0;
      return json({ draining: sfu.draining, forced: request.force === true });
    }
    if (url.pathname === "/stand-in/recreate") {
      sfu.recreates.push({ roomsCut: sfu.rooms });
      events.push(`recreate ${instanceId}`);
      sfu.rooms = 0;
      sfu.container = "running";
      sfu.healthy = replacementHealthy;
      sfu.draining = url.searchParams.get("draining") === "true";
      sfu.image = url.searchParams.get("image");
      sfu.configHash = "current-hash";
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
// docker tag, kept per run: a recreated container gets the image tagged for it.
const tagsFile = process.env.DEPLOY_TEST_DOCKER_LOG + ".tags";
const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, "utf8")) : {};
const state = async (name) => (await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/state")).json();
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
    // As the compose file passes them: a budget of 4, and a worker count
    // only when the env sets one.
    SFU_WEBRTC_PORT_BUDGET: "4",
    SFU_WORKER_HOST_INSTANCES: "2",
    ...(process.env.SFU_WORKER_COUNT ? { SFU_WORKER_COUNT: process.env.SFU_WORKER_COUNT } : {}),
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
      const image = tags["vm-" + name] || "sha256:target";
      await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/recreate?draining=" + draining + "&image=" + image);
      return;
    }
    return;
  }
  if (args[0] === "inspect") {
    const format = args[2];
    const name = args.at(-1).replace(/^ctr-/, "");
    if (format.includes(".State.Status")) {
      const current = await state(name);
      return out(format.includes(".State.StartedAt") ? current.status + " " + current.startedAt : current.status);
    }
    if (format.includes("config-hash")) return out((await state(name)).configHash);
    if (format.includes(".Image")) return out((await state(name)).image);
    return out(args.at(-1));
  }
  if (args[0] === "image" && args[1] === "inspect") return args[2] === "-f" ? out(tags[args.at(-1)] || "sha256:target") : undefined;
  if (args[0] === "tag") {
    tags[args[2]] = tags[args[1]] || args[1];
    return fs.writeFileSync(tagsFile, JSON.stringify(tags));
  }
  // rmi and the canary's docker run succeed.
};
main();
`;

// upstream: files the next commit on origin changes, so the checkout is one
// pull behind the revision it will deploy.
const deploy = async (sfus, { args: extraArgs = [], env: extraEnv = {}, envLines = [], upstream } = {}) => {
  // On macOS this path sits behind the /var symlink, so the preflight also
  // runs through one.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-deploy-"));
  try {
    const src = path.join(root, "src");
    await mkdir(path.join(src, "scripts"), { recursive: true });
    await copyFile(path.join(scripts, "deploy-sfu.sh"), path.join(src, "scripts", "deploy-sfu.sh"));
    await copyFile(path.join(scripts, "deploy-sfu-preflight.mjs"), path.join(src, "scripts", "deploy-sfu-preflight.mjs"));
    // The preflight shares the SFU's own worker and port rules.
    await mkdir(path.join(src, "packages", "sfu", "config"), { recursive: true });
    await copyFile(
      path.join(scripts, "..", "packages", "sfu", "config", "workerSettings.mjs"),
      path.join(src, "packages", "sfu", "config", "workerSettings.mjs"),
    );
    await copyFile(path.join(scripts, "..", "docker-compose.sfu.yml"), path.join(src, "docker-compose.sfu.yml"));
    const git = (...args) => run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
    await git("-C", src, "init", "-q");
    await git("-C", src, "add", ".");
    await git("-C", src, "commit", "-qm", "deploy test");
    await git("clone", "-q", "--bare", src, path.join(root, "origin.git"));
    const vm = path.join(root, "vm");
    await git("clone", "-q", path.join(root, "origin.git"), vm);
    if (upstream) {
      for (const [file, content] of Object.entries(upstream)) await writeFile(path.join(src, file), content);
      await git("-C", src, "commit", "-qam", "the revision to deploy");
      await git("-C", src, "push", "-q", path.join(root, "origin.git"), "HEAD");
    }
    await writeFile(
      path.join(vm, ".env"),
      [
        `SFU_SECRET=${secret}`,
        "REDIS_URL=redis://127.0.0.1:6379/0",
        ...Object.entries(sfus).flatMap(([name, sfu]) => [
          `SFU_${name.at(-1).toUpperCase()}_URL=http://127.0.0.1:${sfu.port}`,
          `SFU_${name.at(-1).toUpperCase()}_PUBLIC_URL=http://127.0.0.1:${sfu.port}`,
        ]),
        ...envLines,
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
      ...extraEnv,
    };
    const result = await run("bash", [path.join(vm, "scripts", "deploy-sfu.sh"), ...extraArgs], { env }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` }),
    );
    const docker = (await readFile(dockerLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, docker, order: result.output.match(/^Deploy order: (.*)$/m)?.[1] };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const withSfus = async (specs, body) => {
  const sfus = {};
  events.length = 0;
  try {
    for (const [name, spec] of Object.entries(specs)) sfus[name] = await startSfu(name, spec);
    await body(sfus);
  } finally {
    await Promise.all(Object.values(sfus).map((sfu) => sfu.close()));
  }
};

const passedPreflight = (result) => assert.match(result.output, /SFU deployment preflight passed/, result.output);

const cutRooms = (sfus) => Object.values(sfus).flatMap((sfu) => sfu.recreates.map((r) => r.roomsCut));

test("with calls on both instances, the deploy rebuilds neither while those calls run", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus);
    passedPreflight(result);
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
    passedPreflight(result);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.equal(sfus["sfu-b"].recreates.length, 2, "canary build, then the serving container");
    assert.equal(sfus["sfu-a"].recreates.length, 0);
    assert.deepEqual(cutRooms(sfus), [0, 0]);
  });
});

test("an instance whose status cannot be read is neither taken for the idle one nor drained against", async () => {
  await withSfus({ "sfu-a": { rooms: 2, statusAnswers: false }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.match(result.output, /Not draining sfu-b: sfu-a's \/status cannot be read/);
    assert.deepEqual(events, [], "unknown is unsafe: nothing is drained or rebuilt");
  });
});

test("--force-drain is the one way to rebuild instances that carry calls", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const result = await deploy(sfus, { args: ["--force-drain"] });
    assert.equal(result.code, 0, result.output);
    for (const sfu of Object.values(sfus)) {
      assert.equal(sfu.drains[0].force, true);
      assert.equal(sfu.recreates.length, 2);
    }
    assert.deepEqual(cutRooms(sfus), [0, 0, 0, 0], "each instance is recreated only after its forced drain");
  });
});

test("a replacement that never reports healthy stops the deploy before the other instance is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { replacementHealthy: false } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 4, result.output);
    assert.match(result.output, /sfu-b did not report healthy/);
    assert.equal(sfus["sfu-a"].drains.length, 0, "the healthy instance keeps serving");
  });
});

test("an instance that is down is brought up before a healthy one is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "exited" } }, async (sfus) => {
    const result = await deploy(sfus);
    passedPreflight(result);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.deepEqual(events, ["recreate sfu-b", "recreate sfu-b", "drain sfu-a", "drain sfu-a"]);
    assert.deepEqual(cutRooms(sfus), [0, 0]);
  });
});

test("an instance that is down and whose replacement fails leaves the healthy one undrained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "exited", replacementHealthy: false } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 4, result.output);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("no instance is drained while another is down, even one outside the deploy", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { container: "exited" } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Not draining sfu-a: sfu-b does not report healthy/);
    assert.deepEqual(events, []);
  });
});

test("a public URL that does not reach the new instance stops the deploy before the next drain", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // sfu-b's public route lands on sfu-a, as a misrouted proxy would.
    const result = await deploy(sfus, { envLines: [`SFU_B_PUBLIC_URL=http://127.0.0.1:${sfus["sfu-a"].port}`] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Public URL for sfu-b reaches instance 'sfu-a' instead/);
    assert.equal(sfus["sfu-b"].recreates.length, 2);
    assert.equal(sfus["sfu-a"].drains.length, 0, "no drain may follow an unreachable replacement");
  });
});

test("the revision being deployed checks its own config before anything is built", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // The next revision's preflight knows a limit the checkout's does not:
    // the checkout allows 3 workers within its budget of 4, the next allows 2.
    const newerPreflight = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
for (const [name, service] of Object.entries(JSON.parse(raw).services)) {
  if (Number(service.environment.SFU_WORKER_COUNT) > 2) {
    console.error(name + ": SFU_WORKER_COUNT " + service.environment.SFU_WORKER_COUNT + " is above this revision's limit of 2.");
    process.exit(1);
  }
}
console.log("SFU deployment preflight passed (newer rules).");
`;
    const result = await deploy(sfus, {
      envLines: ["SFU_WORKER_COUNT=3"],
      upstream: { "scripts/deploy-sfu-preflight.mjs": newerPreflight },
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SFU_WORKER_COUNT 3 is above this revision's limit of 2/);
    const changes = result.docker.filter((args) => ["build", "up", "run", "tag", "stop"].some((verb) => args.includes(verb)));
    assert.deepEqual(changes, [], "nothing may be built or changed after the preflight fails");
    assert.deepEqual(events, []);
  });
});

test("a crash-looping instance is repaired first, before the healthy one is drained", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { container: "crash-looping" } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 3, result.output);
    assert.equal(result.order, "sfu-b sfu-a");
    assert.deepEqual(events, ["recreate sfu-b", "recreate sfu-b", "drain sfu-a", "drain sfu-a"]);
  });
});

test("an instance that has run for an hour but stays silent is left alone", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { container: "hung" } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-b's container is running but nothing answers/);
    assert.deepEqual(events, []);
  });
});

test("a preflight that reports nothing stops the deploy before anything is built", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // It reads the compose JSON, then exits 0 without a verdict.
    const silent = "for await (const chunk of process.stdin) void chunk;\nprocess.exit(0);\n";
    const result = await deploy(sfus, { upstream: { "scripts/deploy-sfu-preflight.mjs": silent } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SFU deployment preflight reported no result/);
    const changes = result.docker.filter((args) => ["build", "up", "run", "tag", "stop"].some((verb) => args.includes(verb)));
    assert.deepEqual(changes, []);
  });
});

test("a peer left draining whose status cannot be read is not drained against", async () => {
  await withSfus({ "sfu-a": { draining: true, statusAnswers: false }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 1, result.output);
    assert.equal(sfus["sfu-b"].drains.length, 0, "sfu-b is the only instance still taking meetings");
  });
});
