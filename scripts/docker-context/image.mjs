import path from "node:path";

import { cleanPattern } from "./dockerignore.mjs";
import { commandsOf, stripCommandPrefix } from "./dockerfile.mjs";
import { UnsupportedShape } from "./unsupported.mjs";

export const VERIFY_DEPS_OFF = "--config.verify-deps-before-run=false";

const ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const VALUE_FLAGS = new Set(["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel", "--node-linker", "--store-dir", "--virtual-store-dir", "--workspace-concurrency"]);
const BOOLEAN_FLAGS = new Set(["--frozen-lockfile", "--no-frozen-lockfile", "--prefer-offline", "--offline", "--prod", "-P", "--ignore-scripts", "--silent", "-s", "--if-present", "--strict-peer-dependencies"]);
const INSTALLS = new Set(["install", "i"]);
const DEPENDENCY_CHANGES = new Set(["add", "remove", "rm", "update", "up", "deploy", "fetch", "rebuild", "prune", "link", "unlink", "import", "dedupe", "patch", "patch-commit"]);
const WILDCARD = /[*?[]/;

const imagePath = (base, target) => path.posix.resolve(base, target);

export function parsePnpm(words) {
  const argv = stripCommandPrefix(words);
  if (path.posix.basename(argv[0] ?? "") !== "pnpm") {
    if (argv.slice(1).some((word) => path.posix.basename(word) === "pnpm")) throw new UnsupportedShape(`pnpm run through \`${argv.join(" ")}\``);
    return null;
  }
  const text = argv.join(" ");
  if (argv.some((word) => word.includes("$"))) throw new UnsupportedShape(`a shell variable in \`${text}\``);
  const invocation = { text, dir: null, selectors: [], verifiesDeps: true, subcommand: null };
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i];
    if (!word.startsWith("-")) {
      invocation.subcommand = word;
      if (!INSTALLS.has(word)) break;
      continue;
    }
    if (word === VERIFY_DEPS_OFF) {
      invocation.verifiesDeps = false;
      continue;
    }
    if (word.startsWith("--config.")) continue;
    const eq = word.indexOf("=");
    const flag = eq === -1 ? word : word.slice(0, eq);
    if (BOOLEAN_FLAGS.has(flag) && eq === -1) continue;
    if (!VALUE_FLAGS.has(flag)) throw new UnsupportedShape(`pnpm flag ${flag} in \`${text}\``);
    const value = eq === -1 ? argv[++i] : word.slice(eq + 1);
    if (value === undefined) throw new UnsupportedShape(`pnpm flag ${flag} without a value in \`${text}\``);
    if (flag === "-C" || flag === "--dir") invocation.dir = value;
    else if (flag === "--filter" || flag === "-F") invocation.selectors.push(value);
  }
  if (invocation.subcommand === null) throw new UnsupportedShape(`pnpm with no command in \`${text}\``);
  if (DEPENDENCY_CHANGES.has(invocation.subcommand)) throw new UnsupportedShape(`pnpm ${invocation.subcommand} in \`${text}\``);
  invocation.installs = INSTALLS.has(invocation.subcommand);
  return invocation;
}

function resolveSelector(selector, cwd, workspaceRoot, packages, text) {
  const withDependencies = selector.endsWith("...");
  const target = withDependencies ? selector.slice(0, -3) : selector;
  if (/^[@a-z0-9][@a-z0-9._/-]*$/i.test(target) && !target.startsWith(".") && packages.has(target)) return { name: target, withDependencies };
  if (target.startsWith("./") || target.startsWith("../")) {
    const relative = path.posix.relative(workspaceRoot, imagePath(cwd, target));
    const match = [...packages].find(([, pkg]) => pkg.dir === relative);
    if (match) return { name: match[0], withDependencies };
  }
  throw new UnsupportedShape(`pnpm filter selector "${selector}" in \`${text}\``);
}

function dependencyClosure(selection, packages) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    packages.get(name).workspaceDeps.forEach(visit);
  };
  selection.filter((item) => item.withDependencies).forEach((item) => visit(item.name));
  selection.forEach((item) => seen.add(item.name));
  return [...seen].sort();
}

function copyFromContext(stage, step, contextFiles, problems, dockerfile) {
  const destBase = imagePath(stage.workdir, step.dest);
  const intoDirectory = step.dest.endsWith("/") || step.sources.length > 1;
  for (const raw of step.sources) {
    const source = cleanPattern(raw);
    if (WILDCARD.test(source)) throw new UnsupportedShape(`line ${step.line}: wildcard COPY source ${raw}`);
    if (source === ".." || source.startsWith("../")) {
      problems.push(`${dockerfile}: line ${step.line}: COPY source ${raw} is outside the build context`);
      continue;
    }
    const exact = source !== "." && contextFiles.has(source);
    const prefix = source === "." ? "" : `${source}/`;
    const under = [...contextFiles].filter((file) => file.startsWith(prefix));
    if (!exact && !under.length) {
      problems.push(`${dockerfile}: line ${step.line}: COPY source ${raw} is not in the build context`);
      continue;
    }
    if (exact) {
      const existingDirectory = [...stage.files.keys()].some((file) => file.startsWith(`${destBase}/`));
      stage.files.set(intoDirectory || existingDirectory ? path.posix.join(destBase, path.posix.basename(source)) : destBase, source);
    } else {
      for (const file of under) stage.files.set(path.posix.join(destBase, file.slice(prefix.length)), file);
    }
  }
}

function copyFromStage(stage, step, source) {
  const destBase = imagePath(stage.workdir, step.dest);
  const intoDirectory = step.dest.endsWith("/") || step.sources.length > 1;
  for (const raw of step.sources) {
    if (WILDCARD.test(raw)) throw new UnsupportedShape(`line ${step.line}: wildcard COPY --from source ${raw}`);
    const from = imagePath("/", raw);
    for (const [file, origin] of source.files) {
      if (file === from) stage.files.set(intoDirectory ? path.posix.join(destBase, path.posix.basename(file)) : destBase, origin);
      else if (file.startsWith(`${from === "/" ? "" : from}/`)) stage.files.set(path.posix.join(destBase, file.slice(from === "/" ? 1 : from.length + 1)), origin);
    }
  }
}

function workspaceRootOf(stage) {
  const roots = [...stage.files].filter(([, origin]) => origin === "pnpm-workspace.yaml").map(([file]) => path.posix.dirname(file));
  if (roots.length > 1) throw new UnsupportedShape(`pnpm-workspace.yaml is copied to ${roots.join(" and ")}`);
  return roots[0] ?? null;
}

function present(stage, root, file) {
  return stage.files.get(path.posix.join(root, file)) === file;
}

function checkPnpm(invocation, stage, step, packages, dockerfile, problems, selected) {
  const where = `${dockerfile}: line ${step.line}: ${step.instruction} \`${invocation.text}\``;
  const root = workspaceRootOf(stage);
  if (root === null) {
    problems.push(`${where} runs before pnpm-workspace.yaml is copied`);
    return;
  }
  const cwd = imagePath(stage.workdir, invocation.dir ?? ".");
  if (cwd !== root && !cwd.startsWith(`${root}/`)) throw new UnsupportedShape(`${where} runs outside the workspace at ${root}`);
  if (invocation.installs) {
    if (!invocation.selectors.length) throw new UnsupportedShape(`${where} installs without --filter`);
    const names = dependencyClosure(invocation.selectors.map((selector) => resolveSelector(selector, cwd, root, packages, invocation.text)), packages);
    names.forEach((name) => selected.add(name));
    for (const file of [...ROOT_FILES, ...names.map((name) => `${packages.get(name).dir}/package.json`)]) {
      if (!present(stage, root, file)) problems.push(`${where} runs before ${file} is copied`);
    }
    return;
  }
  const partial = [...packages.values()].some(({ dir }) => !present(stage, root, `${dir}/package.json`));
  if (partial && invocation.verifiesDeps) problems.push(`${where} reinstalls the partial image workspace first; pass ${VERIFY_DEPS_OFF}`);
}

export function evaluateImage({ dockerfile, steps, contextFiles, packages }) {
  const files = contextFiles instanceof Set ? contextFiles : new Set(contextFiles);
  const problems = [];
  const selected = new Set();
  const stages = [];
  const named = new Map();
  let stage = null;
  for (const step of steps) {
    if (step.kind === "from") {
      const base = named.get(step.base) ?? (/^\d+$/.test(step.base) ? stages[Number(step.base)] : undefined);
      stage = { files: new Map(base?.files ?? []), workdir: base?.workdir ?? "/" };
      stages.push(stage);
      if (step.name) named.set(step.name, stage);
    } else if (step.kind === "workdir") {
      stage.workdir = imagePath(stage.workdir, step.path);
    } else if (step.kind === "copy" && step.from === null) {
      copyFromContext(stage, step, files, problems, dockerfile);
    } else if (step.kind === "copy") {
      const source = named.get(step.from) ?? (/^\d+$/.test(step.from) ? stages[Number(step.from)] : undefined);
      if (source) copyFromStage(stage, step, source);
    } else if (step.kind === "command") {
      let changedDirectory = false;
      for (const words of commandsOf(step)) {
        if (stripCommandPrefix(words)[0] === "cd") changedDirectory = true;
        const invocation = parsePnpm(words);
        if (!invocation) continue;
        if (changedDirectory) throw new UnsupportedShape(`line ${step.line}: \`${invocation.text}\` runs after cd`);
        checkPnpm(invocation, stage, step, packages, dockerfile, problems, selected);
      }
    }
  }
  return { problems, selected: [...selected].sort() };
}
