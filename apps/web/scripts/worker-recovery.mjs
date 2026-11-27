import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "wrangler.jsonc";

export const parseWranglerConfig = (text, file = CONFIG) => {
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return config;
};

const tagsOf = (migrations) => (migrations ?? []).map((step) => step.tag);

const startsWith = (list, prefix) => prefix.every((tag, index) => list[index] === tag);

export const liveClasses = (migrations) => {
  const live = new Set();
  for (const step of migrations ?? []) {
    for (const name of [...(step.new_classes ?? []), ...(step.new_sqlite_classes ?? [])]) live.add(name);
    for (const { from, to } of step.renamed_classes ?? []) {
      live.delete(from);
      live.add(to);
    }
    for (const name of step.deleted_classes ?? []) live.delete(name);
  }
  return live;
};

export const exportedNames = (entry) =>
  new Set(
    [...entry.matchAll(/export\s*\{([^}]*)\}/g)].flatMap(([, names]) =>
      names
        .split(",")
        .map((name) => name.trim().split(/\s+as\s+/).pop())
        .filter((name) => name && name !== "default"),
    ),
  );

export const deployProblems = (applied, candidate, entry) => {
  const problems = [];
  const candidateTags = tagsOf(candidate.migrations);
  const extendsApplied = startsWith(candidateTags, tagsOf(applied));
  if (!extendsApplied) {
    problems.push(`its migrations (${candidateTags.join(", ") || "none"}) do not start with the applied ${tagsOf(applied).join(", ")}`);
  }
  const exported = exportedNames(entry);
  for (const name of liveClasses(extendsApplied ? candidate.migrations : applied)) {
    if (!exported.has(name)) problems.push(`${candidate.main} does not export the Durable Object class ${name}`);
  }
  for (const binding of candidate.durable_objects?.bindings ?? []) {
    if (!binding.script_name && !exported.has(binding.class_name)) {
      problems.push(`${candidate.main} does not export ${binding.class_name}, bound as ${binding.name}`);
    }
  }
  return problems;
};

export const recoveryConfig = (older, current) => {
  const olderTags = tagsOf(older.migrations);
  const currentTags = tagsOf(current.migrations);
  if (!startsWith(olderTags, currentTags) && !startsWith(currentTags, olderTags)) {
    throw new Error(`migrations diverge: this tree has ${currentTags.join(", ")}, the older one ${olderTags.join(", ")}`);
  }
  const olderBindings = older.durable_objects?.bindings ?? [];
  const bindings = [
    ...olderBindings,
    ...(current.durable_objects?.bindings ?? []).filter((binding) => !olderBindings.some((kept) => kept.name === binding.name)),
  ];
  return {
    ...older,
    main: older.main === ".open-next/worker.js" ? current.main : older.main,
    durable_objects: { ...older.durable_objects, bindings },
    migrations: olderTags.length >= currentTags.length ? older.migrations : current.migrations,
  };
};

const reexportedModules = (entry) =>
  [...entry.matchAll(/from\s+"(\.[^"]+)"/g)].map(([, specifier]) => specifier).filter((specifier) => !specifier.startsWith("./.open-next/"));

const resolveModule = async (dir, specifier) => {
  for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`]) {
    const file = path.join(dir, candidate);
    try {
      await readFile(file);
      return path.normalize(candidate);
    } catch {}
  }
  throw new Error(`cannot find ${specifier} under ${dir}`);
};

export async function writeRecovery(target, source = WEB) {
  const current = parseWranglerConfig(await readFile(path.join(source, CONFIG), "utf8"));
  const older = parseWranglerConfig(await readFile(path.join(target, CONFIG), "utf8"));
  const next = recoveryConfig(older, current);
  const copied = [];
  let entry = null;
  if (next.main !== older.main) {
    entry = await readFile(path.join(source, current.main), "utf8");
    for (const specifier of reexportedModules(entry)) {
      const file = await resolveModule(source, specifier);
      const text = await readFile(path.join(source, file), "utf8");
      const relative = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map(([, name]) => name);
      if (relative.length > 0) throw new Error(`${file} imports ${relative.join(", ")}: copy those by hand`);
      copied.push(file);
    }
    copied.push(current.main);
  }
  const problems = deployProblems(current.migrations, next, entry ?? (await readFile(path.join(target, next.main), "utf8")));
  if (problems.length > 0) throw new Error(`the recovery build would not deploy: ${problems.join("; ")}`);
  for (const file of copied) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await copyFile(path.join(source, file), path.join(target, file));
  }
  await writeFile(path.join(target, CONFIG), `${JSON.stringify(next, null, 2)}\n`);
  return { config: next, copied };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/worker-recovery.mjs <apps/web of the older checkout>");
    process.exit(2);
  }
  try {
    const { config, copied } = await writeRecovery(path.resolve(target));
    console.log(`recovery overlay written to ${target}: main ${config.main}, migrations ${tagsOf(config.migrations).join(", ")}`);
    for (const file of copied) console.log(`  copied ${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
