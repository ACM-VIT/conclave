import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactProblems, contextProblems, repoRoot, workspacePackages } from "./check-docker-context.mjs";
import { rootContextBuilds } from "./docker-context/compose.mjs";
import { DockerfileError, commandsOf, parseDockerfile } from "./docker-context/dockerfile.mjs";
import { dockerIgnoreMatcher, walkContext } from "./docker-context/dockerignore.mjs";
import { evaluateImage, parsePnpm } from "./docker-context/image.mjs";
import { UnsupportedShape } from "./docker-context/unsupported.mjs";

const dockerIgnore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const sfuDockerfile = readFileSync(path.join(repoRoot, "packages/sfu/Dockerfile"), "utf8");
const browserDockerfile = readFileSync(path.join(repoRoot, "packages/shared-browser/Dockerfile"), "utf8");
const packages = workspacePackages(repoRoot);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "docker-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}

const copies = (text, args) => parseDockerfile(text, args).steps.filter((step) => step.kind === "copy").map((step) => step.sources);
const pnpmCommands = (text) => parseDockerfile(text).steps.flatMap(commandsOf).map(parsePnpm).filter(Boolean).map((invocation) => invocation.text);
const evaluate = (text, contextFiles = tracked) => evaluateImage({ dockerfile: "Dockerfile", steps: parseDockerfile(text).steps, contextFiles, packages });
const problemsOf = (text, contextFiles) => evaluate(text, contextFiles).problems;
const rootFiles = "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./";
const sfuInstall = "RUN pnpm install --filter @conclave/sfu... --frozen-lockfile";
const missing = (file) => `Dockerfile: line 5: RUN \`pnpm install --filter @conclave/sfu... --frozen-lockfile\` runs before ${file} is copied`;
const sfuManifests = ["ai", "apps-sdk", "meeting-core", "sfu", "shared-browser", "ui-tokens"].map((name) => `packages/${name}/package.json`);

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

test("shell, exec and heredoc forms all yield the pnpm commands they run", () => {
  assert.deepEqual(pnpmCommands("FROM node\nRUN npm i -g pnpm@12 && CI=1 pnpm --reporter append-only install --filter '@conclave/sfu...' || exit 1\n"), ["pnpm --reporter append-only install --filter @conclave/sfu..."]);
  assert.deepEqual(pnpmCommands('FROM node\nCMD ["sh", "-c", "exec pnpm start"]\nENTRYPOINT ["/usr/bin/dumb-init", "--", "pnpm", "--dir", "packages/sfu", "start"]\n'), ["pnpm start", "pnpm --dir packages/sfu start"]);
  assert.deepEqual(pnpmCommands("FROM node\nRUN --mount=type=cache,target=/root/.cache <<EOF\nset -e\npnpm -C packages/sfu run build\nEOF\n"), ["pnpm -C packages/sfu run build"]);
});

test("malformed Dockerfiles fail instead of being read wrongly", () => {
  assert.throws(() => parseDockerfile("FROM node\nCOPY a \\\n"), DockerfileError);
  assert.throws(() => parseDockerfile("FROM node\nRUN <<EOF\npnpm build\n"), DockerfileError);
  assert.throws(() => parseDockerfile("COPY a b\n"), DockerfileError);
});

test("shapes the guard cannot evaluate exactly fail closed", () => {
  const cases = {
    "unknown instruction": "FROM node\nSHELL [\"bash\", \"-c\"]\n",
    "ADD": "FROM node\nADD https://example.com/x.tgz /x\n",
    "unknown COPY flag": "FROM node\nCOPY --parents packages/*/package.json ./\n",
    "bind mount": "FROM node\nRUN --mount=type=bind,source=packages,target=/src true\n",
    "base image variable": "FROM node\nCOPY $HOME/x ./\n",
    "unresolved ARG": "FROM node\nCOPY packages/${UNDECLARED}/package.json ./\n",
    "command substitution": "FROM node\nRUN pnpm install --filter $(cat name)\n",
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.throws(() => evaluate(text), UnsupportedShape, name);
  }
  const unsupportedPnpm = {
    "wildcard COPY": `FROM node\nWORKDIR /app\nCOPY packages/*/package.json ./\n`,
    "cd before pnpm": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN cd packages/sfu && pnpm install --filter @conclave/sfu...\n`,
    "unknown pnpm flag": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN pnpm install --filter @conclave/sfu... --mystery\n`,
    "install without filter": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN pnpm install --frozen-lockfile\n`,
    "pnpm add": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN pnpm add left-pad\n`,
    "pnpm through npx": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN npx pnpm install --filter @conclave/sfu...\n`,
    "shell variable": `FROM node\nWORKDIR /app\n${rootFiles}\nRUN pnpm install --filter "$PKG"\n`,
  };
  for (const [name, text] of Object.entries(unsupportedPnpm)) {
    assert.throws(() => evaluate(text), UnsupportedShape, name);
  }
});

test("a directory COPY makes every file under it available", () => {
  for (const copy of ["COPY packages/ packages/", "COPY packages ./packages", "COPY packages /app/packages/"]) {
    assert.deepEqual(problemsOf(`FROM node\nWORKDIR /app\n${rootFiles}\n${copy}\n${sfuInstall}\n`), [], copy);
  }
  assert.deepEqual(problemsOf(`FROM node\nWORKDIR /app\nCOPY . .\nRUN true\n${sfuInstall}\n`), []);
  assert.deepEqual(problemsOf(`FROM node\nWORKDIR /app\n${rootFiles}\nCOPY packages/sfu packages/\n${sfuInstall}\n`), [
    ...sfuManifests.map(missing),
  ]);
});

test("each FROM starts from what that stage can prove, not from earlier copies", () => {
  const deps = `FROM node AS deps\nWORKDIR /app\n${rootFiles}\nCOPY packages/ packages/\n`;
  const install = "RUN pnpm install --filter @conclave/sfu... --frozen-lockfile";
  const line = (n) => (file) => `Dockerfile: line ${n}: RUN \`pnpm install --filter @conclave/sfu... --frozen-lockfile\` runs before ${file} is copied`;
  assert.deepEqual(problemsOf(`${deps}FROM node\nWORKDIR /app\n${install}\n`), [`Dockerfile: line 7: RUN \`pnpm install --filter @conclave/sfu... --frozen-lockfile\` runs before pnpm-workspace.yaml is copied`]);
  assert.deepEqual(problemsOf(`${deps}FROM deps\n${install}\n`), []);
  assert.deepEqual(problemsOf(`${deps}FROM node\nWORKDIR /srv\nCOPY --from=deps /app ./\n${install}\n`), []);
  assert.deepEqual(problemsOf(`${deps}FROM node\nWORKDIR /app\nCOPY --from=node:22 /app ./\n${rootFiles}\n${install}\n`), [
    ...sfuManifests.map(line(9)),
  ]);
  assert.deepEqual(problemsOf(`FROM node\nWORKDIR /app\n${rootFiles}\nRUN mkdir -p packages && cp -r /src/packages packages\n${install}\n`), [
    ...sfuManifests.map(line(5)),
  ]);
});

test("directory filter selectors resolve, and unknown selectors fail closed", () => {
  const withSelector = (selector, copy = "COPY packages/ packages/") => `FROM node\nWORKDIR /app\n${rootFiles}\n${copy}\nRUN pnpm install --filter ${selector} --frozen-lockfile\n`;
  assert.deepEqual(problemsOf(withSelector("./packages/sfu...")), []);
  assert.deepEqual(evaluate(withSelector("./packages/sfu...")).selected, ["@conclave/ai", "@conclave/apps-sdk", "@conclave/meeting-core", "@conclave/sfu", "@conclave/shared-browser", "@conclave/ui-tokens"]);
  const withoutAppsSdk = tracked.filter((file) => file !== "packages/apps-sdk/package.json");
  assert.deepEqual(problemsOf(withSelector("./packages/sfu..."), withoutAppsSdk), [
    "Dockerfile: line 5: RUN `pnpm install --filter ./packages/sfu... --frozen-lockfile` runs before packages/apps-sdk/package.json is copied",
  ]);
  for (const selector of ["...@conclave/sfu", "@conclave/*", "{./packages/sfu}", "@conclave/unknown", "./packages/missing...", "!@conclave/ai"]) {
    assert.throws(() => evaluate(withSelector(`'${selector}'`)), UnsupportedShape, selector);
  }
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
  const global = dockerIgnoreMatcher("**\n!packages/a/**\n**/node_modules\n**/dist\n**/.env\n**/.env.*\n**/*.log\n");
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
  assert.ok(problems.includes("packages/sfu/Dockerfile: line 20: COPY source packages/apps-sdk/package.json is not in the build context"));
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

test("the SFU install fails the check when a workspace manifest it needs is not copied first", () => {
  const withoutAppsSdkManifest = sfuDockerfile.split("\n").filter((line) => !line.includes("packages/apps-sdk/package.json")).join("\n");
  assert.deepEqual(problemsOf(withoutAppsSdkManifest).map((problem) => problem.replace(/line \d+/, "line N")), [
    "Dockerfile: line N: RUN `pnpm install --filter @conclave/sfu... --frozen-lockfile --node-linker=isolated` runs before packages/apps-sdk/package.json is copied",
  ]);
  assert.deepEqual(problemsOf(sfuDockerfile), []);
});

test("a pnpm script in a partial image workspace must skip the dependency reinstall", () => {
  const staging = browserDockerfile.replace(" --config.verify-deps-before-run=false", "");
  assert.deepEqual(problemsOf(staging), [
    "Dockerfile: line 14: RUN `pnpm -C packages/shared-browser run build` reinstalls the partial image workspace first; pass --config.verify-deps-before-run=false",
  ]);
  assert.deepEqual(problemsOf(browserDockerfile), []);
  const start = `FROM node\nWORKDIR /app\nCOPY . .\nCMD ["pnpm", "--dir", "packages/sfu", "start"]\n`;
  assert.equal(problemsOf(start, tracked.filter((file) => !file.startsWith("apps/"))).length, 1);
  assert.deepEqual(problemsOf(start), []);
});
