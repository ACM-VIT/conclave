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
    budgetSeconds: 420,
    tasks: [
      { dir: ".", script: "test:deploy-crash" },
      { dir: ".", script: "test:deploy-fuzz" },
    ],
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
    tasks: [
      { dir: "apps/web", script: "test:unit" },
      { dir: "packages/sfu", script: "test" },
      { dir: "packages/meeting-core", script: "test" },
      { dir: "packages/ai", script: "test" },
      { dir: "packages/shared-browser", script: "test" },
      // Needs age, fuser and redis-server, which ci.yml installs for this job.
      { dir: ".", script: "test:backup" },
    ],
  },
  build: {
    budgetSeconds: 240,
    tasks: [
      { dir: "apps/web", script: "build" },
      { dir: "packages/shared-browser", script: "build" },
      { dir: ".", script: "test:deploy-preflight" },
    ],
  },
  checks: {
    budgetSeconds: 100,
    tasks: [
      { dir: ".", script: "test:quality-harness" },
      { dir: ".", script: "test:cloudflare-manifests" },
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

export function runStepProblems(workflow) {
  const problems = [];
  if (/^ {4}(if|continue-on-error):/m.test(workflow)) problems.push("the ci job has a job-level if or continue-on-error");
  const runSteps = workflow.split(/\n(?= {6}- )/).filter((step) => /^(?: {6}- | {8})run: node scripts\/ci\/run\.mjs\b/m.test(step));
  if (runSteps.length !== 1) problems.push(`expected one step running scripts/ci/run.mjs, found ${runSteps.length}`);
  for (const step of runSteps) {
    if (!/^(?: {6}- | {8})run: node scripts\/ci\/run\.mjs \$\{\{ matrix\.job \}\}$/m.test(step)) {
      problems.push("the run step must be exactly: node scripts/ci/run.mjs ${{ matrix.job }}");
    }
    if (/^ {6}- if:|^ {8}if:/m.test(step)) problems.push("the run step has an if");
    if (/^ {6}- continue-on-error:|^ {8}continue-on-error:/m.test(step)) problems.push("the run step has continue-on-error");
  }
  return problems;
}

export function leafKey(task) {
  return `${task.dir}\t${task.script ?? `exec ${task.exec}`}\t${(task.args ?? []).join(" ")}`;
}
