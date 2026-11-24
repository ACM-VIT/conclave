import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUILD_ARTIFACTS = ["node_modules/.bin/tsc", "dist/index.js", ".env", ".env.local", "server.log"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function cleanPattern(pattern) {
  const cleaned = path.posix.normalize(pattern).replace(/\/+$/, "");
  return cleaned.length > 1 && cleaned.startsWith("/") ? cleaned.slice(1) : cleaned;
}

function patternRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
        source += "(.*/)?";
      } else {
        source += ".*";
      }
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) throw new Error(`unterminated character class in pattern "${pattern}"`);
      source += pattern.slice(i, end + 1);
      i = end;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      i += 1;
      source += `\\${pattern[i]}`;
    } else {
      source += ch.replace(/[.+()|{}$^\]]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function parseDockerIgnore(text) {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const exclusion = line.startsWith("!");
      const pattern = cleanPattern(exclusion ? line.slice(1).trim() : line);
      return { exclusion, pattern, regExp: patternRegExp(pattern) };
    });
}

export function dockerIgnoreMatcher(text) {
  const patterns = parseDockerIgnore(text);
  return (file) => {
    const parents = path.posix.dirname(file) === "." ? [] : path.posix.dirname(file).split("/");
    let excluded = false;
    for (const { exclusion, regExp } of patterns) {
      if (exclusion !== excluded) continue;
      const matches = regExp.test(file) || parents.some((_, i) => regExp.test(parents.slice(0, i + 1).join("/")));
      if (matches) excluded = !exclusion;
    }
    return excluded;
  };
}

function logicalLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const VERIFY_DEPS_OFF = "--config.verify-deps-before-run=false";
const PNPM_VALUE_FLAGS = new Set(["-C", "--dir", "--filter", "-F"]);
const PNPM_INSTALLS = new Set(["install", "i", "add", "fetch"]);

function instructionArgs(rest) {
  const args = rest.join(" ").trim();
  if (args.startsWith("[")) return JSON.parse(args);
  return rest;
}

export function parseDockerfile(text) {
  const steps = [];
  for (const line of logicalLines(text)) {
    const [instruction, ...rest] = line.split(/\s+/);
    const keyword = instruction.toUpperCase();
    if (keyword === "COPY" || keyword === "ADD") {
      const tokens = instructionArgs(rest);
      if (tokens.some((token) => token.startsWith("--from"))) continue;
      const paths = tokens.filter((token) => !token.startsWith("--"));
      steps.push({ kind: "copy", sources: paths.slice(0, -1).map(cleanPattern) });
    } else if (keyword === "RUN" || keyword === "CMD" || keyword === "ENTRYPOINT") {
      steps.push({ kind: "command", instruction: keyword, command: instructionArgs(rest).join(" ") });
    }
  }
  const copySources = steps.flatMap((step) => (step.kind === "copy" ? step.sources : [])).filter((source) => source !== ".");
  const pnpmCommands = steps.flatMap((step, index) =>
    step.kind === "command" ? pnpmInvocations(step.command).map((invocation) => ({ ...invocation, index, instruction: step.instruction })) : [],
  );
  const filters = pnpmCommands.flatMap((invocation) => invocation.filters);
  return { steps, copySources, filters, pnpmCommands };
}

export function pnpmInvocations(command) {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens[0] === "pnpm")
    .map((tokens) => {
      const filters = [];
      let subcommand;
      for (let i = 1; i < tokens.length; i += 1) {
        const [flag, inline] = tokens[i].split("=", 2);
        if (!flag.startsWith("-")) subcommand ??= flag;
        else if (PNPM_VALUE_FLAGS.has(flag) && inline === undefined) {
          if (flag === "--filter" || flag === "-F") filters.push(tokens[i + 1]);
          i += 1;
        } else if ((flag === "--filter" || flag === "-F") && inline) filters.push(inline);
      }
      return {
        text: tokens.join(" "),
        installs: PNPM_INSTALLS.has(subcommand),
        verifiesDeps: !tokens.includes(VERIFY_DEPS_OFF),
        filters: filters.filter((value) => value && !value.startsWith("...")).map((value) => value.replace(/\.\.\.$/, "")),
      };
    });
}

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

export function rootContextDockerfiles(root = repoRoot) {
  const dockerfiles = new Set();
  for (const file of readdirSync(root).filter((name) => /^docker-compose.*\.ya?ml$/.test(name)).sort()) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(/^(\s*)context:\s*["']?([^"'\s]+)["']?\s*\n\1dockerfile:\s*["']?([^"'\s]+)["']?/gm)) {
      if (cleanPattern(match[2]) === ".") dockerfiles.add(cleanPattern(match[3]));
    }
  }
  return [...dockerfiles].sort();
}

function trackedFiles(root, pathspec) {
  return execFileSync("git", ["ls-files", "-z", "--", pathspec], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

export function imageInputs(root, dockerfile, packages = workspacePackages(root)) {
  const parsed = parseDockerfile(readFileSync(path.join(root, dockerfile), "utf8"));
  const owner = [...packages].find(([, pkg]) => dockerfile.startsWith(`${pkg.dir}/`));
  const names = parsed.filters.filter((name) => packages.has(name));
  return {
    ...parsed,
    packages: workspaceClosure(owner ? [owner[0], ...names] : names, packages),
  };
}

export function stepProblems(dockerfile, inputs, packages, partialWorkspace) {
  const problems = [];
  for (const invocation of inputs.pnpmCommands) {
    if (invocation.installs) {
      const copiedBefore = new Set(inputs.steps.slice(0, invocation.index).flatMap((step) => (step.kind === "copy" ? step.sources : [])));
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

export function contextProblems(root = repoRoot, dockerIgnoreText = readFileSync(path.join(root, ".dockerignore"), "utf8")) {
  const excluded = dockerIgnoreMatcher(dockerIgnoreText);
  const packages = workspacePackages(root);
  const problems = [];
  const dockerfiles = rootContextDockerfiles(root);
  const partialWorkspace = [...packages.values()].some(({ dir }) => excluded(`${dir}/package.json`));
  if (!dockerfiles.length) problems.push("no docker-compose file builds a Dockerfile from the repository root context");
  for (const dockerfile of dockerfiles) {
    const inputs = imageInputs(root, dockerfile, packages);
    problems.push(...stepProblems(dockerfile, inputs, packages, partialWorkspace));
    for (const source of inputs.copySources) {
      const files = trackedFiles(root, source);
      if (!files.length) problems.push(`${dockerfile}: COPY source ${source} matches no tracked file`);
      for (const file of files.filter(excluded)) problems.push(`${dockerfile}: COPY source ${source} needs ${file}, which .dockerignore excludes`);
    }
    for (const name of inputs.packages) {
      const { dir } = packages.get(name);
      for (const file of trackedFiles(root, dir).filter((file) => !TEST_PATH.test(file) && excluded(file))) problems.push(`${dockerfile}: ${name} needs ${file}, which .dockerignore excludes`);
      for (const artifact of BUILD_ARTIFACTS.map((item) => `${dir}/${item}`).filter((file) => !excluded(file))) {
        problems.push(`${dockerfile}: ${name} build artifact ${artifact} would enter the build context`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = contextProblems();
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`docker build context: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`docker build context covers ${rootContextDockerfiles().join(", ")}`);
}
