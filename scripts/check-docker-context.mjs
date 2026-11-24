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

export function parseDockerfile(text) {
  const copySources = [];
  const filters = [];
  for (const line of logicalLines(text)) {
    const [instruction, ...rest] = line.split(/\s+/);
    const keyword = instruction.toUpperCase();
    if (keyword === "COPY" || keyword === "ADD") {
      const args = rest.join(" ");
      const tokens = args.trim().startsWith("[") ? JSON.parse(args.trim()) : rest;
      const flags = tokens.filter((token) => token.startsWith("--"));
      if (flags.some((flag) => flag.startsWith("--from"))) continue;
      const paths = tokens.filter((token) => !token.startsWith("--"));
      copySources.push(...paths.slice(0, -1).map(cleanPattern).filter((source) => source !== "."));
    } else if (keyword === "RUN") {
      const tokens = rest.join(" ").split(/\s+/);
      tokens.forEach((token, i) => {
        const [flag, inline] = token.split("=", 2);
        if (flag !== "--filter" && flag !== "-F") return;
        const value = inline ?? tokens[i + 1];
        if (value && !value.startsWith("...")) filters.push(value.replace(/\.\.\.$/, ""));
      });
    }
  }
  return { copySources, filters };
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
  const { copySources, filters } = parseDockerfile(readFileSync(path.join(root, dockerfile), "utf8"));
  const owner = [...packages].find(([, pkg]) => dockerfile.startsWith(`${pkg.dir}/`));
  const names = filters.filter((name) => packages.has(name));
  return {
    copySources,
    packages: workspaceClosure(owner ? [owner[0], ...names] : names, packages),
  };
}

export function contextProblems(root = repoRoot, dockerIgnoreText = readFileSync(path.join(root, ".dockerignore"), "utf8")) {
  const excluded = dockerIgnoreMatcher(dockerIgnoreText);
  const packages = workspacePackages(root);
  const problems = [];
  const dockerfiles = rootContextDockerfiles(root);
  if (!dockerfiles.length) problems.push("no docker-compose file builds a Dockerfile from the repository root context");
  for (const dockerfile of dockerfiles) {
    const inputs = imageInputs(root, dockerfile, packages);
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
