import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const jobs = {
  lint: {
    budgetSeconds: 150,
    before: [{ dir: "apps/web", exec: "next typegen" }],
    tasks: [
      { dir: ".", script: "lint:packages" },
      { dir: "apps/web", script: "lint" },
      { dir: ".", script: "konsistent" },
    ],
  },
  deploy: {
    budgetSeconds: 540,
    budgetFrom: "run",
    tasks: [{ dir: ".", script: "test:deploy-preflight" }, { dir: ".", script: "test:deploy-crash" }, { dir: ".", script: "test:deploy-compose" }],
  },
  "fuzz-a": {
    budgetSeconds: 1080,
    budgetFrom: "run",
    tasks: [{ dir: ".", script: "test:deploy-fuzz" }],
  },
  "fuzz-b": {
    budgetSeconds: 1080,
    budgetFrom: "run",
    tasks: [{ dir: ".", script: "test:deploy-fuzz-b" }],
  },
  "fuzz-c": {
    budgetSeconds: 1080,
    budgetFrom: "run",
    tasks: [{ dir: ".", script: "test:deploy-fuzz-c" }],
  },
  typecheck: {
    budgetSeconds: 75,
    tasks: [
      { dir: "apps/web", script: "typecheck" },
      { dir: "packages/apps-sdk", script: "typecheck" },
      { dir: "packages/meeting-core", script: "typecheck" },
      { dir: "packages/ai", script: "typecheck" },
      { dir: "packages/sfu", script: "typecheck" },
      { dir: "packages/shared-browser", script: "typecheck" },
    ],
  },
  test: {
    budgetSeconds: 110,
    budgetFrom: "run",
    tasks: [
      { dir: "apps/web", script: "test:unit-a" },
      { dir: "packages/meeting-core", script: "test" },
      { dir: "packages/ai", script: "test" },
      { dir: "packages/shared-browser", script: "test" },
    ],
  },
  "test-web-unit-b": {
    budgetSeconds: 110,
    budgetFrom: "run",
    tasks: [{ dir: "apps/web", script: "test:unit-b" }],
  },
  "test-sfu": {
    budgetSeconds: 110,
    budgetFrom: "run",
    tasks: [{ dir: "packages/sfu", script: "test:unit", args: ["--shard=1/2"] }],
  },
  "test-sfu-b": {
    budgetSeconds: 110,
    budgetFrom: "run",
    tasks: [{ dir: "packages/sfu", script: "test:unit", args: ["--shard=2/2"] }],
  },
  "test-transcript-oracle": {
    budgetSeconds: 300,
    budgetFrom: "run",
    tasks: [{ dir: "apps/web", script: "test:transcript-oracle" }],
  },
  "test-backup": {
    budgetSeconds: 300,
    budgetFrom: "run",
    tasks: [{ dir: ".", script: "test:backup" }],
  },
  "test-sfu-app-model": {
    budgetSeconds: 110,
    budgetFrom: "run",
    tasks: [{ dir: "packages/sfu", script: "test:apps-room-model" }],
  },
  build: {
    budgetSeconds: 240,
    tasks: [
      { dir: "apps/web", script: "build" },
      { dir: "packages/shared-browser", script: "build" },
    ],
  },

  checks: {
    budgetSeconds: 100,
    tasks: [
      { dir: ".", script: "test:quality-harness" },
      { dir: ".", script: "test:cloudflare-manifests" },
      { dir: ".", script: "test:docker-context" },
      { dir: ".", script: "test:native-tokens" },
      { dir: ".", script: "test:native-icons" },
      { dir: "packages/apps-sdk", script: "test:native-embed" },
      { dir: "packages/apps-sdk", script: "test:native-embed-apps" },
      { dir: "packages/apps-sdk", script: "test:scripts" },
      { dir: "packages/apps-sdk", script: "check:apps" },
      { dir: ".", script: "check:video-effect-assets" },
      { dir: ".", script: "check:swift-events" },
      { dir: ".", script: "check:native-tokens" },
      { dir: ".", script: "check:native-icons" },
      { dir: "packages/apps-sdk", script: "check:native-embed" },
      { dir: ".", script: "check:native-emoji" },
      { dir: ".", script: "check:native-test-stores" },
      { dir: ".", script: "test:native-test-stores" },
      { dir: ".", script: "check:native-game-fixtures" },
      { dir: ".", script: "check:join-deadlines" },
      { dir: ".", script: "check:json-store-fixtures" },
      { dir: ".", script: "check:docker-context" },
      { dir: ".", script: "check:sfu-source-manifest" },
      { dir: ".", exec: "node --test scripts/ci/*.test.mjs" },
    ],
  },
};

export function taskName(task) {
  const where = task.dir === "." ? "" : `${task.dir} `;
  const what = task.script ?? task.exec;
  return `${where}${what}${task.args?.length ? ` ${task.args.join(" ")}` : ""}`;
}

export function taskCommand(task) {
  if (task.exec) return `pnpm --dir ${task.dir} exec ${task.exec}`;
  return ["pnpm", "--dir", task.dir, "run", task.script, ...(task.args ?? [])].join(" ");
}

export function workspacePackages(root = repoRoot) {
  const byName = new Map();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      const manifest = path.join(root, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      byName.set(pkg.name, { dir: `${parent}/${entry.name}`, scripts: pkg.scripts ?? {} });
    }
  }
  const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return { byName, scriptsByDir: new Map([[".", rootPkg.scripts ?? {}], ...[...byName.values()].map((p) => [p.dir, p.scripts])]) };
}

function tokenize(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function parsePnpmRun(command, cwd, byName) {
  const tokens = tokenize(command);
  if (tokens[0] !== "pnpm") return null;
  let dir = cwd;
  const selected = [];
  let i = 1;
  while (i < tokens.length && tokens[i] !== "run") {
    const [flag, inline] = tokens[i].split("=", 2);
    const value = inline ?? tokens[i + 1];
    if ((flag === "-C" || flag === "--dir") && value) dir = path.posix.join(cwd, value);
    else if (flag === "--filter" && byName.has(value)) selected.push(byName.get(value).dir);
    else return null;
    i += inline === undefined ? 2 : 1;
  }
  if (tokens[i] !== "run" || !tokens[i + 1]) return null;
  return { dirs: selected.length ? selected : [dir], filtered: selected.length > 0, script: tokens[i + 1], args: tokens.slice(i + 2) };
}

export function expandScript(dir, script, args = [], packages = workspacePackages()) {
  const scripts = packages.scriptsByDir.get(dir) ?? {};
  const body = scripts[script];
  if (body === undefined) throw new Error(`no script "${script}" in ${dir}`);
  const parts = body.split("&&").map((part) => part.trim());
  const runs = parts.map((part) => parsePnpmRun(part, dir, packages.byName));
  if (args.length || runs.some((run) => run === null)) return [{ dir, script, args }];
  const hook = (name) => (scripts[name] === undefined ? [] : expandScript(dir, name, [], packages));
  return [...hook(`pre${script}`), ...runs.flatMap((run) => {
    const targets = run.filtered
      ? run.dirs.filter((target) => packages.scriptsByDir.get(target)?.[run.script] !== undefined)
      : run.dirs;
    if (!targets.length) throw new Error(`no selected package has a "${run.script}" script in ${dir} ${script}`);
    return targets.flatMap((target) => expandScript(target, run.script, run.args, packages));
  }), ...hook(`post${script}`)];
}

export function runStepProblems(job) {
  const problems = [];
  if ("if" in job || "continue-on-error" in job) problems.push("the ci job has a job-level if or continue-on-error");
  const runSteps = (job.steps ?? []).filter((step) => /^node scripts\/ci\/run\.mjs\b/.test(step.run));
  if (runSteps.length !== 1) problems.push(`expected one step running scripts/ci/run.mjs, found ${runSteps.length}`);
  for (const step of runSteps) {
    if (step.run !== 'node scripts/ci/run.mjs "$CI_JOB"') {
      problems.push("the run step must select only the configured CI job");
    }
    if (Object.hasOwn(step.env ?? {}, "CI_JOB")) problems.push("the run step overrides the configured CI job");
    if ("if" in step) problems.push("the run step has an if");
    if ("continue-on-error" in step) problems.push("the run step has continue-on-error");
  }
  return problems;
}

export function leafKey(task) {
  return `${task.dir}\t${task.script ?? `exec ${task.exec}`}\t${(task.args ?? []).join(" ")}`;
}
