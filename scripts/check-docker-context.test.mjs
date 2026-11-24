import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { contextProblems, dockerIgnoreMatcher, parseDockerfile, repoRoot } from "./check-docker-context.mjs";

const dockerIgnore = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8");

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

test("a package without node_modules and env excludes leaks them into the context", () => {
  const problems = contextProblems(repoRoot, "**\n!package.json\n!pnpm-lock.yaml\n!pnpm-workspace.yaml\n!patches/\n!packages/\n");
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/apps-sdk build artifact packages/apps-sdk/node_modules/.bin/tsc would enter the build context"));
  assert.ok(problems.includes("packages/sfu/Dockerfile: @conclave/meeting-core build artifact packages/meeting-core/.env would enter the build context"));
});
