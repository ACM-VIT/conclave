import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const COMPOSE_FILE = /^(docker-)?compose(\..+)?\.ya?ml$/;

export class ComposeError extends Error {}

function literal(value, where) {
  if (typeof value !== "string") throw new ComposeError(`${where} must be a string`);
  if (value.includes("$")) throw new ComposeError(`${where} uses interpolation (${value}), which the check cannot resolve`);
  return value;
}

function buildArgs(args, where) {
  if (args === undefined || args === null) return {};
  if (Array.isArray(args)) {
    return Object.fromEntries(args.map((entry) => {
      const text = literal(entry, `${where}.args`);
      const eq = text.indexOf("=");
      return eq === -1 ? [text, undefined] : [text.slice(0, eq), text.slice(eq + 1)];
    }).filter(([, value]) => value !== undefined));
  }
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [name, value === null ? undefined : literal(String(value), `${where}.args.${name}`)]).filter(([, value]) => value !== undefined));
}

export function composeBuilds(root) {
  const builds = [];
  for (const file of readdirSync(root).filter((name) => COMPOSE_FILE.test(name)).sort()) {
    const document = parse(readFileSync(path.join(root, file), "utf8")) ?? {};
    for (const [service, definition] of Object.entries(document.services ?? {})) {
      const build = definition?.build;
      if (build === undefined || build === null) continue;
      const where = `${file} services.${service}.build`;
      const spec = typeof build === "string" ? { context: build } : build;
      if (spec.dockerfile_inline !== undefined) throw new ComposeError(`${where} uses dockerfile_inline, which the check cannot read`);
      const contextValue = literal(spec.context ?? ".", `${where}.context`);
      if (path.posix.isAbsolute(contextValue) || contextValue.includes("://")) throw new ComposeError(`${where}.context ${contextValue} is not a path inside the repository`);
      const context = path.posix.normalize(path.posix.join(".", contextValue)).replace(/(.)\/+$/, "$1");
      const dockerfile = path.posix.normalize(path.posix.join(context, literal(spec.dockerfile ?? "Dockerfile", `${where}.dockerfile`)));
      builds.push({ file, service, context, dockerfile, args: buildArgs(spec.args, where) });
    }
  }
  return builds;
}

export function rootContextBuilds(root) {
  const unique = new Map();
  for (const build of composeBuilds(root).filter((entry) => entry.context === ".")) {
    const key = `${build.dockerfile}\0${JSON.stringify(Object.entries(build.args).sort())}`;
    if (!unique.has(key)) unique.set(key, build);
  }
  return [...unique.values()].sort((a, b) => a.dockerfile.localeCompare(b.dockerfile) || a.service.localeCompare(b.service));
}
