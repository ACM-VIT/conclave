import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";

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

// A state dir, an age key pair and a backup.env, as on the VM.
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
  await writeFile(
    config,
    [
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
  const env = { ...process.env, BACKUP_CONFIG: config, REDIS_URL: "", SFU_REDIS_URL: "" };
  const backup = (...args) => run("bash", [path.join(scripts, "backup.sh"), ...args], { env });
  const latestArchive = async () => {
    const archives = (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age")).sort();
    return path.join(local, archives.at(-1));
  };
  const restore = (...args) =>
    run("bash", [path.join(scripts, "restore.sh"), "--identity", key, ...args], { env });
  return { state, local, repo, config, backup, latestArchive, restore };
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
      await assert.rejects(backup("--local-only"), /other\.sqlite links to \/opt\/elsewhere\/conclave\.sqlite, which is not a file inside the state dir/);
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
        await assert.rejects(restore("--file", archive, "--yes", "--owner", "0:0"), /could not give .* to 0:0/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
