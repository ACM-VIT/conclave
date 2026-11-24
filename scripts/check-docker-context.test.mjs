import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactProblems, contextProblems, imageInputs, pnpmInvocation, repoRoot, stepProblems, workspacePackages } from "./check-docker-context.mjs";
import { ComposeError, rootContextBuilds } from "./docker-context/compose.mjs";
import { DockerfileError, commandsOf, parseDockerfile } from "./docker-context/dockerfile.mjs";
import { dockerIgnoreMatcher, walkContext } from "./docker-context/dockerignore.mjs";

const dockerIgnore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const sfuDockerfile = readFileSync(path.join(repoRoot, "packages/sfu/Dockerfile"), "utf8");
const browserDockerfile = readFileSync(path.join(repoRoot, "packages/shared-browser/Dockerfile"), "utf8");
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

const copies = (text, args) => parseDockerfile(text, args).steps.filter((step) => step.kind === "copy").map((step) => step.sources);
const pnpmCommands = (text) => parseDockerfile(text).steps.flatMap(commandsOf).map(pnpmInvocation).filter(Boolean).map((invocation) => invocation.text);
const inputsOf = (text) => {
  const { steps } = parseDockerfile(text);
  const invocations = steps.flatMap((step, index) => commandsOf(step).map(pnpmInvocation).filter(Boolean).map((invocation) => ({ ...invocation, index, instruction: step.instruction })));
  return { steps, invocations };
};

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
    "     ${ROOT}/${MISSING:-ai}/package.json \"${ROOT}/ui tokens\" ./",
    "COPY --from=build /app/dist ./dist",
    "COPY <<EOF /app/note.txt",
    "inline",
    "EOF",
  ].join("\n");
  assert.deepEqual(copies(text), [["packages/sfu/package.json", "packages/ai/package.json", "packages/ui tokens"]]);
  assert.deepEqual(copies(text, { PKG: "apps-sdk" })[0][0], "packages/apps-sdk/package.json");
});

test("the escape directive changes the continuation character", () => {
  assert.deepEqual(copies("# escape=`\nFROM node\nCOPY a `\n  b ./\n"), [["a", "b"]]);
});

test("RUN bind mounts read from the context and heredoc scripts are checked", () => {
  const text = "FROM node\nRUN --mount=type=bind,source=packages/sfu,target=/src --mount=type=cache,target=/root/.cache true\nRUN <<EOF\nset -e\npnpm -C packages/sfu run build\nEOF\n";
  assert.deepEqual(copies(text), [["packages/sfu"]]);
  assert.deepEqual(pnpmCommands(text), ["pnpm -C packages/sfu run build"]);
});

test("shell and exec forms both yield the pnpm commands they run", () => {
  assert.deepEqual(pnpmCommands("FROM node\nRUN npm i -g pnpm && CI=1 pnpm --reporter append-only install --filter '@conclave/sfu...' || exit 1\n"), ["pnpm --reporter append-only install --filter @conclave/sfu..."]);
  assert.deepEqual(pnpmCommands('FROM node\nCMD ["sh", "-c", "exec pnpm start"]\nENTRYPOINT ["/usr/bin/dumb-init", "--", "pnpm", "--dir", "packages/sfu", "start"]\n'), ["pnpm start", "pnpm --dir packages/sfu start"]);
  const install = pnpmInvocation(["pnpm", "--reporter", "append-only", "install", "--filter", "@conclave/sfu...", "-F=@conclave/ai"]);
  assert.equal(install.installs, true);
  assert.deepEqual(install.filters, ["@conclave/sfu", "@conclave/ai"]);
});

test("malformed Dockerfiles fail instead of being read wrongly", () => {
  assert.throws(() => parseDockerfile("FROM node\nCOPY a \\\n"), DockerfileError);
  assert.throws(() => parseDockerfile("FROM node\nRUN <<EOF\npnpm build\n"), DockerfileError);
  assert.throws(() => parseDockerfile("COPY a b\n"), DockerfileError);
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
    "compose.yaml": "services:\n  flow: { build: { context: '.', dockerfile: 'packages/c/Dockerfile', args: { PKG: c } } }\n",
  });
  assert.deepEqual(rootContextBuilds(root).map(({ service, dockerfile, args }) => [service, dockerfile, args]), [
    ["short", "Dockerfile", {}],
    ["reversed", "packages/a/Dockerfile", { PKG: "a" }],
    ["flow", "packages/c/Dockerfile", { PKG: "c" }],
  ]);
});

test("compose builds the check cannot resolve fail instead of being skipped", (t) => {
  const interpolated = fixture(t, { "docker-compose.yml": "services:\n  x:\n    build:\n      context: .\n      dockerfile: ${DOCKERFILE}\n" });
  assert.throws(() => rootContextBuilds(interpolated), ComposeError);
  const inline = fixture(t, { "docker-compose.yml": "services:\n  x:\n    build:\n      dockerfile_inline: FROM node\n" });
  assert.throws(() => rootContextBuilds(inline), ComposeError);
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
  assert.deepEqual(walkContext(root, rootOnly), ["packages/a/docker/node_modules/pkg/index.js", "packages/a/package.json", "packages/a/src/.env.local", "packages/a/src/index.ts"]);
  const problems = artifactProblems(root, ".dockerignore", rootOnly);
  assert.ok(problems.includes(".dockerignore: packages/a/src/.env.local is on disk and would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/a/docker/node_modules/pkg/index.js is on disk and would enter the build context"));
  assert.ok(problems.includes(".dockerignore: packages/a/src/dist/probe.js would enter the build context"));
  assert.deepEqual(artifactProblems(root, ".dockerignore", dockerIgnoreMatcher("**\n!packages/a/**\n**/node_modules\n**/dist\n**/.env\n**/.env.*\n**/*.log\n")), []);
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
  assert.deepEqual(stepProblems("packages/sfu/Dockerfile", inputsOf(withoutAppsSdkManifest), packages, true), [
    "packages/sfu/Dockerfile: `pnpm install --filter @conclave/sfu... --frozen-lockfile --node-linker=isolated` runs before packages/apps-sdk/package.json is copied",
  ]);
  assert.deepEqual(stepProblems("packages/sfu/Dockerfile", inputsOf(sfuDockerfile), packages, true), []);
  assert.deepEqual(imageInputs(repoRoot, { dockerfile: "packages/sfu/Dockerfile", args: {} }, packages).packages, [
    "@conclave/ai", "@conclave/apps-sdk", "@conclave/meeting-core", "@conclave/sfu", "@conclave/shared-browser", "@conclave/ui-tokens",
  ]);
});

test("a pnpm script in a partial image workspace must skip the dependency reinstall", () => {
  const staging = browserDockerfile.replace(" --config.verify-deps-before-run=false", "");
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", inputsOf(staging), packages, true), [
    "packages/shared-browser/Dockerfile: RUN `pnpm -C packages/shared-browser run build` reinstalls the partial image workspace first; pass --config.verify-deps-before-run=false",
  ]);
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", inputsOf(staging), packages, false), []);
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", inputsOf(browserDockerfile), packages, true), []);
  assert.equal(stepProblems("x/Dockerfile", inputsOf('FROM node\nCMD ["pnpm", "--dir", "packages/sfu", "start"]'), packages, true).length, 1);
});
