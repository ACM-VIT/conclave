import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import { UnsupportedShape } from "./unsupported.mjs";

const COMPOSE_FILE = /^(docker-)?compose(\..+)?\.ya?ml$/;
const BUILD_KEYS = new Set(["context", "dockerfile", "args", "target", "labels", "tags", "platforms", "pull", "no_cache", "cache_from", "cache_to", "network", "shm_size"]);

const unsupported = (detail) => new UnsupportedShape(detail, "the compose file");

function literal(value, where) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw unsupported(`${where} is not a plain value`);
  const text = String(value);
  if (text.includes("$")) throw unsupported(`${where} uses interpolation (${text})`);
  return text;
}

function buildArgs(args, where) {
  if (args === undefined) return {};
  if (Array.isArray(args)) {
    return Object.fromEntries(args.map((entry) => {
      const text = literal(entry, `${where}.args`);
      const eq = text.indexOf("=");
      if (eq === -1) throw unsupported(`${where}.args ${text} takes its value from the environment`);
      return [text.slice(0, eq), text.slice(eq + 1)];
    }));
  }
  if (args === null || typeof args !== "object") throw unsupported(`${where}.args is not a list or a map`);
  return Object.fromEntries(Object.entries(args).map(([name, value]) => {
    if (value === null || value === undefined) throw unsupported(`${where}.args.${name} takes its value from the environment`);
    return [name, literal(value, `${where}.args.${name}`)];
  }));
}

export function composeBuilds(root) {
  const builds = [];
  for (const file of readdirSync(root).filter((name) => COMPOSE_FILE.test(name)).sort()) {
    const document = parse(readFileSync(path.join(root, file), "utf8")) ?? {};
    if (document.include !== undefined) throw unsupported(`${file} uses include`);
    for (const [service, definition] of Object.entries(document.services ?? {})) {
      if (definition?.extends !== undefined) throw unsupported(`${file} services.${service} uses extends`);
      const build = definition?.build;
      if (build === undefined || build === null) continue;
      const where = `${file} services.${service}.build`;
      const spec = typeof build === "string" ? { context: build } : build;
      const unknownKey = Object.keys(spec).find((key) => !BUILD_KEYS.has(key));
      if (unknownKey) throw unsupported(`${where}.${unknownKey}`);
      const contextValue = literal(spec.context ?? ".", `${where}.context`);
      if (path.posix.isAbsolute(contextValue) || contextValue.includes("://")) throw unsupported(`${where}.context ${contextValue} is not a path inside the repository`);
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
