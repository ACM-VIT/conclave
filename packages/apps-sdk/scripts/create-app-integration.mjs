#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJsonPath = path.join(packageDir, "package.json");
const appsSourceDir = path.join(packageDir, "src", "apps");
const valueFlags = new Set(["name", "description", "id"]);

const printUsage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run new:app <slug> [options]

Examples:
  pnpm -C packages/apps-sdk run new:app polls
  pnpm -C packages/apps-sdk run new:app music-queue --name "Music Queue"

Options:
  --id <id>              Explicit app id (defaults to normalized slug)
  --name <name>          Display name (defaults from id)
  --description <text>   App description
  --dry-run              Print actions without writing files
  --help                 Show this help
`);
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = new Set();
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }

    const raw = argument.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      values[key] = rest.join("=");
      continue;
    }

    const next = argv[index + 1];
    if (valueFlags.has(raw) && next && !next.startsWith("--")) {
      values[raw] = next;
      index += 1;
      continue;
    }

    flags.add(raw);
  }

  return { positional, flags, values };
};

const toAppId = (input) =>
  input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const toWords = (id) => id.split("-").filter(Boolean);
const toTitleCase = (id) =>
  toWords(id)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
const toPascalCase = (id) => toTitleCase(id).replaceAll(" ", "");
const toCamelCase = (id) => {
  const pascal = toPascalCase(id);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value, dryRun) => {
  if (dryRun) {
    console.log(`[dry-run] update ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const writeFile = (filePath, content, dryRun) => {
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing file: ${filePath}`);
  }
  if (dryRun) {
    console.log(`[dry-run] create ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
};

const sortObjectKeys = (record) => {
  const keys = Object.keys(record).sort((left, right) => {
    if (left === ".") return -1;
    if (right === ".") return 1;
    return left.localeCompare(right);
  });
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
};

const scaffoldApp = ({ appId, appName, appDescription, dryRun }) => {
  const pascal = toPascalCase(appId);
  const camel = toCamelCase(appId);
  const appDir = path.join(appsSourceDir, appId);
  if (fs.existsSync(appDir)) {
    throw new Error(`App directory already exists: ${appDir}`);
  }

  const files = [
    {
      path: path.join(appDir, "core", "doc", "index.ts"),
      content: `import * as Y from "yjs";
import {
  createAppDoc,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";

const ROOT_KEY = "${appId}";

// Joining docs stay empty until server sync. Read helpers should return local
// UI defaults; mutation helpers should lazily create shared Yjs types.
export const create${pascal}Doc = (): Y.Doc => createAppDoc(ROOT_KEY);

export const get${pascal}Root = (doc: Y.Doc): Y.Map<unknown> =>
  getAppRoot(doc, ROOT_KEY);
`,
    },
    {
      path: path.join(appDir, "core", "index.ts"),
      content: `export * from "./doc/index";\n`,
    },
    {
      path: path.join(appDir, "web", "components", `${pascal}WebApp.tsx`),
      content: `import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";

export function ${pascal}WebApp() {
  const { isActive, locked } = useAppDoc("${appId}");

  return (
    <div className="flex h-full w-full items-center justify-center rounded-xl border border-white/10 bg-black/20 px-6 py-8 text-center">
      <div>
        <p className="text-base font-semibold text-white">${appName}</p>
        <p className="mt-1 text-sm text-white/60">
          {locked ? "Locked: read-only mode" : "Ready to build"}
        </p>
        <p className="mt-2 text-[11px] uppercase tracking-wider text-white/40">
          {isActive ? "App active" : "App inactive"}
        </p>
      </div>
    </div>
  );
}
`,
    },
    {
      path: path.join(appDir, "web", "index.ts"),
      content: `import { defineApp } from "../../../sdk/registry/index";
import { create${pascal}Doc } from "../core/doc/index";
import { ${pascal}WebApp } from "./components/${pascal}WebApp";

export const ${camel}App = defineApp({
  id: "${appId}",
  name: "${appName}",
  description: "${appDescription}",
  createDoc: create${pascal}Doc,
  web: ${pascal}WebApp,
});

export { ${pascal}WebApp };
`,
    },
  ];

  for (const file of files) {
    writeFile(file.path, file.content, dryRun);
  }
  return files.map((file) => file.path);
};

const updatePackageExports = (appId, dryRun) => {
  const pkg = readJson(packageJsonPath);
  const exports = {
    ...(pkg.exports ?? {}),
    [`./${appId}/core`]: `./src/apps/${appId}/core/index.ts`,
    [`./${appId}/web`]: `./src/apps/${appId}/web/index.ts`,
  };
  pkg.exports = sortObjectKeys(exports);
  writeJson(packageJsonPath, pkg, dryRun);
};

const main = () => {
  const { positional, flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    printUsage();
    return;
  }

  const slug = positional[0];
  if (!slug) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const appId = toAppId(values.id ?? slug);
  if (!appId) throw new Error("Could not derive a valid app id.");

  const appName = (values.name ?? toTitleCase(appId)).trim();
  const appDescription = (values.description ?? `${appName} app`).trim();
  const dryRun = flags.has("dry-run");
  const createdFiles = scaffoldApp({
    appId,
    appName,
    appDescription,
    dryRun,
  });
  updatePackageExports(appId, dryRun);

  console.log(`Scaffold complete for "${appId}" (${appName}).`);
  console.log(`Created ${createdFiles.length} file(s) and updated package exports.`);
  console.log("Next: register the app in the web meeting host, wire controls, then run check:apps.");
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
