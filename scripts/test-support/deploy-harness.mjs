import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathWithout, provideFlock } from "./host-tools.mjs";

// Runs the real deploy-sfu.sh against two fake SFUs (HTTP servers that report
// rooms and take drains) and a stand-in docker CLI. A recreate replaces the
// instance's container, so any rooms it still had are cut; the stand-in asks
// the fake SFU how many that was.

export const run = promisify(execFile);
export const scripts = path.join(import.meta.dirname, "..");
const secret = "deploy-test-secret";

// The tests run side by side, each with its own fake SFUs, so whatever a
// test watches lives in its own context: every drain, stop and recreate
// across its fake SFUs in the order they happened (events), and a hook called
// before one of them applies a drain, so a test can line two up
// (beforeDrain).

// container: "running" for an hour, "exited", "crash-looping" (Docker keeps
// restarting it), "hung" (running for an hour) or "young" (running for a few
// seconds). Only "running" answers HTTP until a recreate. failRecreate: the
// recreate (1st, 2nd...) at which compose fails after stopping the old
// container. replacementHealthy: false for a build whose containers
// never report healthy (the image the instance started on still does). bootExit: "exited" or "crash-looping", the state a
// container of the target image ends in right after it starts; the previous
// image still boots. stateInspectFails: docker inspect of the container's
// state fails. statusHealthy: false for an instance whose /status says
// healthy: false until it is recreated. onTarget: already runs the target
// image with the current compose config.
export const startSfu = async (
  context,
  instanceId,
  {
    rooms = 0,
    statusAnswers = true,
    container = "running",
    replacementHealthy = true,
    bootExit = null,
    stateInspectFails = false,
    envInspectFails = false,
    statusHealthy = true,
    draining = false,
    onTarget = false,
    failRecreate = 0,
    publicRoute = false,
    onRecreate = null,
    onTag = null,
    dropDrainReply = false,
    refuseDrain = false,
    id = instanceId,
  } = {},
) => {
  const journal = () => {
    try {
      return JSON.parse(readFileSync(path.join(context.stateDir ?? "", `vm.${instanceId}.journal.json`), "utf8"));
    } catch {
      return {};
    }
  };
  const sfu = {
    instanceId,
    id,
    refuseDrain,
    rooms,
    draining,
    statusAnswers,
    container,
    healthy: true,
    statusHealthy,
    image: onTarget ? "sha256:target" : "sha256:running",
    firstImage: onTarget ? "sha256:target" : "sha256:running",
    configHash: onTarget ? "current-hash" : "older-hash",
    restartCount: 0,
    bootDrained: false,
    failRecreate,
    drains: [],
    recreates: [],
    stops: [],
    undrains: [],
    starts: [],
    canaryPassed: [],
    publicLog: [],
    lonelyDrains: [],
    restartPolicy: "unless-stopped",
    statusFailures: 0,
  };
  sfu.restart = () => {
    if (sfu.container !== "exited" || sfu.restartPolicy === "no") return;
    sfu.container = "running";
    sfu.draining = sfu.bootDrained;
    sfu.crashedAt = null;
    sfu.starts.push({ image: sfu.image, bootDrained: sfu.bootDrained, by: "restart-policy" });
  };
  sfu.crash = (restartAfterMs) => {
    if (sfu.container !== "running") return;
    sfu.container = "exited";
    sfu.rooms = 0;
    sfu.crashedAt = Date.now();
    if (restartAfterMs === null) return;
    const generation = sfu.recreates.length;
    setTimeout(() => {
      if (sfu.recreates.length === generation) sfu.restart();
    }, restartAfterMs).unref();
  };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://sfu");
    const json = (value, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/stand-in/state") {
      const startedAt = new Date(Date.now() - (["crash-looping", "young"].includes(sfu.container) ? 3_000 : 3_600_000)).toISOString();
      if (sfu.container === "crash-looping" || sfu.restartsWhileRunning) sfu.restartCount += 1;
      const status = { exited: "exited", "crash-looping": "restarting" }[sfu.container] ?? "running";
      return json({
        status,
        startedAt,
        restartCount: sfu.restartCount,
        bootDrained: sfu.bootDrained,
        image: sfu.image,
        configHash: sfu.configHash,
        stateInspectFails,
        envInspectFails,
        firstImage: sfu.firstImage,
      });
    }
    if (url.pathname === "/status") sfu.onStatus?.(sfu);
    if (sfu.container !== "running" && !url.pathname.startsWith("/stand-in/")) return req.socket.destroy();
    if (url.pathname === "/health") return sfu.healthy ? json({ status: "healthy" }) : json({ status: "starting" }, 503);
    if (url.pathname === "/status") {
      if (!sfu.statusAnswers || (sfu.statusFailures > 0 && sfu.statusFailures--)) return json({ error: "unavailable" }, 503);
      return json({ instanceId: id, region: "local", healthy: sfu.statusHealthy, rooms: sfu.rooms, draining: sfu.draining });
    }
    if (url.pathname === "/drain" && req.method === "POST") {
      const request = JSON.parse(body || "{}");
      if (request.draining && context.beforeDrain) await context.beforeDrain();
      if (sfu.refuseDrain) return json({ error: "drain refused" }, 500);
      if (request.draining === false) sfu.undrains.push({ image: sfu.image, ...journal() });
      const takesMeetings = (other) => other.container === "running" && !other.draining;
      const others = Object.values(context.sfus ?? {}).filter((other) => other !== sfu);
      if (request.draining && takesMeetings(sfu) && others.length > 0 && !others.some(takesMeetings)) {
        sfu.lonelyDrains.push({
          image: sfu.image,
          othersDownMs: Math.min(...others.map((other) => (other.crashedAt ? Date.now() - other.crashedAt : Infinity))),
          others: others.map((other) => `${other.instanceId} ${other.container} draining=${other.draining}`),
        });
      }
      sfu.drains.push(request);
      context.events.push(`drain ${instanceId}`);
      sfu.draining = request.draining === true;
      // A forced drain answers once its notice has run, as the SFU does, and
      // ends the instance's rooms.
      if (request.force && request.noticeMs) await new Promise((done) => setTimeout(done, request.noticeMs));
      if (request.force) sfu.rooms = 0;
      // dropDrainReply: the drain is applied, then its reply is lost.
      if (dropDrainReply && request.draining) return req.socket.destroy();
      return json({ draining: sfu.draining, forced: request.force === true });
    }
    if (url.pathname === "/stand-in/update") {
      if (url.searchParams.get("restart")) sfu.restartPolicy = url.searchParams.get("restart");
      if (url.searchParams.get("restart") === "no") sfu.heldDown = true;
      return json({ ok: true });
    }
    if (url.pathname === "/stand-in/tagged") {
      onTag?.(sfu, url.searchParams.get("to"));
      return json({ ok: true });
    }
    if (url.pathname === "/stand-in/canary") {
      sfu.canaryPassed.push(sfu.image);
      return json({ ok: true });
    }
    if (url.pathname === "/stand-in/stop") {
      context.events.push(`stop ${instanceId}`);
      sfu.stops.push({ roomsCut: ["exited", "crash-looping"].includes(sfu.container) ? 0 : sfu.rooms });
      sfu.rooms = 0;
      sfu.container = "exited";
      return json({ ok: true });
    }
    if (url.pathname === "/stand-in/recreate") {
      sfu.recreates.push({ roomsCut: ["exited", "crash-looping"].includes(sfu.container) ? 0 : sfu.rooms, draining: sfu.draining, bootDrained: sfu.bootDrained, from: sfu.image, to: url.searchParams.get("image"), ...journal() });
      context.events.push(`recreate ${instanceId}`);
      sfu.rooms = 0;
      if (sfu.failRecreate === sfu.recreates.length) {
        sfu.container = "exited";
        return json({ error: "compose failed after stopping the old container" }, 500);
      }
      sfu.container = "running";
      sfu.statusHealthy = true;
      sfu.bootDrained = url.searchParams.get("draining") === "true";
      sfu.draining = url.searchParams.get("draining") === "true";
      sfu.image = url.searchParams.get("image");
      // The image it ran before the deploy still boots healthy.
      sfu.healthy = replacementHealthy || sfu.image === sfu.firstImage;
      sfu.configHash = url.searchParams.get("hash") ?? "current-hash";
      sfu.restartPolicy = url.searchParams.get("restart") ?? "unless-stopped";
      sfu.crashedAt = null;
      sfu.heldDown = false;
      sfu.starts.push({ image: sfu.image, bootDrained: sfu.bootDrained, by: "compose" });
      if (bootExit && sfu.image === "sha256:target") sfu.container = bootExit;
      // onRecreate: a test's hook, given the instance as it now is.
      onRecreate?.(sfu);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  sfu.port = server.address().port;
  // publicRoute: clients reach the instance through a route of its own,
  // which answers 502 while sfu.publicDown is set.
  let proxy = null;
  if (publicRoute) {
    proxy = createServer(async (req, res) => {
      if (sfu.publicDown || (sfu.publicFailures > 0 && sfu.publicFailures--)) {
        sfu.publicLog.push({ at: Date.now(), healthy: false });
        return res.writeHead(502).end("bad gateway");
      }
      const answer = await fetch("http://127.0.0.1:" + sfu.port + req.url, { headers: req.headers }).catch(() => null);
      if (!answer) {
        sfu.publicLog.push({ at: Date.now(), healthy: false });
        return req.socket.destroy();
      }
      const text = await answer.text();
      let healthy = false;
      try {
        healthy = answer.ok && JSON.parse(text).healthy === true;
      } catch {}
      if (req.url.startsWith("/status")) sfu.publicLog.push({ at: Date.now(), healthy });
      res.writeHead(answer.status, { "content-type": "application/json" }).end(text);
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
    sfu.publicPort = proxy.address().port;
  }
  sfu.close = () => Promise.all([server, proxy].filter(Boolean).map((open) => new Promise((done) => open.close(done))));
  return sfu;
};

export const dockerStandIn = `#!/usr/bin/env node
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
// The variable a service's image name reads, as in the compose files.
const imageVar = (name) => "SFU_IMAGE_" + name.toUpperCase().replaceAll("-", "_");
const configHash = (name) =>
  "current-hash" +
  (process.env.SFU_START_DRAINING === "true" ? "-drained" : "") +
  (process.env.SFU_RESTART_POLICY && process.env.SFU_RESTART_POLICY !== "unless-stopped" ? "-restart-" + process.env.SFU_RESTART_POLICY : "") +
  (process.env[imageVar(name)] && process.env[imageVar(name)] !== "vm-" + name ? "-" + process.env[imageVar(name)] : "");
const service = (name, sfu, index) => ({
  image: process.env[imageVar(name)] || "vm-" + name,
  restart: process.env.SFU_RESTART_POLICY || "unless-stopped",
  environment: {
    ANNOUNCED_IP: "127.0.0.1",
    // DEPLOY_TEST_OVERLAP gives both services one RTC range, which the full
    // preflight rejects.
    RTC_MIN_PORT: process.env.DEPLOY_TEST_OVERLAP ? "41001" : String(40000 + index * 1000),
    RTC_MAX_PORT: process.env.DEPLOY_TEST_OVERLAP ? "42000" : String(40999 + index * 1000),
    SFU_INSTANCE_ID: sfu.id ?? name,
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
    // DEPLOY_TEST_REDIS_SERVICE: the compose file runs its own Redis, as
    // staging's does.
    if (rest[0] === "config" && rest[1] === "--services") return out([...names, ...(process.env.DEPLOY_TEST_REDIS_SERVICE ? ["redis"] : [])].join("\\n"));
    if (rest[0] === "config" && rest[1] === "--format") {
      return out(JSON.stringify({ name: "vm", services: Object.fromEntries(names.map((n, i) => [n, service(n, sfus[n], i)])) }));
    }
    // The hash covers the rendered config, so it changes with what the
    // service's env and image name render to, as Compose's does.
    if (rest[0] === "config" && rest[1] === "--hash") return out(rest[2] + " " + configHash(rest[2]));
    if (rest[0] === "ps") return out("ctr-" + rest.at(-1));
    // A build retags the service's own image, as compose does.
    if (rest[0] === "build") {
      tags["vm-" + rest.at(-1)] = "sha256:checkout-build";
      return fs.writeFileSync(tagsFile, JSON.stringify(tags));
    }
    if (rest[0] === "stop") {
      await fetch("http://127.0.0.1:" + sfus[rest.at(-1)].port + "/stand-in/stop");
      return;
    }
    if (rest[0] === "up" && rest.at(-1) === "redis") return;
    if (rest[0] === "up") {
      const name = rest.at(-1);
      const draining = process.env.SFU_START_DRAINING === "true";
      // The image name its variable gives it, else vm-<service>.
      // DEPLOY_TEST_COMPOSE_IGNORES_IMAGE: a compose that starts the old
      // image whatever it is told.
      // A service name nothing has tagged yet names the image the instance
      // started on, as it does on a host.
      // DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS: a host whose running images
      // carry other names, where compose builds the checkout for a service
      // name nothing has tagged.
      const told = process.env[imageVar(name)] || "vm-" + name;
      const untagged = told === "vm-" + name
        ? (process.env.DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS ? "sha256:checkout-build" : (await state(name)).firstImage)
        : "sha256:target";
      const image = process.env.DEPLOY_TEST_COMPOSE_IGNORES_IMAGE ? "sha256:running" : tags[told] || untagged;
      const response = await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/recreate?draining=" + draining + "&image=" + image + "&hash=" + encodeURIComponent(configHash(name)) + "&restart=" + encodeURIComponent(process.env.SFU_RESTART_POLICY || "unless-stopped"));
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
    if (format.includes(".Config.Env")) {
      const current = await state(name);
      if (current.envInspectFails) {
        process.exitCode = 1;
        return;
      }
      return out("SFU_DRAINING=" + current.bootDrained);
    }
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
    const tag = args[args.indexOf("-t") + 1];
    tags[tag] = tag.includes("-canary:") ? "sha256:canary-build" : "sha256:candidate-build";
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
  // A rollback-<service> tag exists only once a deploy has set it, and so
  // does a service name on a host whose images carry other names.
  const untaggedService = process.env.DEPLOY_TEST_UNTAGGED_SERVICE_BUILDS && /^vm-sfu-[a-z]+$/.test(args.at(-1));
  if (args[0] === "image" && args[1] === "inspect" && (/:rollback-/.test(args.at(-1)) || untaggedService) && !(args.at(-1) in tags)) {
    process.exitCode = 1;
    return;
  }
  if (args[0] === "image" && args[1] === "inspect") return args[2] === "-f" ? out(tags[args.at(-1)] || "sha256:target") : undefined;
  if (args[0] === "tag") {
    tags[args[2]] = tags[args[1]] || args[1];
    fs.writeFileSync(tagsFile, JSON.stringify(tags));
    for (const name of Object.keys(sfus)) {
      if (args[2] === "vm-" + name || args[2].endsWith("-" + name)) {
        await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/tagged?to=" + encodeURIComponent(args[2])).catch(() => undefined);
      }
    }
    return;
  }
  if (args[0] === "update") {
    const name = args.at(-1).replace(/^ctr-/, "");
    const policy = (args.find((arg) => arg.startsWith("--restart=")) || "").slice("--restart=".length);
    await fetch("http://127.0.0.1:" + sfus[name].port + "/stand-in/update?restart=" + encodeURIComponent(policy));
    return;
  }
  // DEPLOY_TEST_NO_BUNDLE: images built before the canary bundle existed.
  if (args[0] === "run") {
    const image = args[args.indexOf("--entrypoint") + 2];
    // DEPLOY_TEST_BAD_IMAGES: builds whose calls carry no media, so the
    // canary fails against an instance running one of them.
    // DEPLOY_TEST_KILL_ON_CANARY_FAILURE: the deploy is killed right then.
    const target = Object.keys(sfus).find((name) => args.at(-1).endsWith(":" + sfus[name].port));
    if (target && (process.env.DEPLOY_TEST_BAD_IMAGES || "").split(",").includes((await state(target)).image)) {
      process.stderr.write("FAIL canary: zero RTP in both directions\\n");
      if (process.env.DEPLOY_TEST_KILL_ON_CANARY_FAILURE) process.kill(process.ppid, "SIGKILL");
      process.exitCode = 1;
      return;
    }
    if ((process.env.DEPLOY_TEST_NO_BUNDLE || "").split(",").includes(image)) {
      process.stderr.write("Error: Cannot find module '/app/packages/sfu/dist/canary-call.mjs'\\n");
      process.exitCode = 1;
      return;
    }
    if (target) await fetch("http://127.0.0.1:" + sfus[target].port + "/stand-in/canary", { method: "POST" });
    return;
  }
  // rmi succeeds.
};
main();
`;

// upstream: files the next commit on origin changes, so the checkout is one
// pull behind the revision it will deploy.
// withoutFlock: run on a host whose PATH has no flock. script: the
// deploy-sfu.sh the checkout starts with, in place of the current one.
export const deploy = async (
  sfus,
  { args: extraArgs = [], env: extraEnv = {}, envLines = [], upstream, powershell = false, withoutFlock = false, script, noRedisUrl = false, journals = {} } = {},
) => {
  // On macOS this path sits behind the /var symlink, so the preflight also
  // runs through one.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-deploy-"));
  try {
    const src = path.join(root, "src");
    await mkdir(path.join(src, "scripts"), { recursive: true });
    // DEPLOY_TEST_SCRIPT: another deploy-sfu.sh, to show a new case fails on
    // an older script.
    await copyFile(process.env.DEPLOY_TEST_SCRIPT ?? path.join(scripts, "deploy-sfu.sh"), path.join(src, "scripts", "deploy-sfu.sh"));
    if (script) await writeFile(path.join(src, "scripts", "deploy-sfu.sh"), script);
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
        ...(noRedisUrl ? [] : ["REDIS_URL=redis://127.0.0.1:6379/0"]),
        ...Object.entries(sfus).flatMap(([name, sfu]) => [
          `SFU_${name.at(-1).toUpperCase()}_URL=http://127.0.0.1:${sfu.port}`,
          `SFU_${name.at(-1).toUpperCase()}_PUBLIC_URL=http://127.0.0.1:${sfu.publicPort ?? sfu.port}`,
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
      DEPLOY_TEST_SFUS: JSON.stringify(Object.fromEntries(Object.entries(sfus).map(([n, s]) => [n, { port: s.port, id: s.id }]))),
      DEPLOY_TEST_DOCKER_LOG: dockerLog,
      SFU_DEPLOY_STATE_DIR: path.join(root, "state"),
      DRAIN_TIMEOUT_SECONDS: "2",
      DRAIN_POLL_SECONDS: "0.2",
      PLACEMENT_SETTLE_SECONDS: "0",
      HEALTH_TIMEOUT_SECONDS: "5",
      CONTAINER_SAMPLE_SECONDS: "0.2",
      DEPLOY_POLL_SECONDS: "0.1",
      DEPLOY_STATUS_RETRY_SECONDS: "0.2",
      SFU_DEPLOY_LOCK_FILE: path.join(root, "deploy.lock"),
      ...extraEnv,
    };
    const command = powershell
      ? ["pwsh", ["-NoProfile", "-File", path.join(vm, "scripts", "deploy-sfu.ps1"), ...extraArgs]]
      : ["bash", [path.join(vm, "scripts", "deploy-sfu.sh"), ...extraArgs]];
    // journals: { service: fields } already on disk, as an earlier run left
    // them (a canary that passed there: { phase: "idle", lkg: image }).
    await mkdir(env.SFU_DEPLOY_STATE_DIR, { recursive: true });
    for (const [name, fields] of Object.entries(journals)) {
      await writeFile(path.join(env.SFU_DEPLOY_STATE_DIR, `vm.${name}.journal.json`), JSON.stringify(fields));
    }
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

// Runs `docker compose up -d <name>` through the stand-in, with no image
// variable and no SFU_START_DRAINING, as an operator who restarts a service by
// hand would: it starts whatever the service's own image name points at.
export const composeUpByHand = async (sfus, { tags, dir, env: extra = {} }, name) => {
  await mkdir(dir, { recursive: true });
  const docker = path.join(dir, "docker");
  await writeFile(docker, dockerStandIn, { mode: 0o755 });
  const log = path.join(dir, "docker.log");
  const env = { ...process.env, ...extra, DEPLOY_TEST_SFUS: JSON.stringify(Object.fromEntries(Object.entries(sfus).map(([n, s]) => [n, { port: s.port, id: s.id }]))), DEPLOY_TEST_DOCKER_LOG: log, DEPLOY_TEST_DOCKER_TAGS: tags };
  for (const variable of Object.keys(env)) if (variable.startsWith("SFU_IMAGE_") || variable === "SFU_START_DRAINING") delete env[variable];
  await run(docker, ["compose", "up", "-d", name], { env });
};

export const withSfus = async (specs, body) => {
  const sfus = {};
  const context = { events: [], beforeDrain: null, sfus };
  try {
    for (const [name, spec] of Object.entries(specs)) sfus[name] = await startSfu(context, name, spec);
    await body(sfus, context.events, context);
  } finally {
    await Promise.all(Object.values(sfus).map((sfu) => sfu.close()));
  }
};

export const passedPreflight = (result) => assert.match(result.output, /SFU deployment preflight passed/, result.output);

export const cutRooms = (sfus) => Object.values(sfus).flatMap((sfu) => [...sfu.recreates, ...sfu.stops].map((r) => r.roomsCut));
