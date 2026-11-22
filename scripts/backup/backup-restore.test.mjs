import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { provideFlock } from "../test-support/host-tools.mjs";

const run = promisify(execFile);
const scripts = import.meta.dirname;
const hasTool = (tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const missing = ["age", "age-keygen", "sqlite3", "sha256sum", "fuser"].filter((tool) => !hasTool(tool));
const missingWithRedis = [...missing, ...["redis-server", "redis-cli"].filter((tool) => !hasTool(tool))];

// A stand-in docker CLI that answers from a JSON list of containers, so a
// backup sees the SFU containers a test describes and never this host's.
// Each entry: { id, mounts, status, env, user, image }; { "fail": true }
// makes every command fail.
const dockerStandIn = `#!/usr/bin/env node
const fs = require("node:fs");
const listed = JSON.parse(fs.readFileSync(process.env.BACKUP_TEST_DOCKER, "utf8"));
const args = process.argv.slice(2);
const out = (lines) => process.stdout.write(lines.map((line) => line + "\\n").join(""));
if (listed.fail) process.exit(1);
if (args[0] === "ps") return void out(listed.map((c) => c.id));
// docker inspect <ids...>: the JSON Docker prints, for the fields read.
if (args[0] === "inspect" && args[1] !== "-f") {
  const found = args.slice(1).map((id) => listed.find((entry) => entry.id === id));
  if (found.some((entry) => !entry)) process.exit(1);
  return void out([JSON.stringify(found.map((entry) => ({
    Id: entry.id,
    State: { Status: entry.status },
    Config: { Env: entry.env ?? [], User: entry.user ?? "" },
    Image: entry.image ?? "sha256:sfu-image",
    Mounts: (entry.mounts ?? []).map((source) => ({ Type: "bind", Source: source })),
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
      assert.equal(await readlink(path.join(state, "scheduling.sqlite")), "/var/lib/conclave/recordings/data/sched.db");
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
      assert.match(result.stdout, new RegExp(`Gave the files in .* to ${uid}:${gid}, the user the SFU runs as`));

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
      const redisWriter = spawn("redis-cli", ["-h", "127.0.0.1", "-p", String(port)], { stdio: ["pipe", "pipe", "ignore"] });
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
      holder = spawn("bash", ["-c", 'exec 8>>"$1"; flock -n 8 && echo locked && sleep 30', "_", path.join(local, ".backup.lock")], { env });
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
      const { env, setDocker } = await setUp(root, [`CONCLAVE_STATE_DIR=${state}`]);
      await setDocker([{ id: "sfu-staging", mounts: [state], status: "exited", env: ["SFU_PORT=9", "SFU_INSTANCE_ID=sfu-staging"] }]);
      await mkdir(path.join(redisData, "appendonlydir"), { recursive: true });
      await mkdir(state, { recursive: true });
      const redisFiles = ["dump.rdb", "appendonlydir/appendonly.aof.1.incr.aof"];
      for (const file of redisFiles) await writeFile(path.join(redisData, file), `redis ${file}`);
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("CREATE TABLE meetings (id TEXT PRIMARY KEY)");
      db.close();
      const before = await Promise.all(redisFiles.map((file) => stat(path.join(redisData, file))));

      // Every directory a backup or restore walks, as find sees it.
      const findBin = path.join(root, "find-bin");
      const findLog = path.join(root, "find.log");
      await mkdir(findBin);
      const realFind = execFileSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).trim();
      await writeFile(
        path.join(findBin, "find"),
        `#!/bin/sh\ncase "$1" in /*) printf '%s\\n' "$1" ;; *) printf '%s\\n' "$PWD/$1" ;; esac >> "${findLog}"\nexec ${realFind} "$@"\n`,
        { mode: 0o755 },
      );
      const walked = { ...env, PATH: `${findBin}:${env.PATH}` };
      await run("bash", [path.join(scripts, "backup.sh"), "--local-only"], { env: walked });
      const archive = (await readdir(path.join(root, "local"))).find((name) => name.endsWith(".tar.gz.age"));
      await rm(state, { recursive: true });
      await run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", path.join(root, "local", archive), "--yes"], { env: walked });

      const roots = (await readFile(findLog, "utf8")).split("\n").filter(Boolean).map((dir) => path.resolve(dir));
      assert.ok(roots.some((dir) => dir === path.resolve(state)), "the restore's ownership fix walked the state dir");
      for (const dir of roots) {
        const relative = path.relative(dir, path.resolve(redisData));
        assert.ok(relative.startsWith("..") || path.isAbsolute(relative), `${dir} contains Redis's data`);
      }
      const after = await Promise.all(redisFiles.map((file) => stat(path.join(redisData, file))));
      assert.deepEqual(after.map((s) => [s.ino, s.ctimeMs, s.uid, s.gid]), before.map((s) => [s.ino, s.ctimeMs, s.uid, s.gid]));
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
      assert.match(result.stdout, new RegExp(`Gave the files in .* to ${uid}:${gid}, the user the SFU runs as`));
      const restored = new DatabaseSync(path.join(state, "conclave.sqlite"), { readOnly: true });
      assert.deepEqual(restored.prepare("SELECT id FROM meetings").all().map((row) => row.id), ["kept"]);
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
