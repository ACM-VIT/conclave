import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test as nodeTest } from "node:test";
import { promisify } from "node:util";
import { provideFlock } from "../test-support/host-tools.mjs";

const run = promisify(execFile);
// The restore refuses a state dir whose parent its group can write, so the
// dirs the cases make get the same modes whatever the runner's umask.
process.umask(0o022);
// Every case has its own root dir, keys, state dir, docker stand-in, lock
// files and fake SFUs, so they run side by side (see the end of the file).
const queued = [];
const test = (...args) => queued.push(args);
const scripts = import.meta.dirname;
const hasTool = (tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
// The tools backup.sh and restore.sh need. A laptop without them skips the
// cases that need them; CI installs them all, so there a missing tool fails
// the run instead of letting every case skip.
const missing = ["age", "age-keygen", "fuser", "python3"].filter((tool) => !hasTool(tool));
const missingWithRedis = [...missing, ...["redis-server", "redis-cli"].filter((tool) => !hasTool(tool))];
if (process.env.CI && missingWithRedis.length > 0) {
  throw new Error(`CI must install ${missingWithRedis.join(", ")} for the backup tests (see .github/workflows/ci.yml)`);
}

// A stand-in docker CLI that answers from a JSON list of containers, so a
// backup sees the SFU containers a test describes and never this host's.
// Each entry: { id, mounts, status, env, user, image, runningAfterChecks };
// a mount is a source path, or { source, rw: false } for a read-only one;
// runningAfterChecks: the container is reported running from that many
// inspections on, as a deploy starting it would. { "fail": true } makes every
// command fail.
const dockerStandIn = `#!/usr/bin/env node
const fs = require("node:fs");
const listed = JSON.parse(fs.readFileSync(process.env.BACKUP_TEST_DOCKER, "utf8"));
const args = process.argv.slice(2);
const out = (lines) => process.stdout.write(lines.map((line) => line + "\\n").join(""));
// docker run of a redis image: the real redis-server (BACKUP_TEST_REAL_REDIS)
// with the volume's /data mapped to its host dir, and docker rm -f to stop it.
const runs = process.env.BACKUP_TEST_DOCKER + ".runs.json";
if (args[0] === "run" && args.some((arg) => arg.startsWith("redis:"))) {
  const dir = args[args.indexOf("-v") + 1].split(":")[0];
  const name = args[args.indexOf("--name") + 1];
  const server = args.indexOf("redis-server", args.findIndex((arg) => arg.startsWith("redis:")));
  const rest = args.slice(server + 1).map((arg) => arg.replaceAll("/data", dir));
  const child = require("node:child_process").spawn(process.env.BACKUP_TEST_REAL_REDIS, rest, { detached: true, stdio: "ignore" });
  child.unref();
  const started = fs.existsSync(runs) ? JSON.parse(fs.readFileSync(runs, "utf8")) : {};
  started[name] = child.pid;
  fs.writeFileSync(runs, JSON.stringify(started));
  return void out([name]);
}
if (args[0] === "rm" && args[1] === "-f") {
  const started = fs.existsSync(runs) ? JSON.parse(fs.readFileSync(runs, "utf8")) : {};
  if (started[args[2]]) {
    try { process.kill(started[args[2]]); } catch {}
  }
  return;
}
if (listed.fail) process.exit(1);
if (args[0] === "ps") return void out(listed.map((c) => c.id));
// docker inspect <ids...>: the JSON Docker prints, for the fields read.
if (args[0] === "inspect" && args[1] !== "-f") {
  const found = args.slice(1).map((id) => listed.find((entry) => entry.id === id));
  if (found.some((entry) => !entry)) process.exit(1);
  const countFile = process.env.BACKUP_TEST_DOCKER + ".inspections";
  const seen = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(seen + 1));
  for (const entry of found) if (entry.runningAfterChecks !== undefined && seen >= entry.runningAfterChecks) entry.status = "running";
  return void out([JSON.stringify(found.map((entry) => ({
    Id: entry.id,
    State: { Status: entry.status },
    Config: { Env: entry.env ?? [], User: entry.user ?? "" },
    Image: entry.image ?? "sha256:sfu-image",
    Mounts: (entry.mounts ?? []).map((mount) =>
      typeof mount === "string"
        ? { Type: "bind", Source: mount, Destination: "/var/lib/conclave/recordings", RW: true }
        : { Type: "bind", Source: mount.source, Destination: mount.destination ?? "/var/lib/conclave/recordings", RW: mount.rw !== false },
    ),
  })))]);
}
const c = listed.find((entry) => entry.id === args.at(-1));
if (args[0] !== "inspect" || !c) process.exit(1);
const format = args[2];
if (format.includes(".Mounts")) out(c.mounts ?? []);
else if (format.includes(".State.Status")) out([c.status]);
else if (format.includes(".Config.Env")) out(c.env ?? []);
else if (format.includes(".Config.User")) out([c.user ?? ""]);
else if (format.includes(".Image")) out([c.image ?? "sha256:sfu-image"]);
else process.exit(1);
`;

// A state dir, an age key pair and a backup.env, as on the VM. The SFU
// container is stopped and its health URL silent, unless a test says else.
const setUp = async (root, extraConfig = []) => {
  const state = path.join(root, "state");
  const local = path.join(root, "local");
  const repo = path.join(root, "repo");
  const key = path.join(root, "key.txt");
  await run("mkdir", ["-p", state, local, repo]);
  await run("age-keygen", ["-o", key]);
  const { stdout: recipient } = await run("age-keygen", ["-y", key]);
  await writeFile(path.join(root, "recipients.txt"), recipient);
  const config = path.join(root, "backup.env");
  // Name lookups on this host go through a hook that knows no accounts, so a
  // test means the same as root, as a normal user, with or without a node
  // account.
  const lookup = path.join(root, "id-lookup");
  await writeFile(lookup, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(
    config,
    [
      `BACKUP_ID_LOOKUP=${lookup}`,
      // The host's deploy lock, per test.
      `SFU_DEPLOY_LOCK_FILE=${path.join(root, "deploy.lock")}`,
      `CONCLAVE_REPO=${repo}`,
      `CONCLAVE_STATE_DIR=${state}`,
      `BACKUP_AGE_RECIPIENTS_FILE=${path.join(root, "recipients.txt")}`,
      `BACKUP_LOCAL_DIR=${local}`,
      "BACKUP_NAME=test",
      // Nothing listens here, so restore.sh sees the SFUs as stopped.
      'CONCLAVE_SFU_HEALTH_URLS="http://127.0.0.1:9/health"',
      // The SFU's user, as the VM would set it after #272; here the test's
      // own, the one owner a non-root restore can hand files to.
      `BACKUP_RESTORE_OWNER=${process.getuid()}:${process.getgid()}`,
      ...extraConfig,
    ].join("\n"),
  );
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "docker"), dockerStandIn, { mode: 0o755 });
  await provideFlock(bin);
  const dockerList = path.join(root, "docker.json");
  const setDocker = (containers) => writeFile(dockerList, JSON.stringify(containers));
  await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    BACKUP_TEST_DOCKER: dockerList,
    BACKUP_CONFIG: config,
    REDIS_URL: "",
    SFU_REDIS_URL: "",
  };
  const backup = (...args) => run("bash", [path.join(scripts, "backup.sh"), ...args], { env });
  const latestArchive = async () => {
    const archives = (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age")).sort();
    return path.join(local, archives.at(-1));
  };
  const restore = (...args) =>
    run("bash", [path.join(scripts, "restore.sh"), "--identity", key, ...args], { env });
  return { state, local, repo, config, bin, env, setDocker, backup, latestArchive, restore };
};

// A stand-in SFU with the real fence's rules: a hold belongs to its owner
// token, a renewal succeeds only while that owner holds it, and only that
// owner releases it. forgetHold drops the hold right after granting it, as a
// restart would. reportUntil overrides the deadline the SFU reports.
const fencedSfu = async ({ instanceId = "sfu-a", forgetHold = false, reportUntil, onHold, onRelease } = {}) => {
  const requests = [];
  let holder = null;
  const server = createHttpServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/health") return res.end('{"status":"healthy"}');
    if (req.url !== "/admin/persistence-fence") return res.writeHead(404).end();
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, ...body });
    const reply = (code, value) =>
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ ...value, instanceId }));
    const until = () => (reportUntil ? reportUntil() : Date.now() + body.holdMs);
    if (req.method === "POST" && body.renew) {
      return holder === body.owner ? reply(200, { held: true, until: until() }) : reply(409, { held: false });
    }
    if (req.method === "POST") {
      if (holder && holder !== body.owner) return reply(409, { held: false });
      holder = body.owner;
      await onHold?.();
      if (forgetHold) holder = null;
      return reply(200, { held: true, until: until() });
    }
    if (holder && holder !== body.owner) return reply(409, { released: false });
    const released = holder !== null;
    holder = null;
    await onRelease?.();
    return reply(200, { released });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  return {
    port,
    requests,
    health: `http://127.0.0.1:${port}/health`,
    container: (state) => ({ id: instanceId, mounts: [state], status: "running", env: [`SFU_PORT=${port}`, `SFU_INSTANCE_ID=${instanceId}`] }),
    close: () => new Promise((done) => server.close(done)),
  };
};

test(
  "a backup taken while the SFU writes restores every committed row",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    let db;
    let writer;
    try {
      const { state, local, backup, latestArchive, restore } = await setUp(root);

      // The SFU's own settings: WAL mode, and a writer that keeps going while
      // the backup runs.
      db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE scheduled_meetings (id TEXT PRIMARY KEY, title TEXT)");
      const insert = db.prepare("INSERT INTO scheduled_meetings VALUES (?, ?)");
      for (let i = 0; i < 500; i += 1) insert.run(`m${i}`, `Meeting ${i}`);
      let written = 500;
      writer = setInterval(() => {
        insert.run(`m${written}`, `Meeting ${written}`);
        written += 1;
      }, 2);
      await writeFile(path.join(state, "booking-links.json"), '{"links":["intro-call"]}');

      await backup("--local-only");
      clearInterval(writer);

      const archive = await latestArchive();
      // This test process holds the database open, as a running SFU does,
      // while its health URL answers nothing.
      await assert.rejects(restore("--file", archive, "--yes"), /still holds .*conclave\.sqlite open/);
      db.close();

      assert.equal((await readdir(local)).filter((name) => name.endsWith(".tar.gz.age")).length, 1);
      assert.ok(!(await readFile(archive)).includes("SQLite format 3"), "the archive must be encrypted");

      const dryRun = await restore("--file", archive);
      assert.match(dryRun.stdout, /sqlite\.conclave\.sqlite\.scheduled_meetings=\d+/);
      assert.match(dryRun.stdout, /Dry run: nothing changed/);

      await rm(state, { recursive: true });
      await restore("--file", archive, "--yes");
      const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      const rows = restored.prepare("SELECT count(*) AS n FROM scheduled_meetings").get().n;
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      restored.close();
      const backedUp = Number(dryRun.stdout.match(/scheduled_meetings=(\d+)/)[1]);
      assert.equal(rows, backedUp, "restore must return exactly the rows the backup captured");
      assert.ok(rows >= 500 && rows <= written, `restored ${rows} rows, wrote ${written}`);
      t.diagnostic(`backed up ${rows} rows while the writer reached ${written}`);
      assert.equal(await readFile(path.join(state, "booking-links.json"), "utf8"), '{"links":["intro-call"]}');

      const damaged = Buffer.from(await readFile(archive));
      damaged[damaged.length - 20] ^= 0xff;
      await writeFile(archive, damaged);
      await assert.rejects(restore("--file", archive), "a damaged archive must not restore");
    } finally {
      clearInterval(writer);
      if (db?.isOpen) db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

test(
  "a restore returns databases at any depth and leaves the persistence keys exactly as backed up",
  { skip: missingWithRedis.length > 0 && `needs ${missingWithRedis.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const port = await freePort();
    const redis = spawn(
      "redis-server",
      ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"],
      { stdio: "ignore" },
    );
    const cli = async (...args) =>
      (await run("redis-cli", ["-h", "127.0.0.1", "-p", String(port), ...args])).stdout.trim();
    const persistenceKeys = async () =>
      (await cli("--scan", "--pattern", "conclave:sfu:persistence*")).split("\n").filter(Boolean).sort();
    try {
      for (let i = 0; i < 50 && (await cli("PING").catch(() => "")) !== "PONG"; i += 1) {
        await new Promise((done) => setTimeout(done, 100));
      }
      const { state, repo, config, backup, latestArchive, restore } = await setUp(root, [
        `SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${port}/0`,
      ]);
      // The SFU's database one level down, named the way the compose file
      // passes it: a path inside the container's mount of the state dir.
      await writeFile(
        path.join(repo, ".env"),
        "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/data/conclave.sqlite\n",
      );
      await mkdir(path.join(state, "data"));
      const db = new DatabaseSync(path.join(state, "data", "conclave.sqlite"));
      db.exec("CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY, title TEXT)");
      db.exec("INSERT INTO scheduled_webinars VALUES ('w1', 'Webinar 1')");
      db.close();
      await cli("HSET", "conclave:sfu:persistence:scheduled-meetings", "m1", '{"id":"m1"}');
      await cli("SET", "conclave:sfu:rooms:lease-before", "sfu-a");

      await backup("--local-only");

      // What the SFUs write between the backup and the restore.
      await cli("HSET", "conclave:sfu:persistence:scheduled-meetings", "m2", '{"id":"m2"}');
      await cli("SET", "conclave:sfu:persistence:scheduling:snapshot", "{}");
      await cli("SET", "conclave:sfu:rooms:lease-after", "sfu-b");
      await rm(path.join(state, "data"), { recursive: true });

      await restore("--file", await latestArchive(), "--yes");

      const restored = new DatabaseSync(path.join(state, "data", "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(
        restored.prepare("SELECT id FROM scheduled_webinars").all().map((row) => row.id),
        ["w1"],
      );
      restored.close();
      assert.deepEqual(await persistenceKeys(), ["conclave:sfu:persistence:scheduled-meetings"]);
      assert.equal(await cli("HKEYS", "conclave:sfu:persistence:scheduled-meetings"), "m1");
      assert.equal(await cli("GET", "conclave:sfu:rooms:lease-before"), "sfu-a");
      assert.equal(await cli("GET", "conclave:sfu:rooms:lease-after"), "sfu-b");

      // A database the containers keep outside the state dir is not on the
      // volume, so the backup must fail rather than skip it.
      await writeFile(path.join(repo, ".env"), "CONCLAVE_SQLITE_PATH=/app/packages/sfu/data/conclave.sqlite\n");
      await assert.rejects(backup("--local-only"), /outside the state dir/);

      // The Redis step cannot reach a TLS Redis, so the restore must refuse
      // before it replaces any file.
      await writeFile(path.join(repo, ".env"), "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/data/conclave.sqlite\n");
      await writeFile(config, `${await readFile(config, "utf8")}\nSFU_PERSISTENCE_REDIS_URL=rediss://127.0.0.1:${port}/0\n`);
      const live = new DatabaseSync(path.join(state, "data", "conclave.sqlite"));
      live.exec("INSERT INTO scheduled_webinars VALUES ('w2', 'Webinar 2')");
      live.close();
      await assert.rejects(restore("--file", await latestArchive(), "--yes"), /TLS/);
      const untouched = new DatabaseSync(path.join(state, "data", "conclave.sqlite"), { readOnly: true });
      assert.equal(untouched.prepare("SELECT count(*) AS n FROM scheduled_webinars").get().n, 2);
      untouched.close();
    } finally {
      redis.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a failed upload keeps the night's archive within the local retention and sends no heartbeat",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    // One stand-in for the managed identity, the storage account (down) and
    // the heartbeat check.
    const hits = { token: 0, upload: 0, heartbeat: 0 };
    const azure = createHttpServer((req, res) => {
      if (req.url.startsWith("/metadata/identity/oauth2/token")) {
        hits.token += 1;
        res.end(JSON.stringify({ access_token: "token", expires_in: "3599" }));
      } else if (req.url.startsWith("/heartbeat")) {
        hits.heartbeat += 1;
        res.end("ok");
      } else {
        hits.upload += 1;
        req.resume();
        res.writeHead(503).end();
      }
    });
    await new Promise((done) => azure.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${azure.address().port}`;
    try {
      const { state, local, backup } = await setUp(root, [
        "AZURE_STORAGE_ACCOUNT=devstoreaccount1",
        "AZURE_STORAGE_CONTAINER=sfu-backups",
        `AZURE_BLOB_ENDPOINT=${origin}/devstoreaccount1`,
        `AZURE_IMDS_ENDPOINT=${origin}`,
        `BACKUP_HEARTBEAT_URL=${origin}/heartbeat`,
      ]);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY)");
      db.close();
      // Four earlier nights whose uploads failed too.
      const earlier = ["20260101", "20260102", "20260103", "20260104"].map((day) => `conclave-test-${day}T000000Z.tar.gz.age`);
      for (const name of earlier) await writeFile(path.join(local, name), "earlier");

      await assert.rejects(backup(), /upload of daily\/.* failed with HTTP 503/);
      assert.equal(hits.upload, 1);
      assert.equal(hits.heartbeat, 0, "a failed backup must not send the heartbeat");
      const kept = (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age")).sort();
      assert.equal(kept.length, 3, "BACKUP_LOCAL_KEEP (3) holds after a failed upload");
      assert.deepEqual(kept.slice(0, 2), earlier.slice(2), "the oldest archives go first");
      assert.ok(!earlier.includes(kept[2]), "tonight's archive is kept");
    } finally {
      azure.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a database the SFU opens through a symlink comes back with its link",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, repo, backup, latestArchive, restore } = await setUp(root);
      await writeFile(path.join(repo, ".env"), "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/conclave.sqlite\n");
      await mkdir(path.join(state, "data"));
      for (const [file, row] of [["live.sqlite", "w1"], ["sched.db", "s1"]]) {
        const db = new DatabaseSync(path.join(state, "data", file));
        db.exec("CREATE TABLE rows (id TEXT PRIMARY KEY)");
        db.prepare("INSERT INTO rows VALUES (?)").run(row);
        db.close();
      }
      // The path the SFU opens, linked relatively; and one linked through the
      // container's mount path to a file that does not end in .sqlite.
      await symlink("data/live.sqlite", path.join(state, "conclave.sqlite"));
      await symlink("/var/lib/conclave/recordings/data/sched.db", path.join(state, "scheduling.sqlite"));

      await backup("--local-only");
      const archive = await latestArchive();
      const listing = (await run("sh", ["-c", `age --decrypt -i "$1" "$2" | tar -xzOf - ./state-files.tar | tar -tf -`, "sh", path.join(root, "key.txt"), archive])).stdout;
      assert.ok(!listing.includes("sched.db"), "the database reached through a link is not also copied raw");

      await rm(state, { recursive: true });
      await restore("--file", archive, "--yes");
      assert.equal(await readlink(path.join(state, "conclave.sqlite")), "data/live.sqlite");
      // Recreated relative: it reaches the same file in the container and on the host.
      assert.equal(await readlink(path.join(state, "scheduling.sqlite")), "data/sched.db");
      const throughLink = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(throughLink.prepare("SELECT id FROM rows").all().map((row) => row.id), ["w1"]);
      throughLink.close();
      const sched = new DatabaseSync(path.join(state, "data", "sched.db"), { readOnly: true });
      assert.deepEqual(sched.prepare("SELECT id FROM rows").all().map((row) => row.id), ["s1"]);
      sched.close();

      // A link whose file is not on the volume cannot be backed up.
      await symlink("/opt/elsewhere/conclave.sqlite", path.join(state, "other.sqlite"));
      await assert.rejects(backup("--local-only"), /other\.sqlite does not lead to a file inside the state dir/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a restore that cannot hand the files to the SFU's user says so",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY)");
      db.close();
      await backup("--local-only");
      const archive = await latestArchive();

      // Settled before anything changes: a user without a group.
      await assert.rejects(restore("--file", archive, "--yes", "--owner", "node"), /cannot tell which user the SFU runs as/);
      assert.deepEqual((await readdir(state)).filter((name) => name.includes("pre-restore")), []);

      if (process.getuid() !== 0) {
        // Only root can hand files to another user; refused up front.
        await assert.rejects(restore("--file", archive, "--yes", "--owner", "0:0"), /only root can give the restored files to 0:0/);
        assert.deepEqual((await readdir(state)).filter((name) => name.includes("pre-restore")), []);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "the configured database gets the online backup whatever its name",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    let db;
    try {
      const { state, repo, backup, latestArchive, restore } = await setUp(root);
      await writeFile(path.join(repo, ".env"), "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/live.db\n");
      // Open in WAL mode, as the SFU holds it, so committed rows sit in the WAL.
      db = new DatabaseSync(path.join(state, "live.db"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY)");
      for (const id of ["w1", "w2", "w3"]) db.prepare("INSERT INTO scheduled_webinars VALUES (?)").run(id);

      await backup("--local-only");
      db.close();
      const archive = await latestArchive();
      const members = (await run("sh", ["-c", `age --decrypt -i "$1" "$2" | tar -tzf -`, "sh", path.join(root, "key.txt"), archive])).stdout;
      assert.match(members, /\.\/sqlite\/live\.db\n/, "the configured database is in the SQLite copies");
      const files = (await run("sh", ["-c", `age --decrypt -i "$1" "$2" | tar -xzOf - ./state-files.tar | tar -tf -`, "sh", path.join(root, "key.txt"), archive])).stdout;
      assert.ok(!files.includes("live.db"), "and not copied raw with its WAL");
      const dryRun = await restore("--file", archive);
      assert.match(dryRun.stdout, /sqlite\.live\.db\.scheduled_webinars=3/);

      await rm(state, { recursive: true });
      await restore("--file", archive, "--yes", "--only", "sqlite");
      const restored = new DatabaseSync(path.join(state, "live.db"), { readOnly: true });
      assert.deepEqual(restored.prepare("SELECT id FROM scheduled_webinars ORDER BY id").all().map((row) => row.id), ["w1", "w2", "w3"]);
      restored.close();
    } finally {
      if (db?.isOpen) db.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "the SFU container's named user:group is settled as ids from its image, not host accounts",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, config, env, backup, latestArchive, restore } = await setUp(root);
      // No owner configured, so restore.sh asks the SFU container.
      await writeFile(config, `${await readFile(config, "utf8")}\nBACKUP_RESTORE_OWNER=\n`);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE scheduled_webinars (id TEXT PRIMARY KEY)");
      db.close();
      await backup("--local-only");
      const archive = await latestArchive();

      // A stand-in docker: one stopped SFU container mounting the state dir,
      // running as node:node, an account this host does not have. Inside its
      // image node resolves to this test's own ids, the one owner a non-root
      // restore can hand files to.
      const bin = path.join(root, "owner-bin");
      await mkdir(bin);
      // Inside the image node is an id this runner can hand files to and
      // never 0: its own as a normal user, any as root.
      const uid = process.getuid() === 0 ? 4242 : process.getuid();
      const gid = process.getuid() === 0 ? 4242 : process.getgid();
      await writeFile(
        path.join(bin, "docker"),
        [
          "#!/bin/sh",
          'case "$*" in',
          '  "ps -aq") echo sfu-a ;;',
          `  "inspect sfu-a") echo '[{"Id":"sfu-a","State":{"Status":"exited"},"Config":{"Env":[],"User":"node:node"},"Image":"sha256:sfu-image","Mounts":[{"Type":"bind","Source":"${state}"}]}]' ;;`,
          `  *Mounts*) echo "${state}" ;;`,
          '  *Config.User*) echo node:node ;;',
          '  *"{{.Image}}"*) echo sha256:sfu-image ;;',
          `  "run --rm --entrypoint id sha256:sfu-image -u node") echo ${uid} ;;`,
          `  "run --rm --entrypoint getent sha256:sfu-image group node") echo node:x:${gid}: ;;`,
          "  *) exit 1 ;;",
          "esac",
        ].join("\n"),
      );
      await chmod(path.join(bin, "docker"), 0o755);

      const result = await run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", archive, "--yes"], {
        env: { ...env, PATH: `${bin}:${env.PATH}` },
      });
      assert.match(result.stdout, new RegExp(`Gave the restored files in .* to ${uid}:${gid}, the user the SFU runs as`));

      // An owner given by name that this host does not know is refused
      // before any file changes.
      await assert.rejects(restore("--file", archive, "--yes", "--owner", "node:node"), /cannot tell which user the SFU runs as/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an sqlite-only restore brings back the whole chain of links to the database",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      const db = new DatabaseSync(path.join(state, "target.db"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('m1');");
      db.close();
      // conclave.sqlite -> current -> target.db, as in Sol's probe.
      await symlink("target.db", path.join(state, "current"));
      await symlink("current", path.join(state, "conclave.sqlite"));
      await backup("--local-only");
      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--only", "sqlite", "--yes");
      assert.equal(await readlink(path.join(state, "current")), "target.db");
      const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["m1"]);
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a files-only restore installs no link to a database it does not restore",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, repo, backup, latestArchive, restore } = await setUp(root);
      await writeFile(path.join(repo, ".env"), "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/live.db\n");
      const db = new DatabaseSync(path.join(state, "target.db"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('m1');");
      db.close();
      await symlink("target.db", path.join(state, "live.db"));
      await writeFile(path.join(state, "booking-links.json"), "{}");
      await backup("--local-only");
      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--only", "files", "--yes");
      assert.equal(await readFile(path.join(state, "booking-links.json"), "utf8"), "{}");
      assert.deepEqual((await readdir(state)).filter((name) => name === "live.db" || name === "target.db"), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "--latest takes the newest archive by its timestamp, whatever the host is called",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    // Sol's case: the host was renamed between the two archives.
    const older = "daily/2026/11/conclave-zeta-20261101T030000Z.tar.gz.age";
    const newer = "daily/2026/11/conclave-alpha-20261122T030000Z.tar.gz.age";
    const fetched = [];
    let payload = Buffer.alloc(0);
    const blob = createHttpServer((req, res) => {
      if (req.url.startsWith("/metadata/")) return res.end('{"access_token":"token"}');
      if (req.url.includes("comp=list")) return res.end(`<Blobs><Blob><Name>${newer}</Name></Blob><Blob><Name>${older}</Name></Blob></Blobs>`);
      fetched.push(req.url);
      res.end(payload);
    });
    await new Promise((done) => blob.listen(0, "127.0.0.1", done));
    try {
      const origin = `http://127.0.0.1:${blob.address().port}`;
      const { state, backup, latestArchive, restore } = await setUp(root, [
        "AZURE_STORAGE_CONTAINER=sfu-backups",
        `AZURE_BLOB_ENDPOINT=${origin}`,
        `AZURE_IMDS_ENDPOINT=${origin}`,
      ]);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
      db.close();
      await backup("--local-only");
      payload = await readFile(await latestArchive());
      await restore("--latest");
      assert.deepEqual(fetched, [`/sfu-backups/${newer}`]);
    } finally {
      await new Promise((done) => blob.close(done));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "local retention keeps the newest archives by timestamp, whatever the host is called",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, local, backup } = await setUp(root, ["BACKUP_LOCAL_KEEP=2"]);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
      db.close();
      // Older archives from a host whose name sorts after this one's.
      for (const day of ["20261101", "20261102"]) await writeFile(path.join(local, `conclave-zeta-${day}T030000Z.tar.gz.age`), "older");
      await backup("--local-only");
      const kept = (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age"));
      assert.equal(kept.length, 2);
      assert.ok(kept.includes("conclave-zeta-20261102T030000Z.tar.gz.age"), kept.join(" "));
      assert.ok(kept.some((name) => name.startsWith("conclave-test-")), "tonight's archive is kept");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "SQLite and Redis come back from one point in time while an SFU keeps writing",
  { skip: missingWithRedis.length > 0 && `needs ${missingWithRedis.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const port = await freePort();
    const redis = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly no"], { stdio: "ignore" });
    const cli = async (...args) => (await run("redis-cli", ["-h", "127.0.0.1", "-p", String(port), ...args])).stdout.trim();
    let writer;
    let sfu;
    let db;
    let redisWriter;
    try {
      for (let i = 0; i < 50 && (await cli("PING").catch(() => "")) !== "PONG"; i += 1) {
        await new Promise((done) => setTimeout(done, 100));
      }
      // A stand-in SFU that, like the real one, writes each record to both
      // stores and holds its writes while a backup holds the fence.
      const { state, config, setDocker, backup, latestArchive, restore } = await setUp(root, [`SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${port}/0`]);
      db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)");
      redisWriter = spawn("redis-cli", ["-h", "127.0.0.1", "-p", String(port)], { stdio: ["pipe", "pipe", "ignore"] });
      let sent = 0;
      let acked = 0;
      redisWriter.stdout.on("data", (chunk) => (acked += String(chunk).split("\n").filter(Boolean).length));
      let fenced = false;
      let next = 0;
      writer = setInterval(() => {
        if (fenced) return;
        next += 1;
        db.prepare("INSERT INTO records VALUES (?)").run(next);
        redisWriter.stdin.write(`SET conclave:sfu:persistence:record:${next} 1\n`);
        sent += 1;
      }, 50);
      sfu = await fencedSfu({
        onHold: async () => {
          fenced = true;
          while (acked < sent) await new Promise((done) => setTimeout(done, 5));
        },
        onRelease: () => {
          fenced = false;
        },
      });
      await setDocker([sfu.container(state)]);
      await writeFile(config, `${await readFile(config, "utf8")}\nCONCLAVE_SFU_HEALTH_URLS="${sfu.health}"\n`);
      await new Promise((done) => setTimeout(done, 300));

      await backup("--local-only");
      clearInterval(writer);
      redisWriter.stdin.end();
      db.close();
      await sfu.close();
      await setDocker([{ ...sfu.container(state), status: "exited" }]);
      sfu = null;
      await writeFile(config, `${await readFile(config, "utf8")}\nCONCLAVE_SFU_HEALTH_URLS="http://127.0.0.1:9/health"\n`);

      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--yes");
      const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      const rows = restored.prepare("SELECT id FROM records ORDER BY id").all().map((row) => row.id);
      restored.close();
      const keys = (await cli("--scan", "--pattern", "conclave:sfu:persistence:record:*"))
        .split("\n")
        .filter(Boolean)
        .map((key) => Number(key.split(":").at(-1)))
        .sort((a, b) => a - b);
      assert.ok(rows.length > 0);
      assert.deepEqual(keys, rows, "both stores must hold the same records");
    } finally {
      clearInterval(writer);
      redisWriter?.kill();
      if (db?.isOpen) db.close();
      if (sfu) await sfu.close();
      redis.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an SFU that answers but will not hold the write fence stops the backup",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    // An SFU from before the fence existed: it answers, with 404.
    const older = createHttpServer((req, res) => res.writeHead(req.url === "/health" ? 200 : 404).end());
    await new Promise((done) => older.listen(0, "127.0.0.1", done));
    try {
      const { state, local, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="http://127.0.0.1:${older.address().port}/health"`]);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
      db.close();
      await assert.rejects(backup("--local-only"), /did not hold the write fence \(HTTP 404\)/);
      assert.deepEqual((await readdir(local)).filter((name) => name.endsWith(".tar.gz.age")), []);
    } finally {
      await new Promise((done) => older.close(done));
      await rm(root, { recursive: true, force: true });
    }
  },
);

// An SFU that answers /health but whose fence request gets no answer, on a
// port no stopped container has.
const silentFence = async () => {
  const server = createHttpServer((req, res) => (req.url === "/health" ? res.end('{"status":"healthy"}') : req.socket.destroy()));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { health: `http://127.0.0.1:${server.address().port}/health`, close: () => new Promise((done) => server.close(done)) };
};

const archives = async (local) => (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age"));

const withDatabase = (state) => {
  const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
  db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
  db.close();
};

test(
  "a live SFU whose fence request gets no answer stops the backup",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const sfu = await silentFence();
    try {
      const { state, local, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
      withDatabase(state);
      await assert.rejects(backup("--local-only"), /gave no fence answer, and Docker lists no stopped SFU container on port \d+/);
      assert.deepEqual(await archives(local), []);
    } finally {
      await sfu.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a silent health URL is no proof: an SFU container Docker reports running stops the backup",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, local, setDocker, backup } = await setUp(root);
      withDatabase(state);
      await setDocker([{ id: "sfu-a", mounts: [state], status: "running", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
      await assert.rejects(backup("--local-only"), /sfu-a \(sfu-a\) is running but does not hold the write fence/);
      await setDocker({ fail: true });
      await assert.rejects(backup("--local-only"), /Docker cannot list the SFU containers/);
      assert.deepEqual(await archives(local), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a second backup on the host refuses to start while one runs",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    let holder;
    try {
      const { state, local, env, backup } = await setUp(root);
      withDatabase(state);
      await mkdir(local, { recursive: true });
      holder = spawn("bash", ["-c", 'exec 8>>"$1"; flock -n 8 && echo locked && exec sleep 30', "_", path.join(local, ".backup.lock")], { env });
      await new Promise((done) => holder.stdout.once("data", done));
      await assert.rejects(backup("--local-only"), /another backup or restore is running on this host/);
      assert.deepEqual(await archives(local), []);
    } finally {
      holder?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a backup whose SFU lost the hold before both copies were taken archives nothing",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const sfu = await fencedSfu({ forgetHold: true });
    try {
      const { state, local, setDocker, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
      withDatabase(state);
      await setDocker([sfu.container(state)]);
      await assert.rejects(backup("--local-only"), /no longer holds this backup's write fence/);
      assert.deepEqual(await archives(local), []);
    } finally {
      await sfu.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a backup holds, renews and releases the fence with its own owner token only",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const sfu = await fencedSfu();
    try {
      const { state, local, setDocker, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
      withDatabase(state);
      await setDocker([sfu.container(state)]);
      await backup("--local-only");
      assert.equal((await archives(local)).length, 1);
      const owners = new Set(sfu.requests.map((request) => request.owner));
      assert.equal(owners.size, 1, "one owner token for the whole run");
      assert.match([...owners][0], /^backup-[0-9a-f]{24}$/);
      assert.deepEqual(
        sfu.requests.map((request) => `${request.method}${request.renew ? " renew" : ""}`),
        ["POST", "POST renew", "POST renew", "DELETE"],
      );
    } finally {
      await sfu.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a database reached through a directory link comes back where it lives, with every link on the way",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      // conclave.sqlite -> current/live.db, and current -> data.
      await mkdir(path.join(state, "data"));
      const db = new DatabaseSync(path.join(state, "data", "live.db"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('kept')");
      db.close();
      await writeFile(path.join(state, "data", "notes.json"), "{}");
      await symlink("data", path.join(state, "current"));
      await symlink("current/live.db", path.join(state, "conclave.sqlite"));
      await backup("--local-only");
      const archive = await latestArchive();
      const check = async () => {
        assert.equal(await readlink(path.join(state, "current")), "data");
        assert.equal(await readlink(path.join(state, "conclave.sqlite")), "current/live.db");
        const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
        assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["kept"]);
        restored.close();
      };

      for (const only of [[], ["--only", "sqlite"]]) {
        await rm(state, { recursive: true });
        await restore("--file", archive, ...only, "--yes");
        await check();
      }
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8").catch(() => "missing"), "missing", "sqlite-only leaves the other files out");
      await rm(state, { recursive: true });
      await restore("--file", archive, "--yes");
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8"), "{}");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "the configured database behind a directory link is copied where it really lives",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root, [
        "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/current/conclave.sqlite",
      ]);
      await mkdir(path.join(state, "data"));
      const db = new DatabaseSync(path.join(state, "data", "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('kept')");
      db.close();
      await symlink("data", path.join(state, "current"));
      await backup("--local-only");
      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--yes");
      assert.equal(await readlink(path.join(state, "current")), "data");
      const restored = new DatabaseSync(path.join(state, "current", "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["kept"]);
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "staging's Redis data sits beside the staging SFU's state dir, so a backup and restore there never touch it",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    // The host paths staging's compose file mounts, at their defaults.
    const compose = await readFile(path.join(scripts, "..", "..", "docker-compose.sfu-staging.yml"), "utf8");
    const hostPath = (target) => {
      const entry = compose.split("\n").map((line) => line.trim()).find((line) => line.startsWith("- ") && line.endsWith(`:${target}`));
      return entry.slice(2, -(target.length + 1)).replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1");
    };
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const state = path.join(root, hostPath("/var/lib/conclave/recordings"));
      const redisData = path.join(root, hostPath("/data"));
      const { setDocker, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_STATE_DIR=${state}`]);
      await setDocker([{ id: "sfu-staging", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-staging"] }]);
      await mkdir(path.join(redisData, "appendonlydir"), { recursive: true });
      await mkdir(state, { recursive: true });
      const redisFiles = ["dump.rdb", "appendonlydir/appendonly.aof.1.incr.aof"];
      for (const file of redisFiles) await writeFile(path.join(redisData, file), `redis ${file}`);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
      db.close();
      const before = await Promise.all(redisFiles.map((file) => stat(path.join(redisData, file))));

      // A backup, a restore over the live dir, and one into a lost dir.
      await backup("--local-only");
      const archive = await latestArchive();
      await restore("--file", archive, "--yes");
      await rm(state, { recursive: true });
      await restore("--file", archive, "--yes");

      const after = await Promise.all(redisFiles.map((file) => stat(path.join(redisData, file))));
      assert.deepEqual(after.map((s) => [s.ino, s.ctimeMs, s.uid, s.gid]), before.map((s) => [s.ino, s.ctimeMs, s.uid, s.gid]), "nothing in Redis's dir was touched, chown included");
      for (const file of redisFiles) assert.equal(await readFile(path.join(redisData, file), "utf8"), `redis ${file}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a copy that finishes with under 2 s of the hold left archives nothing",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    // A hold that runs out 1.5 s after it is granted.
    const sfu = await fencedSfu({ reportUntil: () => Date.now() + 1_500 });
    try {
      const { state, local, setDocker, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
      withDatabase(state);
      await setDocker([sfu.container(state)]);
      await assert.rejects(backup("--local-only"), /only -?\d+ ms of the write fence was left when the copy finished \(at least 2000 ms needed\)/);
      assert.deepEqual(await archives(local), []);
    } finally {
      await sfu.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a state dir named through a symlink still finds the SFU containers that mount its target",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const sfu = await fencedSfu({ instanceId: "sfu-a" });
    try {
      // Compose mounts real-state; the backup is configured with a link to it.
      const real = path.join(root, "real-state");
      const linked = path.join(root, "state-link");
      await mkdir(real);
      await symlink(real, linked);
      const { local, setDocker, backup } = await setUp(root, [`CONCLAVE_STATE_DIR=${linked}`]);
      withDatabase(linked);

      // The SFU is stopped and its health URL silent: the backup goes ahead.
      await setDocker([{ id: "sfu-a", mounts: [real], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
      await backup("--local-only");
      assert.equal((await archives(local)).length, 1);

      // A running SFU that mounts the target but is not configured, and so
      // holds no fence, stops it.
      await writeFile(path.join(root, "backup.env"), `${await readFile(path.join(root, "backup.env"), "utf8")}\nCONCLAVE_SFU_HEALTH_URLS="${sfu.health}"\n`);
      await setDocker([
        sfu.container(real),
        { id: "sfu-b", mounts: [real], status: "running", env: ["SFU_PORT=1", "SFU_INSTANCE_ID=sfu-b"] },
      ]);
      await assert.rejects(backup("--local-only"), /the SFU container sfu-b \(sfu-b\) is running but does not hold the write fence/);

      // An SFU container whose mount does not resolve may be writing here.
      await setDocker([
        sfu.container(real),
        { id: "sfu-c", mounts: [path.join(root, "gone")], status: "running", env: ["SFU_PORT=2", "SFU_INSTANCE_ID=sfu-c"] },
      ]);
      await assert.rejects(backup("--local-only"), /cannot tell whether the SFU container sfu-c \(sfu-c\) mounts the state dir/);
      assert.equal((await archives(local)).length, 1);
    } finally {
      await sfu.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a restore into a lost state dir still asks the stopped SFU container which user to give the files to",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, config, setDocker, backup, latestArchive, restore } = await setUp(root);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('kept')");
      db.close();
      await backup("--local-only");
      const archive = await latestArchive();

      // The disaster: the state dir is gone, the SFU container still listed
      // and stopped, and no owner configured. Its user is an id this runner
      // can hand files to and never 0: its own as a normal user, any as root.
      await rm(state, { recursive: true });
      await writeFile(config, `${await readFile(config, "utf8")}\nBACKUP_RESTORE_OWNER=\n`);
      const uid = process.getuid() === 0 ? 4242 : process.getuid();
      const gid = process.getuid() === 0 ? 4242 : process.getgid();
      await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"], user: `${uid}:${gid}` }]);

      const result = await restore("--file", archive, "--yes");
      assert.match(result.stdout, new RegExp(`Gave the restored files in .* to ${uid}:${gid}, the user the SFU runs as`));
      const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["kept"]);
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// A Redis on a free port and a counter for heartbeat pings, for the cases
// where Redis alone must not make a backup look complete.
const redisAndHeartbeat = async () => {
  const port = await freePort();
  const server = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly no"], { stdio: "ignore" });
  const cli = (...args) => run("redis-cli", ["-h", "127.0.0.1", "-p", String(port), ...args]);
  for (let i = 0; i < 50 && (await cli("PING").then((r) => r.stdout.trim(), () => "")) !== "PONG"; i += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  await cli("SET", "conclave:sfu:persistence:scheduled-meetings", "x");
  let pings = 0;
  const heartbeat = createHttpServer((_req, res) => {
    pings += 1;
    res.end("ok");
  });
  await new Promise((done) => heartbeat.listen(0, "127.0.0.1", done));
  return {
    config: [`SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${port}/0`, `BACKUP_HEARTBEAT_URL=http://127.0.0.1:${heartbeat.address().port}/ping`],
    pings: () => pings,
    close: async () => {
      server.kill();
      await new Promise((done) => heartbeat.close(done));
    },
  };
};

test(
  "a backup of a state dir that does not exist fails, even with Redis configured and the SFUs fenced",
  { skip: missingWithRedis.length > 0 && `needs ${missingWithRedis.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const extras = await redisAndHeartbeat();
    const sfu = await fencedSfu();
    try {
      const gone = path.join(root, "gone");
      const { local, setDocker, backup } = await setUp(root, [
        `CONCLAVE_STATE_DIR=${gone}`,
        `CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`,
        ...extras.config,
      ]);
      await setDocker([sfu.container(gone)]);
      await assert.rejects(backup("--local-only"), /the state dir .*gone does not exist/);
      assert.deepEqual(await archives(local).catch(() => []), []);
      assert.equal(extras.pings(), 0, "no heartbeat");
    } finally {
      await sfu.close();
      await extras.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a backup whose configured database is missing fails with no heartbeat and rotates nothing away",
  { skip: missingWithRedis.length > 0 && `needs ${missingWithRedis.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const extras = await redisAndHeartbeat();
    const sfu = await fencedSfu();
    try {
      const { state, local, setDocker, backup, latestArchive } = await setUp(root, [
        `CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`,
        "BACKUP_LOCAL_KEEP=2",
        ...extras.config,
      ]);
      await setDocker([sfu.container(state)]);
      // Two complete nights already on disk.
      withDatabase(state);
      await backup("--local-only");
      const complete = await latestArchive();
      const kept = ["conclave-test-20260101T000000Z.tar.gz.age", "conclave-test-20260102T000000Z.tar.gz.age"];
      await copyFile(complete, path.join(local, kept[0]));
      await copyFile(complete, path.join(local, kept[1]));
      await rm(complete);
      const before = extras.pings();

      // Tonight the SFU's database (the compose default, conclave.sqlite) is gone.
      await rm(path.join(state, "conclave.sqlite"));
      await assert.rejects(backup("--local-only"), /the configured database .*conclave\.sqlite is missing/);
      assert.deepEqual((await archives(local)).sort(), kept, "both complete archives stay");
      assert.equal(extras.pings(), before, "no heartbeat");
    } finally {
      await sfu.close();
      await extras.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an SFU that a deploy starts between the copies stops the backup, even when no SFU held the fence",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, local, setDocker, backup } = await setUp(root);
      withDatabase(state);
      // Stopped through the checks before the copies (the preflight, the
      // fence and the copy's own look), running from the check after them.
      await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"], runningAfterChecks: 3 }]);
      await assert.rejects(backup("--local-only"), /the SFU container sfu-a \(sfu-a\) is running but does not hold the write fence/);
      assert.deepEqual(await archives(local), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a backup holds the host's deploy lock, and a deploy holding it past the wait stops the backup",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    let deploy;
    try {
      const { state, local, env, backup } = await setUp(root, ["BACKUP_DEPLOY_LOCK_WAIT_SECONDS=1"]);
      withDatabase(state);
      deploy = spawn("bash", ["-c", 'exec 9>>"$1"; flock -n 9 && echo locked && exec sleep 30', "_", path.join(root, "deploy.lock")], { env });
      await new Promise((done) => deploy.stdout.once("data", done));
      await assert.rejects(backup("--local-only"), /an SFU deploy held .*deploy\.lock for 1s/);
      assert.deepEqual(await archives(local), []);
      // The deploy ends; the next backup runs.
      const ended = new Promise((done) => deploy.once("exit", done));
      deploy.kill();
      await ended;
      deploy = null;
      await backup("--local-only");
      assert.equal((await archives(local)).length, 1);
    } finally {
      deploy?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a restore refuses to write through a directory link on disk that leads outside the state dir",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root, ["CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/data/live.db"]);
      await mkdir(path.join(state, "data"));
      const db = new DatabaseSync(path.join(state, "data", "live.db"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('kept')");
      db.close();
      await writeFile(path.join(state, "data", "notes.json"), "{}");
      await backup("--local-only");
      const archive = await latestArchive();

      // Since the backup, data has become a link to a directory elsewhere.
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await rm(path.join(state, "data"), { recursive: true });
      await symlink(outside, path.join(state, "data"));
      await assert.rejects(restore("--file", archive, "--yes"), /data is a link in the state dir, and a restore never writes through a link/);
      assert.deepEqual(await readdir(outside), [], "nothing was written outside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a restore recreates only recorded links that stay inside the state dir",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await backup("--local-only");

      // An archive whose recorded links were changed to include one that
      // leads out of the state dir, with checksums to match.
      const tampered = await withExtraLink(root, await latestArchive(), `escape\t${path.join(root, "elsewhere")}`, path.join(root, "local", "conclave-test-20260101T000000Z.tar.gz.age"));
      await rm(state, { recursive: true });
      await assert.rejects(restore("--file", tampered, "--only", "sqlite", "--yes"), /the recorded link escape leads outside the state dir/);
      assert.equal(await readlink(path.join(state, "escape")).catch(() => "absent"), "absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Resolves once at least count processes hold path open: the holder, and
// the run that now waits on it.
const openedBy = async (path_, count) => {
  for (let i = 0; i < 400; i += 1) {
    const pids = await run("lsof", ["-t", path_]).then((r) => r.stdout.split("\n").filter(Boolean), () => []);
    if (pids.length >= count) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${path_} was never opened by ${count} processes`);
};

test(
  "a backup that waited on a deploy lock file replaced meanwhile does not run on the old one",
  { skip: (missing.length > 0 && `needs ${missing.join(", ")} on PATH`) || (!hasTool("lsof") && "needs lsof on PATH") },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    let deploy;
    try {
      const { state, local, env, backup } = await setUp(root, ["BACKUP_DEPLOY_LOCK_WAIT_SECONDS=20"]);
      withDatabase(state);
      const lock = path.join(root, "deploy.lock");
      deploy = spawn("bash", ["-c", 'exec 9>>"$1"; flock -n 9 && echo locked && exec sleep 30', "_", lock], { env });
      await new Promise((done) => deploy.stdout.once("data", done));
      const running = backup("--local-only");
      running.catch(() => undefined);
      // While the backup waits, the lock file is replaced, then the deploy ends.
      await openedBy(lock, 2);
      await rm(lock);
      await writeFile(lock, "");
      deploy.kill();
      await assert.rejects(running, /deploy\.lock was replaced while this run waited for it/);
      assert.deepEqual(await archives(local), []);
    } finally {
      deploy?.kill();
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Rewrites an archive the way anyone with the age public key could, with
// checksums to match (scripts/test-support/backup-tamper.py).
const tamper = async (root, archive, spec, out) => {
  await run("python3", [
    path.join(scripts, "..", "test-support", "backup-tamper.py"),
    path.join(root, "key.txt"),
    path.join(root, "recipients.txt"),
    archive,
    out,
    JSON.stringify(spec),
  ]);
  return out;
};

// Rewrites an archive with an extra recorded link and checksums to match.
const withExtraLink = (root, archive, line, out) => tamper(root, archive, { append: { "sqlite-links": `${line}\n` } }, out);

test(
  "a populated staging dir whose link names the container's path restores, as it does when empty",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const staging = path.join(root, "conclave-staging");
      const { setDocker, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_STATE_DIR=${staging}`]);
      await mkdir(path.join(staging, "data"), { recursive: true });
      await setDocker([{ id: "sfu-staging", mounts: [staging], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-staging"] }]);
      const db = new DatabaseSync(path.join(staging, "data", "live.db"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY); INSERT INTO meetings VALUES ('kept')");
      db.close();
      // Written for the SFU container, which mounts this dir at /var/lib/conclave/recordings.
      await symlink("/var/lib/conclave/recordings/data/live.db", path.join(staging, "conclave.sqlite"));
      await backup("--local-only");
      const archive = await latestArchive();
      const check = async () => {
        assert.equal(await readlink(path.join(staging, "conclave.sqlite")), "data/live.db", "relative, never a literal host path");
        const restored = new DatabaseSync(path.join(staging, "data", "live.db"), { readOnly: true });
        assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["kept"]);
        restored.close();
      };

      await restore("--file", archive, "--yes");
      await check();
      await rm(staging, { recursive: true });
      await restore("--file", archive, "--yes");
      await check();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a recorded link whose container path still leaves the state dir once mapped is refused",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await backup("--local-only");
      const tampered = await withExtraLink(
        root,
        await latestArchive(),
        "escape\t/var/lib/conclave/recordings/../../../outside",
        path.join(root, "local", "conclave-test-20260101T000000Z.tar.gz.age"),
      );
      await rm(state, { recursive: true });
      await assert.rejects(restore("--file", tampered, "--only", "sqlite", "--yes"), /the recorded link escape leads outside the state dir/);
      assert.equal(await readlink(path.join(state, "escape")).catch(() => "absent"), "absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Rewrites an archive with one more member in its other-files tar (a regular
// file, a symlink or a fifo), checksums to match.
const withExtraMember = (root, archive, { name, type = "file", target = "" }, out) =>
  tamper(root, archive, { inner: [{ name, type, target }] }, out);

test(
  "a crafted member that climbs through a link out of the state dir is refused before anything changes",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await backup("--local-only");
      // alias -> outside/ssl, and outside/resolv.conf is a link the member
      // alias/../resolv.conf would reach.
      const outside = path.join(root, "outside");
      await mkdir(path.join(outside, "ssl"), { recursive: true });
      await writeFile(path.join(outside, "resolver"), "nameserver 127.0.0.53\n");
      await symlink(path.join(outside, "resolver"), path.join(outside, "resolv.conf"));
      await symlink(path.join(outside, "ssl"), path.join(state, "alias"));
      const crafted = await withExtraMember(root, await latestArchive(), { name: "./alias/../resolv.conf" }, path.join(root, "local", "conclave-test-20260101T000000Z.tar.gz.age"));

      await assert.rejects(restore("--file", crafted, "--yes"), /alias\/\.\.\/resolv\.conf is not a plain path inside the archive/);
      assert.equal(await readlink(path.join(outside, "resolv.conf")), path.join(outside, "resolver"), "the outside link is untouched");
      assert.equal(await readFile(path.join(outside, "resolver"), "utf8"), "nameserver 127.0.0.53\n");
      assert.equal(await readlink(path.join(state, "alias")), path.join(outside, "ssl"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an archive whose other files include a link or a special file is refused whole",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await writeFile(path.join(state, "notes.json"), "{}");
      await backup("--local-only");
      const archive = await latestArchive();
      const linked = await withExtraMember(root, archive, { name: "./shortcut", type: "symlink", target: "/etc" }, path.join(root, "linked.tar.gz.age"));
      const fifo = await withExtraMember(root, archive, { name: "./pipe", type: "fifo" }, path.join(root, "fifo.tar.gz.age"));
      await rm(state, { recursive: true });
      await assert.rejects(restore("--file", linked, "--yes"), /shortcut is a link, and the only links a restore makes are the recorded database links/);
      await assert.rejects(restore("--file", fifo, "--yes"), /pipe is not a file or directory/);
      assert.equal(await readFile(path.join(state, "notes.json"), "utf8").catch(() => "absent"), "absent", "nothing was restored");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a stray link or fifo in the state dir is left out of the archive, so it restores",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await mkdir(path.join(state, "data"));
      await writeFile(path.join(state, "data", "notes.json"), "{}");
      await symlink("data", path.join(state, "shortcut"));
      await run("mkfifo", [path.join(state, "pipe")]);
      await backup("--local-only");
      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--yes");
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8"), "{}");
      assert.equal(await readlink(path.join(state, "shortcut")).catch(() => "absent"), "absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a crafted link to the container's path, on a host where that folder exists, cannot reach it",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      // Another SFU's folder on this host, at the path the containers mount.
      const other = path.join(root, "recordings");
      await mkdir(other);
      await writeFile(path.join(other, "conclave.sqlite"), "the other SFU's data");
      const { state, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_CONTAINER_STATE_DIR=${other}`]);
      withDatabase(state);
      await backup("--local-only");
      const linked = await withExtraLink(root, await latestArchive(), `alias\t${other}`, path.join(root, "linked.tar.gz.age"));
      const crafted = await withExtraMember(root, linked, { name: "./alias/notes.json" }, path.join(root, "local", "conclave-test-20260101T000000Z.tar.gz.age"));

      await assert.rejects(restore("--file", crafted, "--yes"), /alias\/notes\.json sits under the recorded link alias, and a restore never writes through a link/);
      assert.equal(await readFile(path.join(other, "conclave.sqlite"), "utf8"), "the other SFU's data");
      assert.equal(await readlink(path.join(state, "alias")).catch(() => "absent"), "absent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "two hard-linked names in the state dir back up and restore",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, backup, latestArchive, restore } = await setUp(root);
      withDatabase(state);
      await mkdir(path.join(state, "data"));
      await writeFile(path.join(state, "data", "notes.json"), "{\"kept\":true}");
      await run("ln", [path.join(state, "data", "notes.json"), path.join(state, "data", "notes-copy.json")]);
      await backup("--local-only");
      await rm(state, { recursive: true });
      await restore("--file", await latestArchive(), "--yes");
      for (const name of ["notes.json", "notes-copy.json"]) {
        assert.equal(await readFile(path.join(state, "data", name), "utf8"), "{\"kept\":true}");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a backup that would not restore fails and keeps the previous archives",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const { state, local, backup } = await setUp(root);
      withDatabase(state);
      await backup("--local-only");
      const before = await archives(local);
      assert.equal(before.length, 1);
      // A name a restore refuses: a tab cannot round-trip through the archive.
      await writeFile(path.join(state, "bad\tname.json"), "{}");
      await new Promise((done) => setTimeout(done, 1_100));
      await assert.rejects(backup("--local-only"), /bad\tname\.json is not a plain path inside the archive[\s\S]*this backup would not restore/);
      assert.deepEqual(await archives(local), before, "only the earlier archive is kept");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// --- Neon's adversarial review of the restore, each reproduction as a test.

const needs = { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` };
const rows = (file, table = "meetings") => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT id FROM "${table.replaceAll('"', '""')}" ORDER BY id`).all().map((row) => row.id);
  } finally {
    db.close();
  }
};
const makeDb = (file, id, table = "meetings") => {
  const db = new DatabaseSync(file);
  const quoted = `"${table.replaceAll('"', '""')}"`;
  db.exec(`CREATE TABLE ${quoted} (id TEXT PRIMARY KEY)`);
  db.prepare(`INSERT INTO ${quoted} VALUES (?)`).run(id);
  db.close();
};
const innerFiles = async (root, archive) =>
  (await run("python3", ["-c", `import io, subprocess, sys, tarfile
outer = tarfile.open(fileobj=io.BytesIO(subprocess.run(["age", "--decrypt", "-i", sys.argv[1], sys.argv[2]], check=True, capture_output=True).stdout), mode="r:gz")
inner = tarfile.open(fileobj=outer.extractfile("./state-files.tar"))
print("\\n".join(m.name for m in inner))`, path.join(root, "key.txt"), archive])).stdout.split("\n").filter(Boolean);

test("an outer archive whose sqlite dir is a link is refused before anything is read through it", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "kept");
    await backup("--local-only");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    makeDb(path.join(outside, "conclave.sqlite"), "host secret");
    const crafted = await tamper(root, await latestArchive(), { remove: ["./sqlite/conclave.sqlite", "./sqlite"], outer: [{ name: "./sqlite", type: "symlink", target: outside }] }, path.join(root, "crafted.tar.gz.age"));
    await assert.rejects(restore("--file", crafted), /sqlite in the archive is not a regular file or directory/);
    await assert.rejects(restore("--file", crafted, "--yes"), /sqlite in the archive is not a regular file or directory/);
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["kept"], "the host's database never came in");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an outer redis dir that is a link is refused, and the file it names stays", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "dump.rdb"), "a host file");
    const crafted = await tamper(root, await latestArchive(), { outer: [{ name: "./redis", type: "symlink", target: outside }] }, path.join(root, "crafted.tar.gz.age"));
    await assert.rejects(restore("--file", crafted, "--yes"), /redis in the archive is not a regular file or directory/);
    assert.equal(await readFile(path.join(outside, "dump.rdb"), "utf8"), "a host file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a SHA256SUMS that names a path outside the archive is refused, so it is no hash oracle", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    const crafted = await tamper(root, await latestArchive(), { sums: { extra: [`${"0".repeat(64)}  /etc/hosts`] } }, path.join(root, "crafted.tar.gz.age"));
    await assert.rejects(restore("--file", crafted), /SHA256SUMS lists \/etc\/hosts, which is not a plain path inside the archive/);
    const unlisted = await tamper(root, await latestArchive(), { outer: [{ name: "./extra.txt", data: "not in the sums" }], sums: { keep: true } }, path.join(root, "unlisted.tar.gz.age"));
    await assert.rejects(restore("--file", unlisted), /checksums do not match; the archive is damaged: extra\.txt is not in SHA256SUMS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a MANIFEST that is a link is refused before it is read", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, "host secret line");
    const crafted = await tamper(root, await latestArchive(), { remove: ["./MANIFEST"], outer: [{ name: "./MANIFEST", type: "symlink", target: secret }] }, path.join(root, "crafted.tar.gz.age"));
    const refused = await restore("--file", crafted).then(() => null, (error) => error);
    assert.match(String(refused?.stderr), /MANIFEST in the archive is not a regular file or directory/);
    assert.doesNotMatch(`${refused?.stdout}${refused?.stderr}`, /host secret line/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an outer member with an absolute or climbing name is refused", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    for (const name of [path.join(root, "planted"), "./sqlite/../../planted"]) {
      const crafted = await tamper(root, await latestArchive(), { outer: [{ name }] }, path.join(root, "crafted.tar.gz.age"));
      await assert.rejects(restore("--file", crafted, "--yes"), /is not a plain path inside it/);
    }
    assert.equal(await readFile(path.join(root, "planted"), "utf8").catch(() => "absent"), "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a process racing the restore inside the state dir cannot redirect a write outside it", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  let racer;
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await mkdir(path.join(state, "data"));
    for (let i = 0; i < 20; i += 1) await writeFile(path.join(state, "data", `notes-${i}.json`), "{}");
    await backup("--local-only");
    const archive = await latestArchive();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    // Neon's race: whatever appears in the state dir is renamed away and a
    // link to the outside dir put in its place, as fast as possible.
    racer = spawn("python3", ["-c", `import os, sys, time
state, outside = sys.argv[1], sys.argv[2]
seen = set(os.listdir(state))
end = time.time() + 20
while time.time() < end:
    for name in os.listdir(state):
        if name not in seen:
            seen.add(name)
            try:
                os.rename(os.path.join(state, name), os.path.join(state, name + ".raced"))
                os.symlink(outside, os.path.join(state, name))
                seen.update({name + ".raced"})
            except OSError:
                pass`, state, outside], { stdio: "ignore" });
    await rm(path.join(state, "data"), { recursive: true });
    await restore("--file", archive, "--yes").catch(() => undefined);
    racer.kill();
    assert.deepEqual(await readdir(outside), [], "nothing was written outside the state dir");
  } finally {
    racer?.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore refuses a state dir whose parent other users can change, before changing anything", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "before");
    await backup("--local-only");
    await chmod(root, 0o777);
    await assert.rejects(restore("--file", await latestArchive(), "--yes"), /can be changed by users other than its owner, so the restore cannot keep its staging copy private there/);
    await chmod(root, 0o700);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes("restore")), []);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore never touches a file outside through a hard link in the state dir", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await writeFile(path.join(state, "notes.json"), "backed up");
    await backup("--local-only");
    // Since the backup, notes.json has become a second name for a file
    // outside, as Neon's chown-through-a-hard-link probe made it.
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret"), "host secret");
    await chmod(path.join(outside, "secret"), 0o600);
    await rm(path.join(state, "notes.json"));
    await run("ln", [path.join(outside, "secret"), path.join(state, "notes.json")]);
    const before = await stat(path.join(outside, "secret"));
    await restore("--file", await latestArchive(), "--yes");
    const after = await stat(path.join(outside, "secret"));
    assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
    assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "host secret");
    assert.equal(await readFile(path.join(state, "notes.json"), "utf8"), "backed up");
    assert.equal((await stat(path.join(state, "notes.json"))).nlink, 1, "the restored file is a new one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a running container that mounts no SFU_INSTANCE_ID, a dir above, or one inside the state dir stops the backup", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, local, setDocker, backup } = await setUp(root);
    withDatabase(state);
    await mkdir(path.join(state, "data"));
    // Neon: an empty SFU_INSTANCE_ID matched the empty list of held fences.
    await setDocker([{ id: "rogue", mounts: [state], status: "running", env: ["SFU_INSTANCE_ID="] }]);
    await assert.rejects(backup("--local-only"), /the container rogue is running and can write the state dir, but has no SFU_INSTANCE_ID/);
    for (const mount of [root, path.join(state, "data")]) {
      await setDocker([{ id: "nested", mounts: [mount], status: "running", env: ["SFU_PORT=1", "SFU_INSTANCE_ID=sfu-x"] }]);
      await assert.rejects(backup("--local-only"), /the SFU container nested \(sfu-x\) is running but does not hold the write fence/);
    }
    // A read-only mount above the state dir cannot write to it.
    await setDocker([{ id: "reader", mounts: [{ source: root, rw: false }], status: "running", env: [] }, { id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
    await backup("--local-only");
    assert.equal((await archives(local)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two running containers under one SFU_INSTANCE_ID stop the backup, though one holds the fence", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const sfu = await fencedSfu();
  try {
    const { state, local, setDocker, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
    withDatabase(state);
    await setDocker([sfu.container(state), { ...sfu.container(state), id: "twin" }]);
    await assert.rejects(backup("--local-only"), /the containers sfu-a and twin both run as SFU instance sfu-a/);
    await setDocker([sfu.container(state), { ...sfu.container(state), id: "elsewhere", env: ["SFU_PORT=1", "SFU_INSTANCE_ID=sfu-a"] }]);
    await assert.rejects(backup("--local-only"), /the SFU container elsewhere \(sfu-a\) listens on port 1, but the fence answer for sfu-a came from port \d+/);
    assert.deepEqual(await archives(local), []);
  } finally {
    await sfu.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the other files are archived inside the fence, so a write after its release is not in the backup", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  let state;
  const sfu = await fencedSfu({ onRelease: () => writeFile(path.join(state, "late.json"), "{}") });
  try {
    const setup = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
    state = setup.state;
    withDatabase(state);
    await writeFile(path.join(state, "early.json"), "{}");
    await setup.setDocker([sfu.container(state)]);
    await setup.backup("--local-only");
    const files = await innerFiles(root, await setup.latestArchive());
    assert.ok(files.includes("early.json"), files.join(" "));
    assert.ok(!files.includes("late.json"), "late.json was written after the fence was released");
  } finally {
    await sfu.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the host deploy lock is made so no other user can open it, and a lock that is a link is refused", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, local, backup } = await setUp(root);
    withDatabase(state);
    const lock = path.join(root, "deploy.lock");
    await backup("--local-only");
    assert.equal((await stat(lock)).mode & 0o777, 0o640);
    // One made world-writable by an older script is narrowed by its owner.
    // (A second apart: archive names carry the second.)
    await chmod(lock, 0o666);
    await new Promise((done) => setTimeout(done, 1_100));
    await backup("--local-only");
    assert.equal((await stat(lock)).mode & 0o777, 0o640);
    await rm(lock);
    await writeFile(path.join(root, "elsewhere.lock"), "");
    await symlink(path.join(root, "elsewhere.lock"), lock);
    await assert.rejects(backup("--local-only"), /deploy\.lock is a link or not a regular file/);
    assert.equal((await archives(local)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live database's hot journal is moved aside with it, never replayed onto the restored copy", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "backed up");
    await backup("--local-only");
    // A crashed writer left a rollback journal beside the live database.
    await writeFile(path.join(state, "conclave.sqlite-journal"), "a hot journal from before the restore");
    await writeFile(path.join(state, "conclave.sqlite-wal"), "a stale WAL");
    const result = await restore("--file", await latestArchive(), "--yes");
    assert.deepEqual((await readdir(state)).filter((name) => name.startsWith("conclave.sqlite-")), []);
    const aside = result.stdout.match(/kept in (\S+)/)[1];
    assert.deepEqual((await readdir(aside)).sort(), ["conclave.sqlite", "conclave.sqlite-journal", "conclave.sqlite-wal"]);
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["backed up"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore over a live state dir moves aside the side files where a database behind a directory link lives", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root, ["CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/current/conclave.sqlite"]);
    await mkdir(path.join(state, "data"));
    makeDb(path.join(state, "data", "conclave.sqlite"), "backed up");
    await symlink("data", path.join(state, "current"));
    await backup("--local-only");
    await writeFile(path.join(state, "data", "conclave.sqlite-journal"), "a hot journal from before the restore");
    await writeFile(path.join(state, "data", "conclave.sqlite-wal"), "a stale WAL");
    const result = await restore("--file", await latestArchive(), "--yes");
    assert.equal(await readlink(path.join(state, "current")), "data");
    assert.deepEqual((await readdir(path.join(state, "data"))).filter((name) => name.startsWith("conclave.sqlite-")), []);
    const aside = result.stdout.match(/kept in (\S+)/)[1];
    assert.deepEqual((await readdir(path.join(aside, "data"))).sort(), ["conclave.sqlite", "conclave.sqlite-journal", "conclave.sqlite-wal"]);
    assert.deepEqual(rows(path.join(state, "current", "conclave.sqlite")), ["backed up"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a SQLite side file in the archive's other files is refused, whatever it belongs to", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root, ["CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/live.db"]);
    makeDb(path.join(state, "target.db"), "kept");
    await symlink("target.db", path.join(state, "live.db"));
    await backup("--local-only");
    for (const name of ["target.db-wal", "live.db-journal", "other.sqlite-shm"]) {
      const crafted = await tamper(root, await latestArchive(), { inner: [{ name }] }, path.join(root, "crafted.tar.gz.age"));
      await assert.rejects(restore("--file", crafted, "--only", "files", "--yes"), /(is a SQLite side file, and a restore never takes one from the archive|is a database path)/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured database named like a side file is backed up and restored, not skipped", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root, ["CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/store-wal"]);
    makeDb(path.join(state, "store-wal"), "kept");
    await backup("--local-only");
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes");
    assert.deepEqual(rows(path.join(state, "store-wal")), ["kept"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a database name with no room for SQLite's side files fails the backup, and a long one with room restores over itself", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, local, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    const long = `${"l".repeat(233)}.sqlite`;
    makeDb(path.join(state, long), "long");
    await backup("--local-only");
    // Neon: a 224-byte name failed halfway, after the live copy was moved.
    await restore("--file", await latestArchive(), "--yes");
    assert.deepEqual(rows(path.join(state, long)), ["long"]);
    // SQLite itself cannot write a database under a name with no room for
    // its journal, so this one is made under a short name and renamed.
    makeDb(path.join(root, "short.sqlite"), "no room");
    await run("mv", [path.join(root, "short.sqlite"), path.join(state, `${"n".repeat(241)}.sqlite`)]);
    await assert.rejects(backup("--local-only"), /leaves no room for SQLite's -wal\/-shm\/-journal files/);
    assert.equal((await archives(local)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a database link written with the host's own path restores into another state dir, as a restore drill does", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, config, backup, latestArchive, restore } = await setUp(root);
    await mkdir(path.join(state, "data"));
    makeDb(path.join(state, "data", "live.db"), "kept");
    await symlink(path.join(state, "data", "live.db"), path.join(state, "conclave.sqlite"));
    await backup("--local-only");
    const drill = path.join(root, "drill");
    await writeFile(config, `${await readFile(config, "utf8")}\nCONCLAVE_STATE_DIR=${drill}\n`);
    await restore("--file", await latestArchive(), "--yes");
    assert.equal(await readlink(path.join(drill, "conclave.sqlite")), "data/live.db");
    assert.deepEqual(rows(path.join(drill, "conclave.sqlite")), ["kept"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only directory in the state dir is found before the restore changes anything", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "backed up");
    await mkdir(path.join(state, "data"));
    await writeFile(path.join(state, "data", "notes.json"), "backed up");
    await backup("--local-only");
    await writeFile(path.join(state, "data", "notes.json"), "live");
    await chmod(path.join(state, "data"), 0o555);
    if (process.getuid() === 0) {
      await restore("--file", await latestArchive(), "--yes");
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8"), "backed up");
    } else {
      await assert.rejects(restore("--file", await latestArchive(), "--yes"), /the directory that holds data\/notes\.json is not writable by this user/);
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8"), "live", "nothing changed");
      assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["backed up"]);
    }
  } finally {
    await chmod(path.join(root, "state", "data"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("archive paths that collide (a file under a database, a file root, a link twice, case-only twins) are refused", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await symlink("conclave.sqlite", path.join(state, "alias.sqlite"));
    await backup("--local-only");
    const cases = [
      [{ inner: [{ name: "conclave.sqlite/x" }] }, /conclave\.sqlite\/x sits under conclave\.sqlite, which the archive also holds as a file/],
      [{ inner: [{ name: "." }] }, /the root of state-files\.tar is not a directory/],
      [{ append: { "sqlite-links": "alias.sqlite\tconclave.sqlite\n" } }, /the recorded link alias\.sqlite is listed twice/],
      [{ inner: [{ name: "Notes.json" }, { name: "notes.json" }] }, /differ only in case or Unicode form/],
    ];
    for (const [spec, message] of cases) {
      const crafted = await tamper(root, await latestArchive(), spec, path.join(root, "crafted.tar.gz.age"));
      await assert.rejects(restore("--file", crafted, "--yes"), message);
    }
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), [], "nothing was restored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a database whose path holds a quote and spaces, with a table named with a double quote, backs up and restores", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await mkdir(path.join(state, "it's here"));
    makeDb(path.join(state, "it's here", "live db.sqlite"), "odd", 'we"ird');
    await writeFile(path.join(state, "it's here", "a note.json"), "{}");
    await backup("--local-only");
    const dryRun = await restore("--file", await latestArchive());
    assert.match(dryRun.stdout, /sqlite\.it's here\/live db\.sqlite\.we"ird=1/);
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes");
    assert.deepEqual(rows(path.join(state, "it's here", "live db.sqlite"), 'we"ird'), ["odd"]);
    assert.equal(await readFile(path.join(state, "it's here", "a note.json"), "utf8"), "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every store's own SQLite path is backed up, from the host config and from the SFU containers' env", needs, async () => {
  // Greptile on #313: each store prefers its own variable over
  // CONCLAVE_SQLITE_PATH, so those databases were never copied.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, config, setDocker, backup, latestArchive, restore } = await setUp(root, [
      "SCHEDULED_WEBINARS_SQLITE_PATH=/var/lib/conclave/recordings/webinars.db",
    ]);
    withDatabase(state);
    makeDb(path.join(state, "webinars.db"), "webinar");
    await mkdir(path.join(state, "meetings"));
    makeDb(path.join(state, "meetings", "store.db"), "meeting");
    // The SFU container sets one more that the host config does not.
    await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a", "SCHEDULED_MEETINGS_SQLITE_PATH=/var/lib/conclave/recordings/meetings/store.db"] }]);
    await backup("--local-only");
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--only", "sqlite", "--yes");
    assert.deepEqual(rows(path.join(state, "webinars.db")), ["webinar"]);
    assert.deepEqual(rows(path.join(state, "meetings", "store.db")), ["meeting"]);

    // One outside the volume, or missing, fails the backup.
    await writeFile(config, `${await readFile(config, "utf8")}\nSCHEDULING_SQLITE_PATH=/app/data/scheduling.db\n`);
    await assert.rejects(backup("--local-only"), /SCHEDULING_SQLITE_PATH=\/app\/data\/scheduling\.db \(the backup config\) is outside the state dir/);
    await writeFile(config, `${await readFile(config, "utf8")}\nSCHEDULING_SQLITE_PATH=/var/lib/conclave/recordings/gone.db\n`);
    await assert.rejects(backup("--local-only"), /the configured database .*gone\.db is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Greptile's round on 88673407.

// A Redis on a free port, optionally with a password, stopped by close().
const startRedis = async (password) => {
  const port = await freePort();
  const args = ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", ...(password ? ["--requirepass", password] : [])];
  const server = spawn("redis-server", args, { stdio: "ignore" });
  const cli = (...more) => run("redis-cli", ["-h", "127.0.0.1", "-p", String(port), "--no-auth-warning", ...(password ? ["-a", password] : []), ...more]);
  for (let i = 0; i < 50 && (await cli("PING").then((r) => r.stdout.trim(), () => "")) !== "PONG"; i += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  return { port, cli, close: () => server.kill() };
};
const needsRedis = { skip: missingWithRedis.length > 0 && `needs ${missingWithRedis.join(", ")} on PATH` };
const workDirs = async (local) => (await readdir(local).catch(() => [])).filter((name) => name.startsWith(".work."));

test("a shared CONCLAVE_SQLITE_PATH that no store opens does not stop a backup", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const stores = ["SCHEDULING_SQLITE_PATH=/var/lib/conclave/recordings/scheduling.db", "SCHEDULED_MEETINGS_SQLITE_PATH=/var/lib/conclave/recordings/meetings.db", "SCHEDULED_WEBINARS_SQLITE_PATH=/var/lib/conclave/recordings/webinars.db"];
    const { state, local, setDocker, backup } = await setUp(root, stores);
    for (const name of ["scheduling.db", "meetings.db", "webinars.db"]) makeDb(path.join(state, name), name);
    // Every store has its own path, so the shared one (missing here) is
    // opened by nobody, in the host config or in the container's env.
    await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a", ...stores, "CONCLAVE_SQLITE_PATH=/var/lib/conclave/recordings/gone.sqlite"] }]);
    await backup("--local-only");
    assert.equal((await archives(local)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Redis precondition is checked before the first rename", needsRedis, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const live = await startRedis();
  const locked = await startRedis("s3cret");
  try {
    const { state, config, backup, latestArchive, restore } = await setUp(root, [`SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${live.port}/0`]);
    makeDb(path.join(state, "conclave.sqlite"), "backed up");
    await live.cli("SET", "conclave:sfu:persistence:meeting", "x");
    await backup("--local-only");
    const archive = await latestArchive();
    const live2 = new DatabaseSync(path.join(state, "conclave.sqlite"));
    live2.exec("INSERT INTO meetings VALUES ('after the backup')");
    live2.close();
    const unchanged = () => assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["after the backup", "backed up"], "nothing was changed");
    const withRedis = async (url) => writeFile(config, `${await readFile(config, "utf8")}\nSFU_PERSISTENCE_REDIS_URL=${url}\n`);

    await withRedis(`redis://127.0.0.1:${await freePort()}/0`);
    await assert.rejects(restore("--file", archive, "--yes"), /cannot reach the Redis at 127\.0\.0\.1:\d+ .*nothing was changed/s);
    unchanged();

    await withRedis(`redis://127.0.0.1:${locked.port}/0`);
    await assert.rejects(restore("--file", archive, "--yes"), /the Redis at 127\.0\.0\.1:\d+ refused this restore .*NOAUTH.*nothing was changed/s);
    unchanged();

    await withRedis(`redis://127.0.0.1:${live.port}/0`);
    const broken = await tamper(root, archive, { replace: { "redis/dump.rdb": "not an RDB file" } }, path.join(root, "broken.tar.gz.age"));
    await assert.rejects(restore("--file", broken, "--yes"), /the Redis snapshot in the backup does not load.*nothing was changed/s);
    unchanged();
  } finally {
    live.close();
    locked.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a configured Redis that the backup has no snapshot of is a refusal unless --only leaves Redis out", needsRedis, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const live = await startRedis();
  try {
    const { state, config, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "backed up");
    // Taken before Redis was turned on, so it holds no snapshot.
    await backup("--local-only");
    await writeFile(config, `${await readFile(config, "utf8")}\nSFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${live.port}/0\n`);
    await live.cli("SET", "conclave:sfu:persistence:newer", "x");
    await assert.rejects(restore("--file", await latestArchive(), "--yes"), /Redis is configured .* but this backup has no Redis snapshot.*--only sqlite,files/s);
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes", "--only", "sqlite,files");
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["backed up"]);
  } finally {
    live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a store the backup does not cover is a refusal unless --only leaves SQLite out", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, config, backup, latestArchive, restore } = await setUp(root);
    makeDb(path.join(state, "conclave.sqlite"), "backed up");
    await writeFile(path.join(state, "notes.json"), "{}");
    await backup("--local-only");
    // The SFU now keeps scheduling in a database of its own.
    await writeFile(config, `${await readFile(config, "utf8")}\nSCHEDULING_SQLITE_PATH=/var/lib/conclave/recordings/scheduling.db\n`);
    await assert.rejects(restore("--file", await latestArchive(), "--yes"), /the backup has no copy of scheduling\.db, the database SCHEDULING_SQLITE_PATH \(the backup config\) names.*--only/s);
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes", "--only", "files");
    assert.equal(await readFile(path.join(state, "notes.json"), "utf8"), "{}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a backup that stops at any early exit leaves no work dir, holds no fence, and says only why", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const sfu = await fencedSfu();
  try {
    const { state, local, config, setDocker, backup } = await setUp(root, [`CONCLAVE_SFU_HEALTH_URLS="${sfu.health}"`]);
    const base = await readFile(config, "utf8");
    const exits = [
      ["the state dir is missing", async () => rm(state, { recursive: true, force: true }), /the state dir .* does not exist/],
      ["the preflight refuses", async () => mkdir(state, { recursive: true }), /the configured database .*conclave\.sqlite is missing/],
      ["Docker cannot answer", async () => { withDatabase(state); await setDocker({ fail: true }); }, /Docker cannot list the SFU containers/],
      ["a container is not fenced", async () => setDocker([sfu.container(state), { id: "rogue", mounts: [state], status: "running", env: ["SFU_PORT=1", "SFU_INSTANCE_ID=rogue"] }]), /rogue \(rogue\) is running but does not hold the write fence/],
      ["a copy fails", async () => { await setDocker([sfu.container(state)]); await writeFile(path.join(state, "broken.sqlite"), "not a database"); }, /file is not a database/],
      ["the payload would not restore", async () => { await rm(path.join(state, "broken.sqlite")); await writeFile(path.join(state, "bad\tname.json"), "{}"); }, /this backup would not restore/],
    ];
    for (const [label, arrange, message] of exits) {
      await writeFile(config, base);
      await arrange();
      const before = sfu.requests.length;
      const failed = await backup("--local-only").then(() => null, (error) => error);
      assert.ok(failed, `${label}: the backup must fail`);
      assert.match(String(failed.stderr), message, label);
      assert.doesNotMatch(String(failed.stderr), /command not found|unbound variable/, `${label}: the cleanup ran cleanly`);
      assert.deepEqual(await workDirs(local), [], `${label}: no work dir is left behind`);
      const after = sfu.requests.slice(before);
      if (after.some((request) => request.method === "POST" && !request.renew)) {
        assert.equal(after.at(-1).method, "DELETE", `${label}: the fence it took is released`);
      }
    }
    assert.deepEqual(await archives(local), []);
  } finally {
    await sfu.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- Greptile's round on 4d228bd1.

test("a store an SFU keeps under a mount of a dir above the state dir is backed up as a database", needs, async () => {
  // The SFU mounts <srv>/conclave at /var/lib/conclave and keeps meetings in
  // /var/lib/conclave/recordings/meetings.db; the backup targets
  // <srv>/conclave/recordings.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const above = path.join(root, "srv", "conclave");
    const state = path.join(above, "recordings");
    const { setDocker, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_STATE_DIR=${state}`]);
    await mkdir(state, { recursive: true });
    withDatabase(state);
    makeDb(path.join(state, "meetings.db"), "meeting");
    await setDocker([{ id: "sfu-a", mounts: [{ source: above, destination: "/var/lib/conclave" }], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a", "SCHEDULED_MEETINGS_SQLITE_PATH=/var/lib/conclave/recordings/meetings.db"] }]);
    await backup("--local-only");
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--only", "sqlite", "--yes");
    assert.deepEqual(rows(path.join(state, "meetings.db")), ["meeting"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore reads the Redis database the backup was taken from, whatever database it writes to", needsRedis, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const source = await startRedis();
  const drill = await startRedis();
  try {
    const { state, config, backup, latestArchive, restore } = await setUp(root, [`SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${source.port}/1`]);
    withDatabase(state);
    await source.cli("-n", "1", "SET", "conclave:sfu:persistence:meeting", "from db 1");
    await backup("--local-only");
    // The drill restores into database 0 of another Redis.
    await writeFile(config, `${await readFile(config, "utf8")}\nSFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${drill.port}/0\n`);
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes");
    assert.equal((await drill.cli("-n", "0", "GET", "conclave:sfu:persistence:meeting")).stdout.trim(), "from db 1");
  } finally {
    source.close();
    drill.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a dump the host's redis-server cannot read is loaded with the live server's version in Docker", needsRedis, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  const live = await startRedis();
  try {
    const { state, env, backup, latestArchive } = await setUp(root, [`SFU_PERSISTENCE_REDIS_URL=redis://127.0.0.1:${live.port}/0`]);
    withDatabase(state);
    await live.cli("SET", "conclave:sfu:persistence:meeting", "kept");
    await backup("--local-only");
    await live.cli("DEL", "conclave:sfu:persistence:meeting");
    // An older redis-server package on the host cannot read the dump.
    const old = path.join(root, "old-redis");
    await mkdir(old);
    await writeFile(path.join(old, "redis-server"), "#!/bin/sh\necho \"Can't handle RDB format version 99\"\nexit 1\n", { mode: 0o755 });
    const real = execFileSync("sh", ["-c", "command -v redis-server"], { encoding: "utf8" }).trim();
    await rm(state, { recursive: true });
    await run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", await latestArchive(), "--yes"], {
      env: { ...env, PATH: `${old}:${env.PATH}`, BACKUP_TEST_REAL_REDIS: real },
    });
    assert.equal((await live.cli("GET", "conclave:sfu:persistence:meeting")).stdout.trim(), "kept");
  } finally {
    live.close();
    await rm(root, { recursive: true, force: true });
  }
});

// --- Greptile's round on 8c7e8b93.

test("an SFU that mounts another dir inside its view of the state dir stops the backup", needs, async () => {
  // The SFU sees /var/lib/conclave/recordings/data from another host dir,
  // so the host's own state/data/live.db is not what it opens.
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, local, setDocker, backup } = await setUp(root);
    await mkdir(path.join(state, "data"));
    makeDb(path.join(state, "data", "live.db"), "the host's copy");
    await symlink("data/live.db", path.join(state, "conclave.sqlite"));
    const other = path.join(root, "other-data");
    await mkdir(other);
    makeDb(path.join(other, "live.db"), "what the SFU opens");
    await setDocker([{ id: "sfu-a", mounts: [state, { source: other, destination: "/var/lib/conclave/recordings/data" }], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
    await assert.rejects(backup("--local-only"), /the container sfu-a mounts .*other-data at \/var\/lib\/conclave\/recordings\/data, inside its view of the state dir/);
    assert.deepEqual(await archives(local), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a restore gives its files to the user of a stopped SFU that mounts a dir above the state dir", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const above = path.join(root, "srv", "conclave");
    const state = path.join(above, "recordings");
    const { config, setDocker, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_STATE_DIR=${state}`]);
    await mkdir(state, { recursive: true });
    withDatabase(state);
    await setDocker([{ id: "sfu-a", mounts: [{ source: above, destination: "/var/lib/conclave" }], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
    await backup("--local-only");
    await writeFile(config, `${await readFile(config, "utf8")}\nBACKUP_RESTORE_OWNER=\n`);
    const uid = process.getuid() === 0 ? 4242 : process.getuid();
    const gid = process.getuid() === 0 ? 4242 : process.getgid();
    await setDocker([{ id: "sfu-a", mounts: [{ source: above, destination: "/var/lib/conclave" }], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"], user: `${uid}:${gid}` }]);
    await rm(state, { recursive: true });
    const result = await restore("--file", await latestArchive(), "--yes");
    assert.match(result.stdout, new RegExp(`Gave the restored files in .* to ${uid}:${gid}, the user the SFU runs as`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing lock that is narrowed is given the deploy group too, so its members can still open it", needs, async () => {
  // Another group this user belongs to stands in for docker.
  const ids = execFileSync("id", ["-G"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  const names = execFileSync("id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/);
  const other = ids.findIndex((gid) => gid !== process.getgid());
  if (other < 0) return;
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, config, backup } = await setUp(root);
    withDatabase(state);
    await writeFile(config, `${await readFile(config, "utf8")}\nSFU_DEPLOY_LOCK_GROUP=${names[other]}\n`);
    const lock = path.join(root, "deploy.lock");
    await writeFile(lock, "");
    await chmod(lock, 0o666);
    await backup("--local-only");
    const after = await stat(lock);
    assert.equal(after.mode & 0o777, 0o640);
    assert.equal(after.gid, ids[other], `the lock's group is ${names[other]}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Greptile's four cases from the b55af173 round.

test("Greptile: a link through a directory link and .. comes back as written and reaches the database it did", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    // alias -> data/deep, conclave.sqlite -> alias/../live.db: the SFU opens data/live.db.
    await mkdir(path.join(state, "data", "deep"), { recursive: true });
    makeDb(path.join(state, "data", "live.db"), "through the alias");
    makeDb(path.join(state, "live.db"), "a decoy at the collapsed path");
    await symlink("data/deep", path.join(state, "alias"));
    await symlink("alias/../live.db", path.join(state, "conclave.sqlite"));
    await backup("--local-only");
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--only", "sqlite", "--yes");
    assert.equal(await readlink(path.join(state, "conclave.sqlite")), "alias/../live.db");
    assert.equal(await readlink(path.join(state, "alias")), "data/deep");
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["through the alias"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Greptile: a recorded link whose target goes through a live link that leads out is refused", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, backup, latestArchive, restore } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    makeDb(path.join(outside, "live.db"), "outside");
    await symlink(outside, path.join(state, "pivot"));
    // Valid on its own: it holds pivot/live.db and records other.sqlite ->
    // pivot/live.db. On this host pivot is a link that leads out.
    makeDb(path.join(root, "copy.db"), "crafted");
    const crafted = await tamper(root, await latestArchive(), {
      append: { "sqlite-databases": "pivot/live.db\n", "sqlite-links": "other.sqlite\tpivot/live.db\n", "sqlite-chains": "other.sqlite\tpivot/live.db\n" },
      outer: [{ name: "./sqlite/pivot", type: "dir" }, { name: "./sqlite/pivot/live.db", from: path.join(root, "copy.db") }],
    }, path.join(root, "crafted.tar.gz.age"));
    await assert.rejects(restore("--file", crafted, "--only", "sqlite", "--yes"), /pivot is a link in the state dir, and a restore never writes through a link/);
    assert.equal(await readlink(path.join(state, "other.sqlite")).catch(() => "absent"), "absent");
    assert.deepEqual(rows(path.join(outside, "live.db")), ["outside"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Greptile: a subdirectory the backup cannot list fails it and rotates nothing away", { skip: needs.skip || (process.getuid() === 0 && "root reads every directory") }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    const { state, local, backup } = await setUp(root);
    withDatabase(state);
    await backup("--local-only");
    await mkdir(path.join(state, "locked"));
    await writeFile(path.join(state, "locked", "notes.json"), "{}");
    await chmod(path.join(state, "locked"), 0o000);
    await assert.rejects(backup("--local-only"), /cannot (list|open) .*locked/);
    assert.equal((await archives(local)).length, 1);
  } finally {
    await chmod(path.join(root, "state", "locked"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Greptile: with the state dir inside the containers' mount path, a link is read container first", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
  try {
    // STATE_DIR=<rec>/staging while the containers mount <rec>: the target
    // <rec>/staging/live.db means staging/live.db inside the state dir.
    const rec = path.join(root, "rec");
    const state = path.join(rec, "staging");
    const { setDocker, backup, latestArchive, restore } = await setUp(root, [`CONCLAVE_STATE_DIR=${state}`, `CONCLAVE_CONTAINER_STATE_DIR=${rec}`]);
    await setDocker([{ id: "sfu-a", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
    await mkdir(path.join(state, "staging"), { recursive: true });
    makeDb(path.join(state, "staging", "live.db"), "container first");
    makeDb(path.join(state, "live.db"), "the host's reading");
    await symlink(path.join(rec, "staging", "live.db"), path.join(state, "conclave.sqlite"));
    await backup("--local-only");
    await rm(state, { recursive: true });
    await restore("--file", await latestArchive(), "--yes");
    assert.equal(await readlink(path.join(state, "conclave.sqlite")), "staging/live.db");
    assert.deepEqual(rows(path.join(state, "conclave.sqlite")), ["container first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup then restore over random trees reproduces what the SFU opens, or refuses, and never touches anything outside", needs, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-property-"));
  try {
    for (const seed of ["1", "2", "3"]) {
      const work = path.join(root, seed);
      await mkdir(work);
      const { stdout } = await run("python3", [path.join(scripts, "..", "test-support", "backup-property.py"), work, seed, "60"]);
      assert.match(stdout, /restored/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a mount point inside the state dir, or a state dir that is one, is refused before anything changes",
  { skip: needs.skip || ((process.getuid() !== 0 || process.platform !== "linux") && "needs root on Linux to mount a tmpfs") },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    const mounted = [];
    try {
      const { state, config, setDocker, backup, latestArchive, restore } = await setUp(root);
      makeDb(path.join(state, "conclave.sqlite"), "before");
      await mkdir(path.join(state, "data"));
      await writeFile(path.join(state, "data", "notes.json"), "backed up");
      await backup("--local-only");
      // Neon: a bind mount inside the state dir made a rename fail with
      // EXDEV halfway through the restore.
      await run("mount", ["-t", "tmpfs", "tmpfs", path.join(state, "data")]);
      mounted.push(path.join(state, "data"));
      await writeFile(path.join(state, "data", "notes.json"), "live");
      await assert.rejects(restore("--file", await latestArchive(), "--yes"), /data is a mount point inside the state dir/);
      assert.equal(await readFile(path.join(state, "data", "notes.json"), "utf8"), "live");
      const own = path.join(root, "own-fs");
      await mkdir(own);
      await run("mount", ["-t", "tmpfs", "tmpfs", own]);
      mounted.push(own);
      await writeFile(config, `${await readFile(config, "utf8")}\nCONCLAVE_STATE_DIR=${own}\n`);
      await setDocker([{ id: "sfu-a", mounts: [own], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-a"] }]);
      await assert.rejects(restore("--file", await latestArchive(), "--yes"), /is a file system of its own \(a mount point\)/);
      assert.deepEqual(await readdir(own), []);
    } finally {
      for (const dir of mounted.reverse()) await run("umount", [dir]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

describe("backup and restore", { concurrency: 6 }, () => {
  for (const args of queued) nodeTest(...args);
});
