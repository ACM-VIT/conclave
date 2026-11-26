import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootContextBuilds } from "./docker-context/compose.mjs";
import { DockerfileError, contextCopies } from "./docker-context/dockerfile.mjs";
import { cleanPattern, contextDirectories, dockerIgnoreMatcher, walkContext } from "./docker-context/dockerignore.mjs";
import { UnsupportedShape } from "./docker-context/unsupported.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const ARTIFACT_PATH = /(^|\/)(node_modules|dist|data)(\/|$)|(^|\/)\.env(\.[^/]*)?$|\.(log|sqlite|sqlite3|db)$|-(wal|shm|journal)$/;
const ARTIFACT_PROBES = [
  "node_modules/probe/index.js",
  "dist/probe.js",
  ".env",
  ".env.local",
  "probe.log",
  "data/scheduling.json",
  "test/probe.ts",
  "probe.sqlite",
  "probe.sqlite3",
  "probe.db",
  "probe.sqlite-wal",
  "probe.sqlite-shm",
  "probe.db-journal",
];
const ROOT_PROBES = [".git/config"];

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

function trackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function sourceFiles(source, tracked) {
  return tracked.filter((file) => file === source || file.startsWith(`${source}/`));
}

export function artifactProblems(ignoreFile, matcher, files) {
  const onDisk = files.filter((file) => ARTIFACT_PATH.test(file)).map((file) => `${ignoreFile}: ${file} is on disk and would enter the build context`);
  const probes = contextDirectories(files)
    .flatMap((dir) => ARTIFACT_PROBES.map((probe) => (dir ? `${dir}/${probe}` : probe)))
    .concat(ROOT_PROBES)
    .filter((probe) => !matcher.excluded(probe))
    .map((probe) => `${ignoreFile}: ${probe} would enter the build context`);
  return [...onDisk, ...probes];
}

export function unneededProblems(ignoreFile, contextFiles, tracked, needs) {
  return tracked
    .filter((file) => contextFiles.has(file) && !needs.some((need) => file === need || file.startsWith(`${need}/`)))
    .map((file) => `${ignoreFile}: ${file} is tracked and in the build context, but no root-context image needs it`);
}

export function imagePackages(dockerfile, sources, packages) {
  const owners = [...packages]
    .filter(([, { dir }]) => dockerfile.startsWith(`${dir}/`) || sources.some((source) => source === dir || source.startsWith(`${dir}/`)))
    .map(([name]) => name);
  return workspaceClosure(owners, packages);
}

function contextGap(file, { contextFiles, matcher, ignoreFile }) {
  if (contextFiles.has(file)) return null;
  return matcher.excluded(file) ? `which ${ignoreFile} excludes` : "which is tracked but missing from the build context";
}

export function imageProblems(root, build, { packages, tracked, contextFiles, matcher, ignoreFile, needs = [] }) {
  const problems = [];
  const sources = [];
  const text = readFileSync(path.join(root, build.dockerfile), "utf8");
  const context = { contextFiles, matcher, ignoreFile };
  for (const copy of contextCopies(text)) {
    for (const raw of copy.sources) {
      const source = cleanPattern(raw);
      if (source === ".." || source.startsWith("../")) {
        problems.push(`${build.dockerfile}: line ${copy.line}: COPY source ${raw} is outside the build context`);
        continue;
      }
      if (source === ".") continue;
      sources.push(source);
      if (!contextFiles.has(source) && ![...contextFiles].some((file) => file.startsWith(`${source}/`))) {
        problems.push(`${build.dockerfile}: line ${copy.line}: COPY source ${raw} is not in the build context`);
      }
      for (const file of sourceFiles(source, tracked).filter((item) => item === source || !TEST_PATH.test(item))) {
        const gap = contextGap(file, context);
        if (gap) problems.push(`${build.dockerfile}: source ${source} needs ${file}, ${gap}`);
      }
    }
  }
  needs.push(...sources);
  for (const name of imagePackages(build.dockerfile, sources, packages)) {
    const { dir } = packages.get(name);
    needs.push(dir);
    for (const file of sourceFiles(dir, tracked).filter((item) => !TEST_PATH.test(item))) {
      const gap = contextGap(file, context);
      if (gap) problems.push(`${build.dockerfile}: ${name} needs ${file}, ${gap}`);
    }
  }
  return problems;
}

function failClosed(where, run) {
  try {
    return run();
  } catch (error) {
    if (error instanceof UnsupportedShape || error instanceof DockerfileError) return [`${where}: ${error.message}`];
    throw error;
  }
}

export function contextProblems(root = repoRoot, { dockerIgnore } = {}) {
  const packages = workspacePackages(root);
  const tracked = trackedFiles(root);
  let builds = [];
  const problems = failClosed("compose", () => {
    builds = rootContextBuilds(root);
    return builds.length ? [] : ["no compose file builds an image from the repository root context"];
  });
  const contexts = new Map();
  for (const build of builds) {
    const dedicated = `${build.dockerfile}.dockerignore`;
    const ignoreFile = existsSync(path.join(root, dedicated)) ? dedicated : ".dockerignore";
    if (!contexts.has(ignoreFile)) {
      const text = dockerIgnore ?? (existsSync(path.join(root, ignoreFile)) ? readFileSync(path.join(root, ignoreFile), "utf8") : "");
      const matcher = dockerIgnoreMatcher(text);
      const files = walkContext(root, matcher);
      contexts.set(ignoreFile, { matcher, contextFiles: new Set(files), needs: [], complete: true });
      problems.push(...artifactProblems(ignoreFile, matcher, files));
    }
    const group = contexts.get(ignoreFile);
    const { matcher, contextFiles, needs } = group;
    let read = false;
    problems.push(...failClosed(build.dockerfile, () => {
      const result = imageProblems(root, build, { packages, tracked, contextFiles, matcher, ignoreFile, needs });
      read = true;
      return result;
    }));
    if (!read) group.complete = false;
  }
  for (const [ignoreFile, { contextFiles, needs, complete }] of contexts) {
    if (complete) problems.push(...unneededProblems(ignoreFile, contextFiles, tracked, needs));
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
