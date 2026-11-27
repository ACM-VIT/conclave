import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
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

test("SFU tests have their own runner", async () => {
  const workflow = parse(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  assert.deepEqual(jobs["test-sfu"]?.tasks, [{ dir: "packages/sfu", script: "test" }]);
  assert.equal(workflow.jobs["test-sfu"].env.CI_JOB, "test-sfu");
  assert.equal(workflow.jobs["test-unit"].env.CI_JOB, "test");
});

test("the required test check fails unless every test runner succeeds", async () => {
  const workflow = parse(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  const gate = workflow.jobs["test-result"];
  assert.equal(gate?.name, "test");
  assert.deepEqual(gate.needs, ["test-unit", "test-sfu", "test-backup"]);
  assert.equal(gate.if, "${{ always() }}");
  assert.equal("continue-on-error" in gate, false);
  assert.equal(gate.steps.length, 1);
  const [step] = gate.steps;
  assert.equal("if" in step || "continue-on-error" in step, false);
  assert.deepEqual(step.env, {
    TEST_UNIT_RESULT: "${{ needs.test-unit.result }}",
    TEST_SFU_RESULT: "${{ needs.test-sfu.result }}",
    TEST_BACKUP_RESULT: "${{ needs.test-backup.result }}",
  });
  const results = ["success", "failure", "cancelled", "skipped"];
  for (const unit of results) {
    for (const sfu of results) {
      for (const backup of results) {
        const check = spawnSync("bash", ["-ec", step.run], {
          env: { ...process.env, TEST_UNIT_RESULT: unit, TEST_SFU_RESULT: sfu, TEST_BACKUP_RESULT: backup },
        });
        assert.ifError(check.error);
        assert.equal(check.status, unit === "success" && sfu === "success" && backup === "success" ? 0 : 1, `${unit}, ${sfu}, ${backup}`);
      }
    }
  }
});

test("test budgets always start with the run step", async () => {
  const bin = await mkdtemp(path.join(tmpdir(), "ci-test-clock-"));
  try {
    await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    for (const job of ["test", "test-sfu"]) {
      for (const miss of [false, true]) {
        const result = spawnSync(process.execPath, ["scripts/ci/run.mjs", job], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: [bin, process.env.PATH].join(path.delimiter),
            CI_JOB_STARTED_AT: "1",
            CI_BUDGET_FROM: miss ? "setup ended, as node_modules missed the cache" : "",
            GITHUB_STEP_SUMMARY: "",
          },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, new RegExp(`### ${job}: all passed, [\\d.]+s since the start of the run step, budget 110s`));
      }
    }
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});

test("the workflow runs every job in scripts/ci/jobs.mjs and never skips one", async () => {
  const workflow = parse(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  const runners = [workflow.jobs.ci, workflow.jobs["test-unit"], workflow.jobs["test-sfu"], workflow.jobs["test-backup"]];
  const matrix = runners.flatMap((job) => job.strategy?.matrix.job ?? [job.env.CI_JOB]);
  assert.equal(workflow.jobs.ci.env.CI_JOB, "${{ matrix.job }}");
  assert.deepEqual(matrix.toSorted(), Object.keys(jobs).toSorted());
  for (const runner of runners) assert.deepEqual(runStepProblems(runner), []);
});

test("the workflow guard rejects a run step that can be skipped or ignored", () => {
  const job = (step) => parse(`jobs:\n  ci:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v7\n${step}\n      - run: echo after\n`).jobs.ci;
  const run = 'run: node scripts/ci/run.mjs "$CI_JOB"';
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}`)), []);
  assert.deepEqual(runStepProblems(job(`      - if: github.event_name == 'push'\n        ${run}`)), ["the run step has an if"]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}\n        if: false`)), ["the run step has an if"]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        continue-on-error: true\n        ${run}`)), ["the run step has continue-on-error"]);
  assert.deepEqual(runStepProblems(job(`      - continue-on-error: true\n        ${run}`)), ["the run step has continue-on-error"]);
  assert.deepEqual(runStepProblems(job(`      - id: run\n        ${run}\n        env:\n          CI_JOB: lint`)), ["the run step overrides the configured CI job"]);
  assert.deepEqual(runStepProblems({ ...job(`      - ${run}`), "continue-on-error": true }), ["the ci job has a job-level if or continue-on-error"]);
  assert.deepEqual(runStepProblems(job("      - run: echo nothing")), ["expected one step running scripts/ci/run.mjs, found 0"]);
  const exact = "the run step must select only the configured CI job";
  assert.deepEqual(runStepProblems(job(`      - ${run}`)), []);
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

test("the backup suite runs with its dependency install and is required by the test check", async () => {
  const workflow = parse(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
  const assignment = ciTasks.filter(({ task }) => task.script === "test:backup").map(({ job }) => job);
  assert.deepEqual(assignment, ["test-backup"]);
  const runner = workflow.jobs["test-backup"];
  assert.equal(runner?.env.CI_JOB, "test-backup");
  const installs = runner.steps.filter(({ run }) => run?.includes("apt-get install"));
  assert.equal(installs.length, 1);
  assert.equal(installs[0].if, "env.CI_JOB == 'test-backup'");
  for (const tool of ["age", "psmisc", "redis-server"]) assert.ok(installs[0].run.includes(tool));
  const gate = workflow.jobs["test-result"];
  assert.ok(gate.needs.includes("test-backup"));
  assert.equal(gate.steps[0].env.TEST_BACKUP_RESULT, "${{ needs.test-backup.result }}");
  assert.match(gate.steps[0].run, /"\$TEST_BACKUP_RESULT" = success/);
});
