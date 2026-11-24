import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootContextBuilds } from "./docker-context/compose.mjs";
import { commandsOf, parseDockerfile, stripCommandPrefix } from "./docker-context/dockerfile.mjs";
import { cleanPattern, contextDirectories, dockerIgnoreMatcher, patternRegExp, walkContext } from "./docker-context/dockerignore.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const ARTIFACT_PATH = /(^|\/)(node_modules|dist)(\/|$)|(^|\/)\.env(\.[^/]*)?$|\.log$/;
const ARTIFACT_PROBES = ["node_modules/probe/index.js", "dist/probe.js", ".env", ".env.local", "probe.log"];
const VERIFY_DEPS_OFF = "--config.verify-deps-before-run=false";
const PNPM_VALUE_FLAGS = new Set(["-C", "--dir", "--filter", "-F", "--filter-prod", "--reporter", "--loglevel", "--workspace-concurrency", "--store-dir", "--virtual-store-dir", "--node-linker"]);
const PNPM_FILTER_FLAGS = new Set(["--filter", "-F", "--filter-prod"]);
const PNPM_INSTALLS = new Set(["install", "i", "add", "fetch", "deploy"]);
const WILDCARD = /[*?[]/;

export function workspacePackages(root = repoRoot) {
  const byName = new Map();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, parent), { withFileTypes: true })) {
      const manifest = path.join(root, parent, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      const workspaceDeps = DEPENDENCY_FIELDS.flatMap((field) =>
        Object.entries(pkg[field] ?? {})
          .filter(([, version]) => String(version).startsWith("workspace:"))
          .map(([name]) => name),
      );
      byName.set(pkg.name, { dir: `${parent}/${entry.name}`, workspaceDeps });
    }
  }
  return byName;
}

export function workspaceClosure(names, packages) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pkg = packages.get(name);
    if (!pkg) throw new Error(`unknown workspace package "${name}"`);
    seen.add(name);
    pkg.workspaceDeps.forEach(visit);
  };
  names.forEach(visit);
  return [...seen].sort();
}

export function pnpmInvocation(words) {
  const argv = stripCommandPrefix(words);
  if (path.posix.basename(argv[0] ?? "") !== "pnpm") return null;
  const filters = [];
  let subcommand;
  for (let i = 1; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=", 2);
    if (!flag.startsWith("-")) subcommand ??= flag;
    else if (inline === undefined && PNPM_VALUE_FLAGS.has(flag)) {
      if (PNPM_FILTER_FLAGS.has(flag)) filters.push(argv[i + 1]);
      i += 1;
    } else if (PNPM_FILTER_FLAGS.has(flag)) filters.push(inline);
  }
  return {
    text: argv.join(" "),
    installs: PNPM_INSTALLS.has(subcommand),
    verifiesDeps: !argv.includes(VERIFY_DEPS_OFF),
    filters: filters.filter((value) => value && !value.startsWith("...")).map((value) => value.replace(/\.\.\.$/, "")),
  };
}

export function imageInputs(root, build, packages = workspacePackages(root)) {
  const { steps } = parseDockerfile(readFileSync(path.join(root, build.dockerfile), "utf8"), build.args);
  const invocations = steps.flatMap((step, index) =>
    commandsOf(step).map(pnpmInvocation).filter(Boolean).map((invocation) => ({ ...invocation, index, instruction: step.instruction })),
  );
  const owner = [...packages].find(([, pkg]) => build.dockerfile.startsWith(`${pkg.dir}/`));
  const names = invocations.flatMap((invocation) => invocation.filters).filter((name) => packages.has(name));
  return { steps, invocations, packages: workspaceClosure(owner ? [owner[0], ...names] : names, packages) };
}

export function stepProblems(dockerfile, inputs, packages, partialWorkspace) {
  const problems = [];
  for (const invocation of inputs.invocations) {
    if (invocation.installs) {
      const copiedBefore = new Set(inputs.steps.slice(0, invocation.index).flatMap((step) => (step.kind === "copy" ? step.sources.map(cleanPattern) : [])));
      if (copiedBefore.has(".")) continue;
      for (const name of workspaceClosure(invocation.filters.filter((value) => packages.has(value)), packages)) {
        const manifest = `${packages.get(name).dir}/package.json`;
        if (!copiedBefore.has(manifest)) problems.push(`${dockerfile}: \`${invocation.text}\` runs before ${manifest} is copied`);
      }
    } else if (partialWorkspace && invocation.verifiesDeps) {
      problems.push(`${dockerfile}: ${invocation.instruction} \`${invocation.text}\` reinstalls the partial image workspace first; pass ${VERIFY_DEPS_OFF}`);
    }
  }
  return problems;
}

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function sourceFiles(source, tracked) {
  if (WILDCARD.test(source)) {
    const regExp = patternRegExp(source);
    return tracked.filter((file) => file.split("/").some((_, i, segments) => regExp.test(segments.slice(0, i + 1).join("/"))));
  }
  return tracked.filter((file) => file === source || file.startsWith(`${source}/`));
}

export function artifactProblems(root, ignoreFile, matcher) {
  const files = walkContext(root, matcher);
  const onDisk = files.filter((file) => ARTIFACT_PATH.test(file)).map((file) => `${ignoreFile}: ${file} is on disk and would enter the build context`);
  const probes = contextDirectories(files)
    .flatMap((dir) => ARTIFACT_PROBES.map((probe) => (dir ? `${dir}/${probe}` : probe)))
    .filter((probe) => !matcher.excluded(probe))
    .map((probe) => `${ignoreFile}: ${probe} would enter the build context`);
  return [...onDisk, ...probes];
}

export function contextProblems(root = repoRoot, { dockerIgnore } = {}) {
  const packages = workspacePackages(root);
  const tracked = trackedFiles(root);
  const builds = rootContextBuilds(root);
  const problems = [];
  if (!builds.length) problems.push("no compose file builds an image from the repository root context");
  const partialWorkspace = (matcher) => [...packages.values()].some(({ dir }) => matcher.excluded(`${dir}/package.json`));
  const contexts = new Map();
  for (const build of builds) {
    const dedicated = `${build.dockerfile}.dockerignore`;
    const ignoreFile = existsSync(path.join(root, dedicated)) ? dedicated : ".dockerignore";
    const text = dockerIgnore ?? (existsSync(path.join(root, ignoreFile)) ? readFileSync(path.join(root, ignoreFile), "utf8") : "");
    if (!contexts.has(ignoreFile)) {
      const matcher = dockerIgnoreMatcher(text);
      contexts.set(ignoreFile, matcher);
      problems.push(...artifactProblems(root, ignoreFile, matcher));
    }
    const matcher = contexts.get(ignoreFile);
    const inputs = imageInputs(root, build, packages);
    for (const source of inputs.steps.flatMap((step) => (step.kind === "copy" ? step.sources.map(cleanPattern) : []))) {
      if (source === ".") continue;
      if (source === ".." || source.startsWith("../")) {
        problems.push(`${build.dockerfile}: source ${source} is outside the build context`);
        continue;
      }
      const files = sourceFiles(source, tracked);
      if (!files.length) problems.push(`${build.dockerfile}: source ${source} matches no tracked file`);
      for (const file of files.filter(matcher.excluded)) problems.push(`${build.dockerfile}: source ${source} needs ${file}, which ${ignoreFile} excludes`);
    }
    for (const name of inputs.packages) {
      const { dir } = packages.get(name);
      for (const file of sourceFiles(dir, tracked).filter((file) => !TEST_PATH.test(file) && matcher.excluded(file))) {
        problems.push(`${build.dockerfile}: ${name} needs ${file}, which ${ignoreFile} excludes`);
      }
    }
    problems.push(...stepProblems(build.dockerfile, inputs, packages, partialWorkspace(matcher)));
  }
  return [...new Set(problems)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = contextProblems();
  for (const problem of problems.slice(0, 50)) console.error(problem);
  if (problems.length > 50) console.error(`...and ${problems.length - 50} more`);
  if (problems.length) {
    console.error(`docker build context: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`docker build context covers ${[...new Set(rootContextBuilds(repoRoot).map((build) => build.dockerfile))].join(", ")}`);
}
