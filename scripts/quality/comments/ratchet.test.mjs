import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const repo = repoWith(t, { "app.css": "/* one */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 1 } });
  write(repo, { "app.css": "/* one */\na { z-index: 1 } /* two */\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\.css: comments rose from 1 to 2/);
  assert.match(result.stderr, /app\.css:2 {2}\/\* two \*\//);
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
    "app.css": "/* one */\n/* two */\na { z-index: 1 }\n",
    "gone.css": "/* old */\n",
    [BASELINE]: { "app.css": 2, "gone.css": 1 },
  });
  write(repo, { "app.css": "/* one */\na { z-index: 1 }\n" });
  git(repo, "rm", "-q", "gone.css");
  const check = ratchet(repo);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /2 file\(s\) have fewer comments than the baseline/);
  const update = ratchet(repo, "--update");
  assert.equal(update.status, 0, update.stderr);
  assert.deepEqual(baselineOf(repo), { "app.css": 1 });
});

test("--update refuses to raise a count", (t) => {
  const repo = repoWith(t, { "app.css": "/* one */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 1 } });
  write(repo, { "app.css": "/* one */\n/* two */ a { z-index: 1 }\n" });
  const result = ratchet(repo, "--update");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\.css: 1 -> 2/);
  assert.deepEqual(baselineOf(repo), { "app.css": 1 });
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
    "app.css": "/* one */\na { z-index: 1 }\n",
    [BASELINE]: { "app.css": 1 },
    "eslint-suppressions.json": { "src/a.ts": { "conclave/no-comments": { count: 1 } } },
  });
  write(repo, {
    "app.css": "/* one */\n/* two */\na { z-index: 1 }\n",
    [BASELINE]: { "app.css": 2 },
    "eslint-suppressions.json": { "src/a.ts": { "conclave/no-comments": { count: 3 } }, "src/b.ts": { "conclave/no-comments": { count: 1 } } },
  });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /baseline\.json: app\.css rose from 1 to 2 since/);
  assert.match(result.stderr, /eslint-suppressions\.json: src\/a\.ts conclave\/no-comments rose from 1 to 3/);
  assert.match(result.stderr, /eslint-suppressions\.json: src\/b\.ts conclave\/no-comments rose from 0 to 1/);
});

test("a base ref that is missing and cannot be fetched fails with a clear message", (t) => {
  const repo = repoWith(t, { [BASELINE]: {} });
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: "no-such-ref", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /base ref no-such-ref is missing/);
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
    [BASELINE]: { "app.css": 1 },
    "app.css": "/* one */\na { z-index: 1 }\n",
  });
  git(repo, "checkout", "-q", "base");
  write(repo, { [BASELINE]: { "app.css": 2 }, "app.css": "/* one */\n/* two */\na { z-index: 1 }\n" });
  git(repo, "commit", "-q", "-m", "direct push");
  const pushed = ratchet(repo);
  assert.equal(pushed.status, 1);
  assert.match(pushed.stderr, /baseline\.json: app\.css rose from 1 to 2 since/);
  const before = git(repo, "rev-parse", "HEAD^1").trim();
  const withBefore = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: before, COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(withBefore.status, 1);
  assert.match(withBefore.stderr, /app\.css rose from 1 to 2 since/);
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
  const repo = repoWith(t, { "app.css": "/* one */\n/* two */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 2 } });
  git(repo, "checkout", "-q", "base");
  write(repo, { "app.css": "/* one */\na { z-index: 1 }\n" });
  git(repo, "commit", "-q", "-m", "delete a comment, keep the baseline at 2");
  git(repo, "checkout", "-q", "-B", "feature");
  write(repo, { "app.css": "/* one */\na { z-index: 1 } /* back */\n" });
  const result = ratchet(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\.css: comments rose from 1 to 2 since/);
});

const ratchetWith = (repo, env) =>
  spawnSync(process.execPath, [RATCHET, "--repo", repo], { encoding: "utf8", env: { ...cleanEnv(), ...env } });

test("push mode compares a force push with the tip it replaced, not their merge base", (t) => {
  const repo = repoWith(t, { "app.css": "/* one */\n/* two */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 2 } });
  write(repo, { "app.css": "/* one */\na { z-index: 1 }\n" });
  git(repo, "commit", "-q", "-m", "delete a comment");
  const replacedTip = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "reset", "-q", "--hard", "HEAD^1");
  write(repo, { "app.css": "/* one */\n/* two */\na { z-index: 2 }\n" });
  git(repo, "commit", "-q", "-m", "force-pushed rewrite that brings the comment back");
  const mergeBase = ratchetWith(repo, { COMMENT_RATCHET_BASE: replacedTip, COMMENT_RATCHET_MODE: "merge-base" });
  assert.equal(mergeBase.status, 0, mergeBase.stderr);
  const exact = ratchetWith(repo, { COMMENT_RATCHET_BASE: replacedTip, COMMENT_RATCHET_MODE: "exact" });
  assert.equal(exact.status, 1);
  assert.match(exact.stderr, /app\.css: comments rose from 1 to 2 since/);
});

test("push mode falls back to HEAD^1 when the previous tip is gone, and says so", (t) => {
  const repo = repoWith(t, { "app.css": "/* one */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 1 } });
  write(repo, { "app.css": "/* one */\n/* two */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 2 } });
  git(repo, "commit", "-q", "-m", "raise");
  const result = ratchetWith(repo, { COMMENT_RATCHET_BASE: "0123456789abcdef0123456789abcdef01234567", COMMENT_RATCHET_MODE: "exact" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is not available, so comparing with HEAD\^1/);
  assert.match(result.stderr, /app\.css rose from 1 to 2 since/);
});

test("with the previous tip gone, a refill under a stale baseline still fails against origin/staging", (t) => {
  const repo = repoWith(t, { "app.css": "/* one */\n/* two */\na { z-index: 1 }\n", [BASELINE]: { "app.css": 2 } });
  git(repo, "checkout", "-q", "base");
  write(repo, { "app.css": "/* one */\na { z-index: 1 }\n" });
  git(repo, "commit", "-q", "-m", "delete a comment, keep the baseline at 2");
  git(repo, "update-ref", "refs/remotes/origin/staging", "HEAD");
  git(repo, "checkout", "-q", "-B", "feature");
  write(repo, { "app.css": "/* one */\na { z-index: 1 } /* back */\n" });
  git(repo, "commit", "-q", "-m", "refill");
  write(repo, { "notes.txt": "unrelated\n" });
  git(repo, "commit", "-q", "-m", "unrelated");
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), COMMENT_RATCHET_BASE: "0123456789abcdef0123456789abcdef01234567", COMMENT_RATCHET_MODE: "exact" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /comparing with HEAD\^1 \([0-9a-f]{8}\) and the merge base with origin\/staging \([0-9a-f]{8}\)/);
  assert.match(result.stderr, /app\.css: comments rose from 1 to 2 since/);
});

test("without python3 the ratchet fails instead of guessing at Python comments", (t) => {
  const repo = repoWith(t, { "tool.py": 'print(f"{1:=#6x}")\n', [BASELINE]: {} });
  write(repo, { "tool.py": 'print(f"{2:=#6x}")\n' });
  git(repo, "commit", "-q", "-m", "python change");
  const gitBinary = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "git")).find((candidate) => existsSync(candidate));
  const bin = mkdtempSync(path.join(tmpdir(), "no-python-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  symlinkSync(gitBinary, path.join(bin, "git"));
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), PATH: bin, COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read the comments in tool\.py: python3 3\.12 or newer is required, and `python3` is not on PATH/);
});

const pathWithOnly = (t, tools) => {
  const bin = mkdtempSync(path.join(tmpdir(), "only-tools-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const tool of tools) {
    const found = (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, tool)).find((candidate) => existsSync(candidate));
    if (found) symlinkSync(found, path.join(bin, tool));
  }
  return bin;
};

test("a web-only change passes with no Swift toolchain on PATH", (t) => {
  const repo = repoWith(t, {
    "App.swift": "// one\nlet a = 1\n",
    "run.sh": "#!/bin/sh\n# deploy notes\necho hi\n",
    "src/view.ts": "export const view = 1;\n",
    [BASELINE]: { "App.swift": 1, "run.sh": 1 },
  });
  write(repo, { "src/view.ts": "export const view = 2;\n" });
  git(repo, "commit", "-q", "-m", "web only");
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), PATH: pathWithOnly(t, ["git"]), COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no new comments in the 1 file\(s\) changed since the base/);
});

test("a change to a Swift file with no Swift toolchain fails and names the file and the tool", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\nlet a = 1\n", [BASELINE]: { "App.swift": 1 } });
  write(repo, { "App.swift": "// one\nlet a = 2\n" });
  git(repo, "commit", "-q", "-m", "swift change");
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), PATH: pathWithOnly(t, ["git"]), COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read the comments in App\.swift: a working Swift toolchain is required to read Swift comments: `swift` is not on PATH/);
});

const fakeTool = (bin, name, script) => {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
};

test("a Swift launcher that starts but fails is reported as unavailable", (t) => {
  const repo = repoWith(t, { "App.swift": "// one\nlet a = 1\n", [BASELINE]: { "App.swift": 1 } });
  write(repo, { "App.swift": "// one\nlet a = 2\n" });
  git(repo, "commit", "-q", "-m", "swift change");
  const bin = pathWithOnly(t, ["git"]);
  fakeTool(bin, "swift", 'echo "xcrun: error: unable to find utility" >&2; exit 1');
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), PATH: bin, COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read the comments in App\.swift: a working Swift toolchain is required to read Swift comments: `swift --version` exited with 1/);
});

test("deleting Swift and Python files needs neither parser", (t) => {
  const repo = repoWith(t, {
    "App.swift": "// one\nlet a = 1\n",
    "tool.py": "# one\nx = 1\n",
    [BASELINE]: { "App.swift": 1, "tool.py": 1 },
  });
  git(repo, "rm", "-q", "App.swift", "tool.py");
  git(repo, "commit", "-q", "-m", "delete");
  const result = spawnSync(process.execPath, [RATCHET, "--repo", repo], {
    encoding: "utf8",
    env: { ...cleanEnv(), PATH: pathWithOnly(t, ["git"]), COMMENT_RATCHET_BASE: "base", COMMENT_RATCHET_MODE: "merge-base" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a missing base ref is fetched, never widened to a full scan", (t) => {
  const remote = repoWith(t, { "App.swift": "// one\nlet a = 1\n", "src/view.ts": "export const v = 1;\n", [BASELINE]: { "App.swift": 1 } });
  git(remote, "branch", "-q", "-m", "base", "staging");
  git(remote, "checkout", "-q", "-B", "feature", "staging");
  write(remote, { "src/view.ts": "export const v = 2;\n" });
  git(remote, "commit", "-q", "-m", "web only");
  const clone = mkdtempSync(path.join(tmpdir(), "comment-clone-"));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", "--single-branch", "--branch", "feature", `file://${remote}`, clone]);
  const env = { ...cleanEnv(), PATH: pathWithOnly(t, ["git"]), COMMENT_RATCHET_BASE: "origin/staging", COMMENT_RATCHET_MODE: "merge-base" };
  const fetched = spawnSync(process.execPath, [RATCHET, "--repo", clone], { encoding: "utf8", env });
  assert.doesNotMatch(fetched.stdout + fetched.stderr, /every tracked file/);
  assert.ok(
    fetched.status === 0 || /shallow: run git fetch --unshallow origin/.test(fetched.stderr),
    `${fetched.status}\n${fetched.stdout}\n${fetched.stderr}`,
  );
  git(clone, "remote", "set-url", "origin", path.join(clone, "missing-remote"));
  git(clone, "update-ref", "-d", "refs/remotes/origin/staging");
  const missing = spawnSync(process.execPath, [RATCHET, "--repo", clone], { encoding: "utf8", env });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /base ref origin\/staging is missing: run git fetch origin staging/);
});
