import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathWithout, provideFlock } from "./test-support/host-tools.mjs";

// Runs the real deploy-sfu.sh against two fake SFUs (HTTP servers that report
// rooms and take drains) and a stand-in docker CLI. A recreate replaces the
// instance's container, so any rooms it still had are cut; the stand-in asks
// the fake SFU how many that was.

const run = promisify(execFile);
const scripts = import.meta.dirname;
const secret = "deploy-test-secret";

// Every drain and recreate across the fake SFUs, in the order they happened.
const events = [];
// Called before a fake SFU applies a drain, so a test can line two up.
let beforeDrain = null;

// container: "running" for an hour, "exited", "crash-looping" (Docker keeps
// restarting it), "hung" (running for an hour) or "young" (running for a few
// seconds). Only "running" answers HTTP until a recreate. failRecreate: the
// recreate (1st, 2nd...) at which compose fails after stopping the old
// container. replacementHealthy: false for a build whose containers
// never report healthy. bootExit: "exited" or "crash-looping", the state a
// container of the target image ends in right after it starts; the previous
// image still boots. stateInspectFails: docker inspect of the container's
// state fails. onTarget: already runs the target image with the current
// compose config.
const startSfu = async (
  instanceId,
  {
    rooms = 0,
    statusAnswers = true,
    container = "running",
    replacementHealthy = true,
    bootExit = null,
    stateInspectFails = false,
    draining = false,
    onTarget = false,
    failRecreate = 0,
  } = {},
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
    restartCount: 0,
    bootDrained: false,
    failRecreate,
    drains: [],
    recreates: [],
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://sfu");
    const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/stand-in/state") {
      const startedAt = new Date(Date.now() - (["crash-looping", "young"].includes(sfu.container) ? 3_000 : 3_600_000)).toISOString();
      if (sfu.container === "crash-looping") sfu.restartCount += 1;
      const status = { exited: "exited", "crash-looping": "restarting" }[sfu.container] ?? "running";
      return json({
        status,
        startedAt,
        restartCount: sfu.restartCount,
        bootDrained: sfu.bootDrained,
        image: sfu.image,
        configHash: sfu.configHash,
        stateInspectFails,
      });
    }
    if (sfu.container !== "running" && !url.pathname.startsWith("/stand-in/")) return req.socket.destroy();
    if (url.pathname === "/health") return sfu.healthy ? json({ status: "healthy" }) : json({ status: "starting" }, 503);
    if (url.pathname === "/status") {
      if (!sfu.statusAnswers) return json({ error: "unavailable" }, 503);
      return json({ instanceId, region: "local", healthy: true, rooms: sfu.rooms, draining: sfu.draining });
    }
    if (url.pathname === "/drain" && req.method === "POST") {
      const request = JSON.parse(body || "{}");
      if (request.draining && beforeDrain) await beforeDrain();
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
      if (sfu.failRecreate === sfu.recreates.length) {
        sfu.container = "exited";
        return json({ error: "compose failed after stopping the old container" }, 500);
      }
      sfu.container = "running";
      sfu.bootDrained = url.searchParams.get("draining") === "true";
      sfu.healthy = replacementHealthy;
      sfu.draining = url.searchParams.get("draining") === "true";
      sfu.image = url.searchParams.get("image");
      sfu.configHash = "current-hash";
      if (bootExit && sfu.image === "sha256:target") sfu.container = bootExit;
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
// docker tag, kept per run unless DEPLOY_TEST_DOCKER_TAGS shares them across
// runs as one host would: a recreated container gets the image tagged for it.
const tagsFile = process.env.DEPLOY_TEST_DOCKER_TAGS || process.env.DEPLOY_TEST_DOCKER_LOG + ".tags";
const tags = fs.existsSync(tagsFile) ? JSON.parse(fs.readFileSync(tagsFile, "utf8")) : {};
const state = async (name) => (await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/state")).json();
const service = (name, sfu, index) => ({
  environment: {
    ANNOUNCED_IP: "127.0.0.1",
    // DEPLOY_TEST_OVERLAP gives both services one RTC range, which the full
    // preflight rejects.
    RTC_MIN_PORT: process.env.DEPLOY_TEST_OVERLAP ? "41001" : String(40000 + index * 1000),
    RTC_MAX_PORT: process.env.DEPLOY_TEST_OVERLAP ? "42000" : String(40999 + index * 1000),
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
    // A build retags the service's own image, as compose does.
    if (rest[0] === "build") {
      tags["vm-" + rest.at(-1)] = "sha256:checkout-build";
      return fs.writeFileSync(tagsFile, JSON.stringify(tags));
    }
    if (rest[0] === "up") {
      const name = rest.at(-1);
      const draining = process.env.SFU_START_DRAINING === "true";
      const image = tags["vm-" + name] || "sha256:target";
      const response = await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/recreate?draining=" + draining + "&image=" + image);
      if (!response.ok) process.exitCode = 1;
      // DEPLOY_TEST_KILL_AFTER_RECREATES: kill the deploy, as a crash or a
      // closed SSH session would, once that many recreates have run.
      const killAfter = Number(process.env.DEPLOY_TEST_KILL_AFTER_RECREATES || 0);
      if (killAfter) {
        const countFile = process.env.DEPLOY_TEST_DOCKER_LOG + ".recreates";
        const count = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
        fs.writeFileSync(countFile, String(count));
        if (count === killAfter) process.kill(process.ppid, "SIGKILL");
      }
      return;
    }
    return;
  }
  if (args[0] === "inspect") {
    const format = args[2];
    const name = args.at(-1).replace(/^ctr-/, "");
    if (format.includes(".Config.Env")) return out("SFU_DRAINING=" + (await state(name)).bootDrained);
    if (format.includes(".State.Status")) {
      const current = await state(name);
      if (current.stateInspectFails) {
        process.exitCode = 1;
        return;
      }
      if (format.includes(".RestartCount")) return out(current.status + ":" + current.restartCount);
      return out(format.includes(".State.StartedAt") ? current.status + " " + current.startedAt : current.status);
    }
    if (format.includes("config-hash")) return out((await state(name)).configHash);
    if (format.includes(".Image")) return out((await state(name)).image);
    return out(args.at(-1));
  }
  if (args[0] === "build") {
    tags[args[args.indexOf("-t") + 1]] = "sha256:canary-build";
    return fs.writeFileSync(tagsFile, JSON.stringify(tags));
  }
  // DEPLOY_TEST_NO_COMMIT_IMAGES: no image was ever tagged for a commit.
  if (
    args[0] === "image" &&
    args[1] === "inspect" &&
    process.env.DEPLOY_TEST_NO_COMMIT_IMAGES &&
    /:[0-9a-f]{12}$/.test(args.at(-1)) &&
    !(args.at(-1) in tags)
  ) {
    process.exitCode = 1;
    return;
  }
  if (args[0] === "image" && args[1] === "inspect") return args[2] === "-f" ? out(tags[args.at(-1)] || "sha256:target") : undefined;
  if (args[0] === "tag") {
    tags[args[2]] = tags[args[1]] || args[1];
    return fs.writeFileSync(tagsFile, JSON.stringify(tags));
  }
  // DEPLOY_TEST_NO_BUNDLE: images built before the canary bundle existed.
  if (args[0] === "run") {
    const image = args[args.indexOf("--entrypoint") + 2];
    if ((process.env.DEPLOY_TEST_NO_BUNDLE || "").split(",").includes(image)) {
      process.stderr.write("Error: Cannot find module '/app/packages/sfu/dist/canary-call.mjs'\\n");
      process.exitCode = 1;
    }
    return;
  }
  // rmi succeeds.
};
main();
`;

// upstream: files the next commit on origin changes, so the checkout is one
// pull behind the revision it will deploy.
// withoutFlock: run on a host whose PATH has no flock.
const deploy = async (sfus, { args: extraArgs = [], env: extraEnv = {}, envLines = [], upstream, powershell = false, withoutFlock = false } = {}) => {
  // On macOS this path sits behind the /var symlink, so the preflight also
  // runs through one.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-deploy-"));
  try {
    const src = path.join(root, "src");
    await mkdir(path.join(src, "scripts"), { recursive: true });
    await copyFile(path.join(scripts, "deploy-sfu.sh"), path.join(src, "scripts", "deploy-sfu.sh"));
    await copyFile(path.join(scripts, "deploy-sfu.ps1"), path.join(src, "scripts", "deploy-sfu.ps1"));
    await copyFile(path.join(scripts, "deploy-sfu-preflight.mjs"), path.join(src, "scripts", "deploy-sfu-preflight.mjs"));
    // The preflight shares the SFU's own worker and port rules.
    await mkdir(path.join(src, "packages", "sfu", "config"), { recursive: true });
    await copyFile(
      path.join(scripts, "..", "packages", "sfu", "config", "workerSettings.mjs"),
      path.join(src, "packages", "sfu", "config", "workerSettings.mjs"),
    );
    await copyFile(path.join(scripts, "..", "docker-compose.sfu.yml"), path.join(src, "docker-compose.sfu.yml"));
    // Fixed dates, so the same files make the same commit in every run, as a
    // rerun on the VM sees the same checkout.
    const git = (...args) =>
      run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
      });
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
    if (!withoutFlock) await provideFlock(bin);
    const hostPath = withoutFlock ? await pathWithout(path.join(root, "host-bin"), ["flock"]) : process.env.PATH;
    const dockerLog = path.join(root, "docker.log");
    await writeFile(dockerLog, "");
    const env = {
      ...process.env,
      PATH: `${bin}:${hostPath}`,
      DEPLOY_TEST_SFUS: JSON.stringify(Object.fromEntries(Object.entries(sfus).map(([n, s]) => [n, { port: s.port }]))),
      DEPLOY_TEST_DOCKER_LOG: dockerLog,
      SFU_DEPLOY_STATE_DIR: path.join(root, "state"),
      DRAIN_TIMEOUT_SECONDS: "2",
      DRAIN_POLL_SECONDS: "0.2",
      PLACEMENT_SETTLE_SECONDS: "0",
      HEALTH_TIMEOUT_SECONDS: "5",
      SFU_DEPLOY_LOCK_FILE: path.join(root, "deploy.lock"),
      ...extraEnv,
    };
    const command = powershell
      ? ["pwsh", ["-NoProfile", "-File", path.join(vm, "scripts", "deploy-sfu.ps1"), ...extraArgs]]
      : ["bash", [path.join(vm, "scripts", "deploy-sfu.sh"), ...extraArgs]];
    const result = await run(...command, { env }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` }),
    );
    const docker = (await readFile(dockerLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const tags = JSON.parse(await readFile(env.DEPLOY_TEST_DOCKER_TAGS || `${dockerLog}.tags`, "utf8").catch(() => "{}"));
    return { ...result, docker, tags, order: result.output.match(/^Deploy order: (.*)$/m)?.[1] };
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

for (const bootExit of ["exited", "crash-looping"]) {
  test(`a replacement that exits at boot (${bootExit}) is rolled back and the healthy peer is never drained`, async () => {
    await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { bootExit } }, async (sfus) => {
      const result = await deploy(sfus);
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /sfu-b did not report healthy/);
      assert.equal(sfus["sfu-a"].drains.length, 0, "the healthy peer keeps serving");
      assert.equal(sfus["sfu-b"].image, "sha256:running", "sfu-b is back on its previous image");
      assert.equal(sfus["sfu-b"].container, "running");
    });
  });
}

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

test("a rerun checks the public route of an instance already on the target", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { onTarget: true } }, async (sfus) => {
    // sfu-b passed its canary on an earlier run but its public route lands on sfu-a.
    const result = await deploy(sfus, { envLines: [`SFU_B_PUBLIC_URL=http://127.0.0.1:${sfus["sfu-a"].port}`] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-b already runs .* but clients cannot reach it/);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a partial rollback keeps the rollback target until every instance is back", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(
        path.join(stateDir, "vm.env"),
        "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\nVERIFIED_IMAGE=sha256:target\n",
      );
      const rollback = (svc) =>
        deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_SERVICES: svc, SFU_DEPLOY_STATE_DIR: stateDir } });

      const first = await rollback("sfu-a");
      assert.equal(first.code, 0, first.output);
      assert.equal(sfus["sfu-a"].image, "sha256:previous");
      assert.equal(sfus["sfu-b"].image, "sha256:target");
      assert.match(await readFile(path.join(stateDir, "vm.env"), "utf8"), /PREVIOUS_GOOD_IMAGE=sha256:previous/);

      const second = await rollback("sfu-b");
      assert.equal(second.code, 0, second.output);
      assert.equal(sfus["sfu-b"].image, "sha256:previous");
      const recorded = await readFile(path.join(stateDir, "vm.env"), "utf8");
      assert.match(recorded, /LAST_GOOD_IMAGE=sha256:previous/);
      assert.match(recorded, /PREVIOUS_GOOD_IMAGE=''\n/);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a pull that changes deploy-sfu.sh hands the deploy to the new script", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const current = await readFile(path.join(scripts, "deploy-sfu.sh"), "utf8");
    const marker = 'echo "The pulled deploy-sfu.sh is running."\n';
    const pulled = current.replace("set -euo pipefail\n", `set -euo pipefail\n${marker}`);
    assert.notEqual(pulled, current);
    const result = await deploy(sfus, { upstream: { "scripts/deploy-sfu.sh": pulled } });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /This pull changed deploy-sfu.sh; restarting with the new version/);
    assert.equal(result.output.split("The pulled deploy-sfu.sh is running.").length - 1, 1, "the new script runs once");
    assert.match(result.output, /SFU deploy complete/);
  });
});

const hasPowerShell = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("two deploys at once on one host: the second refuses and only one instance drains", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 1 } }, async (sfus) => {
    const lock = path.join(await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-")), "deploy.lock");
    // Hold every drain until both runs have reached one, as Sol's probe did.
    let release;
    const both = new Promise((resolve) => (release = resolve));
    const guard = setTimeout(release, 8000);
    let reached = 0;
    beforeDrain = async () => {
      reached += 1;
      if (reached === 2) release();
      await both;
    };
    try {
      const runs = await Promise.all(
        ["sfu-a", "sfu-b"].map((svc) =>
          deploy(sfus, { env: { SFU_DEPLOY_SERVICES: svc, SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "1", DRAIN_TIMEOUT_SECONDS: "3" } }),
        ),
      );
      assert.equal(runs.filter((run) => /still holds .* not starting a second one/.test(run.output)).length, 1, runs.map((run) => run.output).join("\n"));
      assert.equal(Object.values(sfus).filter((sfu) => sfu.drains.some((drain) => drain.draining)).length, 1);
    } finally {
      beforeDrain = null;
      clearTimeout(guard);
    }
  });
});

test("a rerun after an interrupted pair of deploys puts a healthy instance back into service and continues", async () => {
  await withSfus({ "sfu-a": { draining: true }, "sfu-b": { draining: true } }, async (sfus) => {
    const result = await deploy(sfus);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /No SFU is taking new meetings; putting sfu-a back into service/);
    assert.deepEqual(sfus["sfu-a"].drains[0], { draining: false });
    assert.equal(sfus["sfu-a"].recreates.length, 2);
    assert.equal(sfus["sfu-b"].recreates.length, 2);
  });
});

test("a management URL that answers as another instance is refused before any drain", async () => {
  await withSfus({ "sfu-a": { rooms: 2 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    // sfu-a's management URL reaches sfu-b, as in Astra's probe.
    const result = await deploy(sfus, { envLines: [`SFU_A_URL=http://127.0.0.1:${sfus["sfu-b"].port}`] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-a's management URL .* answers as 'sfu-b', not sfu-a/);
    assert.deepEqual(events, []);
  });
});

test("a running container whose probes are silent is refused even when it started seconds ago", async () => {
  await withSfus({ "sfu-a": { rooms: 1, container: "young" }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sfu-a's container is running but nothing answers/);
    assert.deepEqual(cutRooms(sfus), []);
  });
});

test("a deploy of one instance refuses while the other is not publicly reachable", async () => {
  await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" }, envLines: ["SFU_B_PUBLIC_URL=http://127.0.0.1:9"] });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Not draining sfu-a: clients cannot reach sfu-b/);
    assert.equal(sfus["sfu-a"].drains.length, 0);
  });
});

test("a deploy of one instance still runs the full preflight", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a", DEPLOY_TEST_OVERLAP: "1" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /overlap/i);
    assert.deepEqual(events, []);
  });
});

test("a compose error at either recreate puts the instance back on its previous image", async () => {
  for (const failing of [1, 2]) {
    await withSfus({ "sfu-a": { rooms: 1 }, "sfu-b": { rooms: 0, failRecreate: failing } }, async (sfus) => {
      const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b" } });
      assert.equal(result.code, 4, result.output);
      assert.match(result.output, /Rolling sfu-b back to its previous image/);
      assert.equal(sfus["sfu-b"].container, "running");
      assert.equal(sfus["sfu-b"].image, "sha256:running");
      assert.equal(sfus["sfu-a"].drains.length, 0);
    });
  }
});

test("--rollback after a partial rollout returns every instance to the last release that fully served", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      // B served on both; A came before it; C reached sfu-b only.
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=B\nLAST_GOOD_IMAGE=sha256:running\nPREVIOUS_GOOD_COMMIT=A\nPREVIOUS_GOOD_IMAGE=sha256:older\n");
      const partial = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b", SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(partial.code, 0, partial.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:running", "sha256:target"]);
      const rollback = await deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(rollback.code, 0, rollback.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:running", "sha256:running"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback killed after its first instance finishes going back to the same release when rerun", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const rollback = (env = {}) => deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir, ...env } });
      // Killed once sfu-a's canary container and serving container are up.
      const killed = await rollback({ DEPLOY_TEST_KILL_AFTER_RECREATES: "2" });
      assert.equal(killed.code, null, killed.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:target"]);

      const rerun = await rollback();
      assert.equal(rerun.code, 0, rerun.output);
      assert.match(rerun.output, /Finishing the rollback to good/);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback paused by a call (exit 3) keeps its target for the rerun", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true, rooms: 1 } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const rollback = () => deploy(sfus, { args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      const paused = await rollback();
      assert.equal(paused.code, 3, paused.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:target"]);

      sfus["sfu-b"].rooms = 0;
      const rerun = await rollback();
      assert.equal(rerun.code, 0, rerun.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a silent instance whose container state Docker cannot report is not rebuilt", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": { container: "hung", rooms: 1, stateInspectFails: true } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-b", CONTAINER_SAMPLE_SECONDS: "0" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Docker could not report the state of sfu-b's container/);
    assert.deepEqual(sfus["sfu-b"].recreates, []);
  });
});

test("a deploy waits for a backup holding the host lock, then runs", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const dir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-lock-"));
    const lock = path.join(dir, "deploy.lock");
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    await provideFlock(bin);
    // The backup: holds the lock for 2 s.
    const backup = spawn("bash", ["-c", 'exec 7>>"$1"; flock -n 7 && echo locked && sleep 2', "_", lock], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    try {
      await new Promise((done) => backup.stdout.once("data", done));
      const result = await deploy(sfus, { env: { SFU_DEPLOY_LOCK_FILE: lock, SFU_DEPLOY_LOCK_WAIT_SECONDS: "30" } });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Another SFU deploy or a backup holds .*; waiting up to 30s/);
    } finally {
      backup.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("a host without flock refuses to deploy rather than lock some other way", async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    const result = await deploy(sfus, { withoutFlock: true });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /needs flock \(util-linux\)/);
    assert.deepEqual(events, []);
  });
});

test("deploy-sfu.ps1 refuses to start on Windows and says to run deploy-sfu.sh in WSL", { skip: !hasPowerShell && "needs pwsh on PATH" }, async () => {
  await withSfus({ "sfu-a": {}, "sfu-b": {} }, async (sfus) => {
    // OS=Windows_NT is how Windows identifies itself to every process.
    const result = await deploy(sfus, { powershell: true, env: { OS: "Windows_NT" } });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Open a WSL shell in the checkout and run \.\/scripts\/deploy-sfu\.sh/);
    assert.deepEqual(result.docker, [], "deploy-sfu.sh never ran");
  });
});

test("deploy-sfu.ps1 hands the deploy, --rollback included, to deploy-sfu.sh", { skip: !hasPowerShell && "needs pwsh on PATH" }, async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const result = await deploy(sfus, { powershell: true, args: ["--rollback"], env: { SFU_DEPLOY_STATE_DIR: stateDir } });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Rollback: the checkout stays at/);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("the canary runs from one bundled file, without the SFU's dev dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-canary-"));
  try {
    // An empty directory stands in for an image installed with production
    // dependencies only: nothing but the bundle and Node.
    await run(process.execPath, [path.join(scripts, "..", "packages", "sfu", "scripts", "build-canary.mjs"), path.join(root, "canary-call.mjs")]);
    const bare = await run(process.execPath, [path.join(root, "canary-call.mjs")], { cwd: root }).then(
      () => ({ code: 0, output: "" }),
      (error) => ({ code: error.code, output: `${error.stdout}${error.stderr}` }),
    );
    assert.doesNotMatch(bare.output, /ERR_MODULE_NOT_FOUND/);
    assert.equal(bare.code, 2, bare.output);
    assert.match(bare.output, /Usage: SFU_SECRET=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rollback to a release built before the canary bundle runs the checkout's canary against it", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const result = await deploy(sfus, {
        args: ["--rollback"],
        env: { SFU_DEPLOY_STATE_DIR: stateDir, DEPLOY_TEST_NO_BUNDLE: "sha256:previous" },
      });
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
      const canaries = result.docker.filter((args) => args[0] === "run");
      assert.equal(canaries.length, 2, "one canary per instance");
      for (const canary of canaries) {
        assert.equal(canary[canary.indexOf("--entrypoint") + 2], "sha256:target", "the checkout's image runs the canary");
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("a rollback whose checkout was never built builds its canary under its own tag, and a retry after a partial rollback keeps every service image", async () => {
  await withSfus({ "sfu-a": { onTarget: true }, "sfu-b": { onTarget: true, rooms: 1 } }, async (sfus) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "conclave-deploy-state-"));
    try {
      await writeFile(path.join(stateDir, "vm.env"), "LAST_GOOD_COMMIT=bad\nLAST_GOOD_IMAGE=sha256:target\nPREVIOUS_GOOD_COMMIT=good\nPREVIOUS_GOOD_IMAGE=sha256:previous\n");
      const env = {
        SFU_DEPLOY_STATE_DIR: stateDir,
        DEPLOY_TEST_DOCKER_TAGS: path.join(stateDir, "docker-tags.json"),
        DEPLOY_TEST_NO_BUNDLE: "sha256:previous",
        DEPLOY_TEST_NO_COMMIT_IMAGES: "1",
      };
      // sfu-b still has a call, so the first run rolls back sfu-a only.
      const partial = await deploy(sfus, { args: ["--rollback"], env });
      assert.equal(partial.code, 3, partial.output);
      sfus["sfu-b"].rooms = 0;
      const retry = await deploy(sfus, { args: ["--rollback"], env });
      assert.equal(retry.code, 0, retry.output);

      assert.deepEqual(Object.values(sfus).map((sfu) => sfu.image), ["sha256:previous", "sha256:previous"]);
      assert.equal(retry.tags["vm-sfu-a"], "sha256:previous", "sfu-a's compose image still names the rollback release");
      assert.equal(retry.tags["vm-sfu-b"], "sha256:previous");
      for (const run of [partial, retry]) {
        assert.ok(!run.docker.some((args) => args[0] === "compose" && args.includes("build")), "no service image is rebuilt");
      }
      assert.match(partial.output, /Building [0-9a-f]{12} as vm-sfu-canary:[0-9a-f]{12} for its canary; the instances still go back to good/);
      assert.doesNotMatch(retry.output, /Building/, "the retry reuses the canary image");
      const canaryImages = retry.docker.filter((args) => args[0] === "run").map((args) => args[args.indexOf("--entrypoint") + 2]);
      assert.deepEqual(canaryImages, ["sha256:canary-build"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("the deploy runs the bundled canary from the image", async () => {
  await withSfus({ "sfu-a": { rooms: 0 }, "sfu-b": { rooms: 0 } }, async (sfus) => {
    const result = await deploy(sfus, { env: { SFU_DEPLOY_SERVICES: "sfu-a" } });
    assert.equal(result.code, 0, result.output);
    const canary = result.docker.find((args) => args[0] === "run");
    assert.ok(canary, "the canary ran");
    assert.ok(canary.includes("dist/canary-call.mjs"), canary.join(" "));
    assert.ok(!canary.includes("tsx"), canary.join(" "));
  });
});
