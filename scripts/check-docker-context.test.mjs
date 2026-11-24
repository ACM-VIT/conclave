import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { contextProblems, dockerIgnoreMatcher, parseDockerfile, repoRoot, stepProblems, workspacePackages } from "./check-docker-context.mjs";

const dockerIgnore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");
const sfuDockerfile = readFileSync(path.join(repoRoot, "packages/sfu/Dockerfile"), "utf8");
const browserDockerfile = readFileSync(path.join(repoRoot, "packages/shared-browser/Dockerfile"), "utf8");
const packages = workspacePackages(repoRoot);

test("a re-included directory brings its whole subtree back, as Docker does", () => {
  const excluded = dockerIgnoreMatcher("**\n!packages/\n");
  assert.equal(excluded("packages/apps-sdk/src/index.ts"), false);
  assert.equal(excluded("apps/web/package.json"), true);
});

test("the last matching pattern wins and single stars stay inside one segment", () => {
  const excluded = dockerIgnoreMatcher("**\n!packages/sfu/**\npackages/sfu/*.log\n**/node_modules\n");
  assert.equal(excluded("packages/sfu/server.ts"), false);
  assert.equal(excluded("packages/sfu/boot.log"), true);
  assert.equal(excluded("packages/sfu/logs/boot.log"), false);
  assert.equal(excluded("packages/sfu/node_modules/tsx/package.json"), true);
});

test("COPY sources and pnpm filters are read from the Dockerfile", () => {
  const parsed = parseDockerfile([
    "COPY package.json pnpm-lock.yaml ./",
    "COPY --chown=node:node packages/a/package.json \\",
    "  packages/a/",
    "COPY --from=build /app/dist ./dist",
    "RUN pnpm install --filter @conclave/a... --frozen-lockfile",
    "COPY . .",
  ].join("\n"));
  assert.deepEqual(parsed.copySources, ["package.json", "pnpm-lock.yaml", "packages/a/package.json"]);
  assert.deepEqual(parsed.filters, ["@conclave/a"]);
});

test("every root-context image gets all of its workspace packages and none of their build artifacts", () => {
  assert.deepEqual(contextProblems(repoRoot, dockerIgnore), []);
});

test("dropping a workspace package the SFU depends on fails the check", () => {
  const withoutAppsSdk = dockerIgnore.split("\n").filter((line) => !line.includes("packages/apps-sdk")).join("\n");
  const problems = contextProblems(repoRoot, withoutAppsSdk);
  assert.ok(problems.includes("packages/sfu/Dockerfile: COPY source packages/apps-sdk/package.json needs packages/apps-sdk/package.json, which .dockerignore excludes"));
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/apps-sdk needs packages/apps-sdk/src/index.ts, which .dockerignore excludes"));
});

test("an image may leave test files out of its packages", () => {
  const withoutTests = `${dockerIgnore}\npackages/ai/test\npackages/sfu/test\npackages/shared-browser/test\n`;
  assert.deepEqual(contextProblems(repoRoot, withoutTests), []);
});

test("a package without node_modules and env excludes leaks them into the context", () => {
  const problems = contextProblems(repoRoot, "**\n!package.json\n!pnpm-lock.yaml\n!pnpm-workspace.yaml\n!patches/\n!packages/\n");
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/apps-sdk build artifact packages/apps-sdk/node_modules/.bin/tsc would enter the build context"));
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/meeting-core build artifact packages/meeting-core/.env would enter the build context"));
});

test("the SFU install fails the check when a workspace manifest it needs is not copied first", () => {
  const withoutAppsSdkManifest = sfuDockerfile.split("\n").filter((line) => !line.includes("packages/apps-sdk/package.json")).join("\n");
  assert.deepEqual(stepProblems("packages/sfu/Dockerfile", parseDockerfile(withoutAppsSdkManifest), packages, true), [
    "packages/sfu/Dockerfile: `pnpm install --filter @conclave/sfu... --frozen-lockfile --node-linker=isolated` runs before packages/apps-sdk/package.json is copied",
  ]);
  assert.deepEqual(stepProblems("packages/sfu/Dockerfile", parseDockerfile(sfuDockerfile), packages, true), []);
});

test("a pnpm script in a partial image workspace must skip the dependency reinstall", () => {
  const staging = browserDockerfile.replace(" --config.verify-deps-before-run=false", "");
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", parseDockerfile(staging), packages, true), [
    "packages/shared-browser/Dockerfile: RUN `pnpm -C packages/shared-browser run build` reinstalls the partial image workspace first; pass --config.verify-deps-before-run=false",
  ]);
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", parseDockerfile(staging), packages, false), []);
  assert.deepEqual(stepProblems("packages/shared-browser/Dockerfile", parseDockerfile(browserDockerfile), packages, true), []);
  assert.deepEqual(stepProblems("x/Dockerfile", parseDockerfile('CMD ["pnpm", "--dir", "packages/sfu", "start"]'), packages, true).length, 1);
});
