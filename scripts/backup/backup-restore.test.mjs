import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const missing = ["age", "age-keygen", "sqlite3", "sha256sum"].filter((tool) => !hasTool(tool));

test(
  "a backup taken while the SFU writes restores every committed row",
  { skip: missing.length > 0 && `needs ${missing.join(", ")} on PATH` },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "conclave-backup-"));
    try {
      const state = path.join(root, "state");
      const local = path.join(root, "local");
      await run("mkdir", ["-p", state, local, path.join(root, "repo")]);
      await run("age-keygen", ["-o", path.join(root, "key.txt")]);
      const { stdout: recipient } = await run("age-keygen", ["-y", path.join(root, "key.txt")]);
      await writeFile(path.join(root, "recipients.txt"), recipient);
      const config = path.join(root, "backup.env");
      await writeFile(
        config,
        [
          `CONCLAVE_REPO=${path.join(root, "repo")}`,
          `CONCLAVE_STATE_DIR=${state}`,
          `BACKUP_AGE_RECIPIENTS_FILE=${path.join(root, "recipients.txt")}`,
          `BACKUP_LOCAL_DIR=${local}`,
          "BACKUP_NAME=test",
          // Nothing listens here, so restore.sh sees the SFUs as stopped.
          'CONCLAVE_SFU_HEALTH_URLS="http://127.0.0.1:9/health"',
        ].join("\n"),
      );
      const env = { ...process.env, BACKUP_CONFIG: config, REDIS_URL: "", SFU_REDIS_URL: "" };

      // The SFU's own settings: WAL mode, and a writer that keeps going while
      // the backup runs.
      const db = new DatabaseSync(path.join(state, "conclave.sqlite"));
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE scheduled_meetings (id TEXT PRIMARY KEY, title TEXT)");
      const insert = db.prepare("INSERT INTO scheduled_meetings VALUES (?, ?)");
      for (let i = 0; i < 500; i += 1) insert.run(`m${i}`, `Meeting ${i}`);
      let written = 500;
      const writer = setInterval(() => {
        insert.run(`m${written}`, `Meeting ${written}`);
        written += 1;
      }, 2);
      await writeFile(path.join(state, "booking-links.json"), '{"links":["intro-call"]}');

      await run("bash", [path.join(scripts, "backup.sh"), "--local-only"], { env });
      clearInterval(writer);
      db.close();

      const archives = (await readdir(local)).filter((name) => name.endsWith(".tar.gz.age"));
      assert.equal(archives.length, 1);
      const archive = path.join(local, archives[0]);
      assert.ok(!(await readFile(archive)).includes("SQLite format 3"), "the archive must be encrypted");

      const dryRun = await run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", archive], { env });
      assert.match(dryRun.stdout, /sqlite\.conclave\.sqlite\.scheduled_meetings=\d+/);
      assert.match(dryRun.stdout, /Dry run: nothing changed/);

      await rm(state, { recursive: true });
      await run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", archive, "--yes"], { env });
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
      await assert.rejects(
        run("bash", [path.join(scripts, "restore.sh"), "--identity", path.join(root, "key.txt"), "--file", archive], { env }),
        "a damaged archive must not restore",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
