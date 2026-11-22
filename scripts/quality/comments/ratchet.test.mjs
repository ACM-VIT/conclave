import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RATCHET = fileURLToPath(new URL("./ratchet.mjs", import.meta.url));
const BASELINE = "scripts/quality/comments/baseline.json";

const git = (repo, ...args) =>
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=ratchet", "-c", "user.email=ratchet@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  );

const write = (repo, files) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(repo, "add", "-A");
};

const repoWith = (t, files) => {
  const repo = mkdtempSync(path.join(tmpdir(), "comment-ratchet-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "base");
  write(repo, files);
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  return repo;
};

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMMENT_RATCHET_")));

const ratchet = (repo, ...args) =>
  spawnSync(process.execPath, [RATCHET, "--repo", repo, ...args], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });

const baselineOf = (repo) => JSON.parse(readFileSync(path.join(repo, BASELINE), "utf8"));

test("a rising count fails and lists the file's comments", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\nlet a = 1\n", [BASELINE]: { "App.swift": 1 } });
  write(repo, { "App.swift": "// one\nlet a = 1 // two\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /App\.swift: comments rose from 1 to 2/);
  assert.match(result.stderr, /App\.swift:2 {2}\/\/ two/);
});

test("a new file with comments fails", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  write(repo, { "deploy.sh": "#!/bin/sh\n# explain\nrun\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deploy\.sh: new comments \(1\)/);
});

test("a falling count passes, and --update lowers the baseline", (t) => {
  const repo = repoWith(t, {
    "App.swift": "// one\n// two\nlet a = 1\n",
    "gone.py": "# old\n",
    [BASELINE]: { "App.swift": 2, "gone.py": 1 },
  });
  write(repo, { "App.swift": "// one\nlet a = 1\n" });
  git(repo, "rm", "-q", "gone.py");
  const check = ratchet(repo);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /2 file\(s\) have fewer comments than the baseline/);
  const update = ratchet(repo, "--update");
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(baselineOf(repo), { "App.swift": 1 });
});

test("--update refuses to raise a count", (t) => {
  const repo = repoWith(t, { "Main.kt": "// one\nval a = 1\n", [BASELINE]: { "Main.kt": 1 } });
  write(repo, { "Main.kt": "// one\n/* two */ val a = 1\n" });
  const result = ratchet(repo, "--update");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Main\.kt: 1 -> 2/);
  assert.deepEqual(baselineOf(repo), { "Main.kt": 1 });
});

test("--init writes a first baseline and refuses to overwrite one", (t) => {
  const repo = repoWith(t, { "app.css": "/* one */\na {}\n" });
  assert.equal(ratchet(repo, "--init").status, 0);
  assert.deepEqual(baselineOf(repo), { "app.css": 1 });
  write(repo, { "app.css": "/* one */\n/* two */\na {}\n" });
  assert.equal(ratchet(repo, "--init").status, 1);
  assert.deepEqual(baselineOf(repo), { "app.css": 1 });
});

test("a baseline raised by hand since the base commit fails", (t) => {
  const repo = repoWith(t, {
    "App.swift": "// one\nlet a = 1\n",
    [BASELINE]: { "App.swift": 1 },
    "eslint-suppressions.json": { "src/a.ts": { "conclave/no-comments": { count: 1 } } },
  });
  write(repo, {
    "App.swift": "// one\n// two\nlet a = 1\n",
    [BASELINE]: { "App.swift": 2 },
    "eslint-suppressions.json": { "src/a.ts": { "conclave/no-comments": { count: 3 } }, "src/b.ts": { "conclave/no-comments": { count: 1 } } },
  });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline\.json: App\.swift rose from 1 to 2 since/);
  assert.match(result.stderr, /eslint-suppressions\.json: src\/a\.ts conclave\/no-comments rose from 1 to 3/);
  assert.match(result.stderr, /eslint-suppressions\.json: src\/b\.ts conclave\/no-comments rose from 0 to 1/);
});

test("the growth check is skipped when the base ref is missing", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: "no-such-ref", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /growth check skipped \(no-such-ref is not available\)/);
});

test("an inline directive that switches the rule off fails", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  write(repo, {
    "src/block.ts": "/* eslint-disable conclave/no-comments -- quiet */\n// hidden\nexport {};\n",
    "src/blanket.ts": "/* eslint-disable -- everything */\n// hidden\nexport {};\n",
    "src/named.ts": "/* eslint-disable no-console -- prints a report */\nexport {};\n",
  });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/block\.ts:1: this directive switches off conclave\/no-comments/);
  assert.match(result.stderr, /src\/blanket\.ts:1: this directive switches off conclave\/no-comments/);
  assert.doesNotMatch(result.stderr, /src\/named\.ts/);
});

test("an inline config comment that switches the rule off fails", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  write(repo, {
    "src/config.ts": '/* eslint conclave/no-comments: "off" */\n// hidden\nexport {};\n',
    "src/other.ts": '/* eslint no-console: "off" */\nexport {};\n',
  });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/config\.ts:1: this inline config switches off conclave\/no-comments/);
  assert.doesNotMatch(result.stderr, /src\/other\.ts:1/);
});

test("a disable directive inside a license header still fails", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  write(repo, {
    "src/licensed.ts":
      "// SPDX-License-Identifier: MIT\n/* eslint-disable conclave/no-comments -- quiet */\n// hidden\nexport {};\n",
  });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/licensed\.ts:2: this directive switches off conclave\/no-comments/);
});

test("pull request mode compares with the merge base, so a comment added on the branch fails", (t) => {
  const repo = repoWith(t, { "src/a.ts": "export const a = 1;\n", [BASELINE]: {} });
  write(repo, { "src/a.ts": "// added\nexport const a = 1;\n" });
  git(repo, "commit", "-q", "-m", "add a comment");
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/a\.ts: comments rose from 0 to 1 since/);
});

test("push mode compares a commit on the base branch with its parent", (t) => {
  const repo = repoWith(t, {
    [BASELINE]: { "App.swift": 1 },
    "App.swift": "// one\nlet a = 1\n",
  });
  git(repo, "checkout", "-q", "base");
  write(repo, { [BASELINE]: { "App.swift": 2 }, "App.swift": "// one\n// two\nlet a = 1\n" });
  git(repo, "commit", "-q", "-m", "direct push");
  const pushed = ratchet(repo);
  assert.equal(pushed.status, 1);
  assert.match(pushed.stderr, /baseline\.json: App\.swift rose from 1 to 2 since/);
  const before = git(repo, "rev-parse", "HEAD^1").trim();
  const withBefore = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: before, COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(withBefore.status, 1);
  assert.match(withBefore.stderr, /App\.swift rose from 1 to 2 since/);
});

test("a deletion that was never pruned cannot be refilled later", (t) => {
  const repo = repoWith(t, {
    "src/a.ts": "// one\n// two\nexport const a = 1;\n",
    "eslint-suppressions.json": { "src/a.ts": { "conclave/no-comments": { count: 2 } } },
    [BASELINE]: {},
  });
  git(repo, "checkout", "-q", "base");
  write(repo, { "src/a.ts": "export const a = 1;\n" });
  git(repo, "commit", "-q", "-m", "delete comments, leave the suppression");
  git(repo, "checkout", "-q", "-B", "feature");
  write(repo, { "src/a.ts": "// back\nexport const a = 1;\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/a\.ts: comments rose from 0 to 1 since/);
});

test("a native comment removed without --update cannot be added back later", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\n// two\nlet a = 1\n", [BASELINE]: { "App.swift": 2 } });
  git(repo, "checkout", "-q", "base");
  write(repo, { "App.swift": "// one\nlet a = 1\n" });
  git(repo, "commit", "-q", "-m", "delete a comment, keep the baseline at 2");
  git(repo, "checkout", "-q", "-B", "feature");
  write(repo, { "App.swift": "// one\nlet a = 1 // back\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /App\.swift: comments rose from 1 to 2 since/);
});

const ratchetWith = (repo, env) =>
  spawnSync(process.execPath, [RATCHET, "--repo", repo], { encoding: "utf8", env: { ...cleanEnv(), ...env } });

test("push mode compares a force push with the tip it replaced, not their merge base", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\n// two\nlet a = 1\n", [BASELINE]: { "App.swift": 2 } });
  write(repo, { "App.swift": "// one\nlet a = 1\n" });
  git(repo, "commit", "-q", "-m", "delete a comment");
  const replacedTip = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "reset", "-q", "--hard", "HEAD^1");
  write(repo, { "App.swift": "// one\n// two\nlet a = 2\n" });
  git(repo, "commit", "-q", "-m", "force-pushed rewrite that brings the comment back");
  const mergeBase = ratchetWith(repo, { COMMENT_RATCHET_BASE: replacedTip, COMMENT_RATCHET_MODE: "merge-base" });
  assert.equal(mergeBase.status, 0, mergeBase.stderr);
  const exact = ratchetWith(repo, { COMMENT_RATCHET_BASE: replacedTip, COMMENT_RATCHET_MODE: "exact" });
  assert.equal(exact.status, 1);
  assert.match(exact.stderr, /App\.swift: comments rose from 1 to 2 since/);
});

test("push mode falls back to HEAD^1 when the previous tip is gone, and says so", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\nlet a = 1\n", [BASELINE]: { "App.swift": 1 } });
  write(repo, { "App.swift": "// one\n// two\nlet a = 1\n", [BASELINE]: { "App.swift": 2 } });
  git(repo, "commit", "-q", "-m", "raise");
  const result = ratchetWith(repo, { COMMENT_RATCHET_BASE: "0123456789abcdef0123456789abcdef01234567", COMMENT_RATCHET_MODE: "exact" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not available, so comparing with HEAD\^1/);
  assert.match(result.stderr, /App\.swift rose from 1 to 2 since/);
});
