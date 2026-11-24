import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactProblems, contextProblems, imagePackages, repoRoot, workspacePackages } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";
import { DockerfileError, contextCopies } from "./docker-context/dockerfile.mjs";
import { dockerIgnoreMatcher, walkContext } from "./docker-context/dockerignore.mjs";
import { UnsupportedShape } from "./docker-context/unsupported.mjs";

const dockerIgnore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const packages = workspacePackages(repoRoot);

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "docker-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const copies = (text, args) => contextCopies(text, args).map((copy) => copy.sources);

test("a re-included directory brings its whole subtree back, as Docker does", () => {
  const { excluded } = dockerIgnoreMatcher("**\n!packages/\n");
  assert.equal(excluded("packages/apps-sdk/src/index.ts"), false);
  assert.equal(excluded("apps/web/package.json"), true);
});

test("the last matching pattern wins and single stars stay inside one segment", () => {
  const { excluded } = dockerIgnoreMatcher("**\n!packages/sfu/**\npackages/sfu/*.log\n**/node_modules\n");
  assert.equal(excluded("packages/sfu/server.ts"), false);
  assert.equal(excluded("packages/sfu/boot.log"), true);
  assert.equal(excluded("packages/sfu/logs/boot.log"), false);
  assert.equal(excluded("packages/sfu/node_modules/tsx/package.json"), true);
});

test("JSON-form COPY with flags before it reads the array, not the raw text", () => {
  assert.deepEqual(copies('FROM node\nCOPY --chown=node:node --link ["packages/sfu/package.json", "packages/sfu/"]\n'), [["packages/sfu/package.json"]]);
  assert.deepEqual(copies('FROM node\nCOPY ["a b.txt", "dest/"]\n'), [["a b.txt"]]);
});

test("continuations skip comments and blank lines, and ARG, ENV and build args expand in COPY", () => {
  const text = [
    "ARG BASE=node:22",
    "FROM ${BASE}",
    "ARG PKG=sfu",
    "ENV ROOT=packages",
    "COPY ${ROOT}/${PKG}/package.json \\",
    "# a comment inside the continuation",
    "",
    "     ${ROOT}/${PKG:-ai}/src \"${ROOT}/ui tokens\" ./",
    "COPY <<EOF /app/note.txt",
    "inline",
    "EOF",
  ].join("\n");
  assert.deepEqual(copies(text), [["packages/sfu/package.json", "packages/sfu/src", "packages/ui tokens"]]);
  assert.deepEqual(copies(text, { PKG: "apps-sdk" })[0][0], "packages/apps-sdk/package.json");
});

test("the escape directive changes the continuation character", () => {
  assert.deepEqual(copies("# escape=`\nFROM node\nCOPY a `\n  b ./\n"), [["a", "b"]]);
});

test("malformed Dockerfiles fail instead of being read wrongly", () => {
  assert.throws(() => contextCopies("FROM node\nCOPY a \\\n"), DockerfileError);
  assert.throws(() => contextCopies("FROM node\nRUN <<EOF\npnpm build\n"), DockerfileError);
  assert.throws(() => contextCopies("COPY a b\n"), DockerfileError);
});

test("context reads the guard cannot resolve fail closed", () => {
  const cases = {
    ADD: "FROM node\nADD https://example.com/x.tgz /x\n",
    ONBUILD: "FROM node\nONBUILD COPY . /app\n",
    "unknown COPY flag": "FROM node\nCOPY --parents packages/*/package.json ./\n",
    "bind mount": "FROM node\nRUN --mount=type=bind,source=packages,target=/src true\n",
    "default mount type": "FROM node\nRUN --mount=source=packages,target=/src true\n",
    "base image variable": "FROM node\nCOPY $HOME/x ./\n",
    "undeclared ARG": "FROM node\nCOPY packages/${UNDECLARED}/package.json ./\n",
  };
  for (const [name, text] of Object.entries(cases)) assert.throws(() => contextCopies(text), UnsupportedShape, name);
  assert.deepEqual(copies("FROM node\nRUN --mount=type=cache,target=/root/.cache true\nCOPY --from=build /app/dist ./dist\nCOPY a ./\n"), [["a"]]);
});

test("an image needs the workspace closure of its own package and of every package it copies from", () => {
  assert.deepEqual(imagePackages("packages/shared-browser/Dockerfile", ["package.json", "packages/shared-browser/src"], packages), ["@conclave/shared-browser"]);
  assert.deepEqual(imagePackages("Dockerfile", ["pnpm-lock.yaml", "packages/apps-sdk/package.json"], packages), ["@conclave/ai", "@conclave/apps-sdk"]);
  assert.deepEqual(imagePackages("packages/sfu/Dockerfile", [], packages), ["@conclave/ai", "@conclave/apps-sdk", "@conclave/meeting-core", "@conclave/sfu", "@conclave/shared-browser", "@conclave/ui-tokens"]);
});

test("wildcard COPY sources fail closed and missing ones are reported", (t) => {
  const root = fixture(t, {
    ".dockerignore": "",
    "docker-compose.yml": "services:\n  a:\n    build: { context: ., dockerfile: a.Dockerfile }\n  b:\n    build: { context: ., dockerfile: b.Dockerfile }\n",
    "a.Dockerfile": "FROM node\nCOPY packages/*/package.json ./\n",
    "b.Dockerfile": "FROM node\nCOPY missing.txt ../outside ./\n",
    "apps/.keep": "",
    "packages/.keep": "",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  const problems = contextProblems(root);
  assert.ok(problems.some((problem) => problem.startsWith("a.Dockerfile: unsupported shape: line 2: wildcard COPY source packages/*/package.json")));
  assert.ok(problems.includes("b.Dockerfile: line 2: COPY source missing.txt is not in the build context"));
  assert.ok(problems.includes("b.Dockerfile: line 2: COPY source ../outside is outside the build context"));
});

test("compose builds are found whatever the key order or build form", (t) => {
  const root = fixture(t, {
    "docker-compose.yml": [
      "services:",
      "  reversed:",
      "    build:",
      "      dockerfile: packages/a/Dockerfile",
      "      context: ./",
      "      args: [\"PKG=a\"]",
      "  short:",
      "    build: .",
      "  elsewhere:",
      "    build:",
      "      context: packages/b",
      "  image-only:",
      "    image: redis",
    ].join("\n"),
    "compose.yaml": "services:\n  flow: { build: { context: '.', dockerfile: 'packages/c/Dockerfile', args: { PKG: c, N: 2 } } }\n",
  });
  assert.deepEqual(rootContextBuilds(root).map(({ service, dockerfile, args }) => [service, dockerfile, args]), [
    ["short", "Dockerfile", {}],
    ["reversed", "packages/a/Dockerfile", { PKG: "a" }],
    ["flow", "packages/c/Dockerfile", { PKG: "c", N: "2" }],
  ]);
});

test("compose builds the guard cannot resolve fail closed", (t) => {
  const compose = (build) => fixture(t, { "docker-compose.yml": `services:\n  x:\n    build:\n${build}\n` });
  for (const build of [
    "      context: .\n      args: [PKG]",
    "      context: .\n      args:\n        PKG:",
    "      context: .\n      dockerfile: ${DOCKERFILE}",
    "      dockerfile_inline: FROM node",
    "      context: .\n      additional_contexts:\n        extra: ./x",
  ]) {
    assert.throws(() => rootContextBuilds(compose(build)), UnsupportedShape, build);
  }
});

test("the context walk finds nested artifacts on disk and probes every included directory", (t) => {
  const root = fixture(t, {
    "packages/a/package.json": "{}",
    "packages/a/src/index.ts": "",
    "packages/a/src/.env.local": "SECRET=1",
    "packages/a/docker/node_modules/pkg/index.js": "",
    "packages/a/node_modules/pkg/index.js": "",
    "node_modules/huge/index.js": "",
  });
  const rootOnly = dockerIgnoreMatcher("**\n!packages/a/**\npackages/a/node_modules\npackages/a/dist\npackages/a/.env\npackages/a/.env.*\npackages/a/*.log\n");
  const files = walkContext(root, rootOnly);
  assert.deepEqual(files, ["packages/a/docker/node_modules/pkg/index.js", "packages/a/package.json", "packages/a/src/.env.local", "packages/a/src/index.ts"]);
  const problems = artifactProblems(".dockerignore", rootOnly, files);
  assert.ok(problems.includes(".dockerignore: packages/a/src/.env.local is on disk and would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/a/docker/node_modules/pkg/index.js is on disk and would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/a/src/dist/probe.js would enter the build context"));
  const global = dockerIgnoreMatcher(`**\n!packages/a/**\n${dockerIgnore.split("\n").filter((line) => line.startsWith("**/")).join("\n")}\n`);
  assert.deepEqual(artifactProblems(".dockerignore", global, walkContext(root, global)), []);
});

test("every root-context image gets all of its workspace packages and none of their build artifacts", () => {
  assert.deepEqual(contextProblems(repoRoot), []);
});

test("rules that protect only package roots let nested artifacts in", () => {
  const rootOnly = dockerIgnore
    .split("\n")
    .filter((line) => !line.startsWith("**/"))
    .concat([...packages.values()].flatMap(({ dir }) => ["node_modules", "dist", ".env", ".env.*", "*.log"].map((name) => `${dir}/${name}`)))
    .join("\n");
  const problems = contextProblems(repoRoot, { dockerIgnore: rootOnly });
  assert.ok(problems.includes(".dockerignore: packages/apps-sdk/src/.env.local would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/shared-browser/docker/node_modules/probe/index.js would enter the build context"));
});

test("dropping a workspace package the SFU depends on fails the check", () => {
  const withoutAppsSdk = dockerIgnore.split("\n").filter((line) => !line.includes("packages/apps-sdk")).join("\n");
  const problems = contextProblems(repoRoot, { dockerIgnore: withoutAppsSdk });
  assert.ok(problems.some((problem) => /^packages\/sfu\/Dockerfile: line \d+: COPY source packages\/apps-sdk\/package.json is not in the build context$/.test(problem)));
  assert.ok(problems.includes("packages/sfu/Dockerfile: source packages/apps-sdk/package.json needs packages/apps-sdk/package.json, which .dockerignore excludes"));
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/apps-sdk needs packages/apps-sdk/src/index.ts, which .dockerignore excludes"));
});

test("an image may leave test files out of its packages", () => {
  assert.deepEqual(contextProblems(repoRoot, { dockerIgnore: `${dockerIgnore}\npackages/ai/test\npackages/sfu/test\npackages/shared-browser/test\n` }), []);
});

test("re-including all of packages/ without artifact rules leaks them into the context", () => {
  const problems = contextProblems(repoRoot, { dockerIgnore: "**\n!package.json\n!pnpm-lock.yaml\n!pnpm-workspace.yaml\n!patches/\n!packages/\n" });
  assert.ok(problems.includes(".dockerignore: packages/apps-sdk/node_modules/probe/index.js would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/meeting-core/.env would enter the build context"));
});


function gitFixture(t, files) {
  const root = fixture(t, { "apps/.keep": "", ...files });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const fixturePackage = {
  "docker-compose.yml": "services:\n  a:\n    build: { context: ., dockerfile: packages/a/Dockerfile }\n",
  "packages/a/package.json": JSON.stringify({ name: "@fixture/a" }),
  "packages/a/src/index.ts": "",
  "packages/a/test/index.test.ts": "",
  "packages/a/src/index.test.ts": "",
  "packages/a/src/__tests__/case.ts": "",
};

test("runtime state anywhere in the context fails the check", (t) => {
  const withoutStateRules = dockerIgnore.split("\n").filter((line) => !/data|sqlite|\.db|-wal|-shm|-journal/.test(line)).join("\n");
  const problems = contextProblems(repoRoot, { dockerIgnore: withoutStateRules });
  for (const probe of ["packages/sfu/data/conclave.sqlite", "packages/sfu/probe.sqlite-wal", "packages/apps-sdk/src/probe.db", "packages/ai/probe.db-journal"]) {
    assert.ok(problems.includes(`.dockerignore: ${probe} would enter the build context`), probe);
  }
  const root = fixture(t, { "packages/a/data/conclave.sqlite": "", "packages/a/src/cache.sqlite-shm": "", "packages/a/src/index.ts": "" });
  const open = dockerIgnoreMatcher("**\n!packages/a/**\n");
  const onDisk = artifactProblems(".dockerignore", open, walkContext(root, open)).filter((problem) => problem.includes("on disk"));
  assert.deepEqual(onDisk, [
    ".dockerignore: packages/a/data/conclave.sqlite is on disk and would enter the build context",
    ".dockerignore: packages/a/src/cache.sqlite-shm is on disk and would enter the build context",
  ]);
});

test("a directory COPY may leave test files and folders out, but a COPY that names one may not", (t) => {
  const globalRules = dockerIgnore.split("\n").filter((line) => line.startsWith("**/")).join("\n");
  const ignore = `**\n!packages/\n!packages/a/**\n${globalRules}\n**/test\n**/__tests__\n**/*.test.*\n`;
  const directory = gitFixture(t, { ...fixturePackage, ".dockerignore": ignore, "packages/a/Dockerfile": "FROM node\nCOPY packages ./packages\nCOPY packages/a/src packages/a/src\n" });
  assert.deepEqual(contextProblems(directory), []);
  const named = gitFixture(t, { ...fixturePackage, ".dockerignore": ignore, "packages/a/Dockerfile": "FROM node\nCOPY packages/a/test/index.test.ts ./\n" });
  assert.ok(contextProblems(named).includes("packages/a/Dockerfile: source packages/a/test/index.test.ts needs packages/a/test/index.test.ts, which .dockerignore excludes"));
});

test("a tracked file missing from the context fails even when no rule excludes it", (t) => {
  const root = gitFixture(t, { ...fixturePackage, ".dockerignore": "**\n!packages/\n!packages/a/**\n", "packages/a/Dockerfile": "FROM node\nCOPY packages/a ./a\n" });
  rmSync(path.join(root, "packages/a/src/index.ts"));
  const problems = contextProblems(root);
  assert.ok(problems.includes("packages/a/Dockerfile: @fixture/a needs packages/a/src/index.ts, which is tracked but missing from the build context"), JSON.stringify(problems));
  assert.ok(problems.includes("packages/a/Dockerfile: source packages/a needs packages/a/src/index.ts, which is tracked but missing from the build context"));
});

test("compose builds inherited through a YAML merge key are found", (t) => {
  const root = fixture(t, {
    "docker-compose.yml": "x-sfu: &sfu\n  build:\n    context: .\n    dockerfile: packages/sfu/Dockerfile\nservices:\n  edge:\n    <<: *sfu\n    environment: { A: b }\n",
  });
  assert.deepEqual(rootContextBuilds(root).map(({ service, dockerfile }) => [service, dockerfile]), [["edge", "packages/sfu/Dockerfile"]]);
});
