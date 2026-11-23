import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expandScript, jobs, leafKey, repoRoot, runStepProblems, taskName, workspacePackages } from "./jobs.mjs";

const ciTasks = Object.entries(jobs).flatMap(([job, spec]) =>
  [...(spec.before ?? []), ...spec.tasks].map((task) => ({ job, task })),
);

test("CI runs every step of pnpm check and pnpm build", () => {
  const packages = workspacePackages();
  const covered = new Set(ciTasks.map(({ task }) => leafKey(task)));
  const local = [...expandScript(".", "check", [], packages), ...expandScript(".", "build", [], packages)];
  const missing = local.filter((leaf) => !covered.has(leafKey(leaf))).map(taskName);
  assert.deepEqual(missing, [], "add these to a job in scripts/ci/jobs.mjs");
});

test("no step runs in two CI jobs", () => {
  const seen = new Map();
  const duplicates = [];
  for (const { job, task } of ciTasks) {
    const key = leafKey(task);
    if (seen.has(key)) duplicates.push(`${taskName(task)} in ${seen.get(key)} and ${job}`);
    seen.set(key, job);
  }
  assert.deepEqual(duplicates, []);
});

test("every CI task names a script that exists", () => {
  const { scriptsByDir } = workspacePackages();
  const unknown = ciTasks
    .filter(({ task }) => task.script && scriptsByDir.get(task.dir)?.[task.script] === undefined)
    .map(({ task }) => taskName(task));
  assert.deepEqual(unknown, []);
});

test("every job has a budget", () => {
  for (const [name, spec] of Object.entries(jobs)) {
    assert.ok(Number.isFinite(spec.budgetSeconds) && spec.budgetSeconds > 0, `${name} has no budget`);
  }
});

test("the workflow runs every job in scripts/ci/jobs.mjs and never skips one", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const matrix = workflow.match(/^\s+job: \[(.*)\]$/m)?.[1].split(",").map((name) => name.trim());
  assert.deepEqual(matrix?.toSorted(), Object.keys(jobs).toSorted());
  assert.deepEqual(runStepProblems(workflow), []);
});

test("the workflow guard rejects a run step that can be skipped or ignored", () => {
  const job = (step) => `jobs:\n  ci:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v7\n${step}\n      - run: echo after\n`;
  const run = "run: node scripts/ci/run.mjs ${{ matrix.job }}";
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}`)), []);
  assert.deepEqual(runStepProblems(job(`      - if: github.event_name == 'push'\n        ${run}`)), ["the run step has an if"]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}\n        if: false`)), ["the run step has an if"]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        continue-on-error: true\n        ${run}`)), ["the run step has continue-on-error"]);
  assert.deepEqual(runStepProblems(job(`      - continue-on-error: true\n        ${run}`)), ["the run step has continue-on-error"]);
  assert.deepEqual(runStepProblems(`jobs:\n  ci:\n    continue-on-error: true\n    steps:\n      - id: run\n        ${run}\n`), ["the ci job has a job-level if or continue-on-error"]);
  assert.deepEqual(runStepProblems(job("      - run: echo nothing")), ["expected one step running scripts/ci/run.mjs, found 0"]);
  const exact = "the run step must be exactly: node scripts/ci/run.mjs ${{ matrix.job }}";
  assert.deepEqual(runStepProblems(job("      - run: node scripts/ci/run.mjs ${{ matrix.job }}")), []);
  assert.deepEqual(runStepProblems(job("      - id: run\n        run: node scripts/ci/run.mjs lint")), [exact]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run} || true`)), [exact]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}; exit 0`)), [exact]);
  assert.deepEqual(runStepProblems(job("      - run: node scripts/ci/run.mjs")), [exact]);
});

test("pre and post hooks of an expanded script are CI steps too", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ci-jobs-"));
  try {
    await mkdir(path.join(root, "apps"), { recursive: true });
    await mkdir(path.join(root, "packages/sfu"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        precheck: "node pre.js",
        check: "pnpm run lint && pnpm -C packages/sfu run test",
        postcheck: "pnpm -C packages/sfu run fixtures",
        lint: "eslint .",
        prelint: "node leaf-hook.js",
      },
    }));
    await writeFile(path.join(root, "packages/sfu/package.json"), JSON.stringify({
      name: "sfu",
      scripts: { pretest: "node t.js", test: "pnpm run unit", unit: "vitest", fixtures: "tsx f.ts" },
    }));
    const leaves = expandScript(".", "check", [], workspacePackages(root)).map(taskName);
    assert.deepEqual(leaves, ["precheck", "lint", "packages/sfu pretest", "packages/sfu unit", "packages/sfu fixtures"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm filters, -C and missing scripts expand the way pnpm runs them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ci-jobs-"));
  try {
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    await mkdir(path.join(root, "packages/sfu"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        mixed: "pnpm -C apps/web --filter=sfu run fixtures",
        none: "pnpm --filter web --filter sfu run absent",
      },
    }));
    await writeFile(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "web", scripts: {} }));
    await writeFile(path.join(root, "packages/sfu/package.json"), JSON.stringify({ name: "sfu", scripts: { fixtures: "tsx f.ts" } }));
    const packages = workspacePackages(root);
    assert.deepEqual(expandScript(".", "mixed", [], packages).map(taskName), ["packages/sfu fixtures"]);
    assert.throws(() => expandScript(".", "none", [], packages), /no selected package has a "absent" script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a step added to pnpm check that CI does not run is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ci-jobs-"));
  try {
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    await mkdir(path.join(root, "packages/sfu"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        check: "pnpm run lint && pnpm --filter web --filter sfu run typecheck && pnpm -C packages/sfu run fixtures --check",
        lint: "eslint . && konsistent",
      },
    }));
    await writeFile(path.join(root, "apps/web/package.json"), JSON.stringify({ name: "web", scripts: { typecheck: "tsc" } }));
    await writeFile(path.join(root, "packages/sfu/package.json"), JSON.stringify({ name: "sfu", scripts: { fixtures: "tsx f.ts" } }));
    const leaves = expandScript(".", "check", [], workspacePackages(root)).map(taskName);
    assert.deepEqual(leaves, ["lint", "apps/web typecheck", "packages/sfu fixtures --check"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
