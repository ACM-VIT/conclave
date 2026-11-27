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

function loadCompose(root, file, cache) {
  if (!cache.has(file)) {
    const document = parse(readFileSync(path.join(root, file), "utf8"), { merge: true }) ?? {};
    if (document.include !== undefined) throw unsupported(`${file} uses include`);
    cache.set(file, document);
  }
  return cache.get(file);
}

function extendedBuild(root, file, service, cache, seen) {
  const where = `${file} services.${service}`;
  if (seen.includes(where)) throw unsupported(`${where} extends itself`);
  const definition = loadCompose(root, file, cache).services?.[service];
  if (definition === undefined || definition === null) throw unsupported(`${where} does not exist`);
  if (definition.extends === undefined) return definition.build;
  const spec = typeof definition.extends === "string" ? { service: definition.extends } : definition.extends;
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) throw unsupported(`${where}.extends is not a service name or a map`);
  const unknownKey = Object.keys(spec).find((key) => key !== "file" && key !== "service");
  if (unknownKey) throw unsupported(`${where}.extends.${unknownKey}`);
  const baseFile = spec.file === undefined ? file : path.posix.normalize(literal(spec.file, `${where}.extends.file`));
  if (baseFile.includes("/") || !COMPOSE_FILE.test(baseFile)) throw unsupported(`${where}.extends.file ${baseFile} is not a compose file beside it`);
  const inherited = extendedBuild(root, baseFile, literal(spec.service, `${where}.extends.service`), cache, [...seen, where]);
  if (definition.build !== undefined && inherited !== undefined) throw unsupported(`${where} overrides the build it extends`);
  return definition.build ?? inherited;
}

export function composeBuilds(root) {
  const builds = [];
  const cache = new Map();
  for (const file of readdirSync(root).filter((name) => COMPOSE_FILE.test(name)).sort()) {
    const document = loadCompose(root, file, cache);
    for (const [service, definition] of Object.entries(document.services ?? {})) {
      const build = definition?.extends === undefined ? definition?.build : extendedBuild(root, file, service, cache, []);
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
