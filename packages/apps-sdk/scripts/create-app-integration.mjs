#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");

const PACKAGE_JSON_PATH = path.join(packageDir, "package.json");
const MOBILE_TSCONFIG_PATH = path.join(repoRoot, "apps", "mobile", "tsconfig.json");
const APPS_SRC_DIR = path.join(packageDir, "src", "apps");

const valueFlags = new Set(["name", "description", "id"]);

const printUsage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run new:app <slug> [options]

Examples:
  pnpm -C packages/apps-sdk run new:app polls
  pnpm -C packages/apps-sdk run new:app music-queue --name "Music Queue"
  pnpm -C packages/apps-sdk run new:app timer --no-native

Options:
  --id <id>              Explicit app id (defaults to normalized slug)
  --name <name>          Display name (defaults from id)
  --description <text>   App description
  --no-web               Skip web scaffold files/exports
  --no-native            Skip native scaffold files/exports
  --dry-run              Print actions without writing files
  --help                 Show this help
`);
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = new Set();
  const values = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    if (raw.includes("=")) {
      const [key, ...rest] = raw.split("=");
      values[key] = rest.join("=");
      continue;
    }

    const next = argv[i + 1];
    if (valueFlags.has(raw) && next && !next.startsWith("--")) {
      values[raw] = next;
      i += 1;
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

const toPascalCase = (id) =>
  toWords(id)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

const toCamelCase = (id) => {
  const pascal = toPascalCase(id);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value, dryRun) => {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] update ${filePath}`);
    return;
  }
  fs.writeFileSync(filePath, content, "utf8");
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
  const keys = Object.keys(record).sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });
  const next = {};
  for (const key of keys) {
    next[key] = record[key];
  }
  return next;
};

const scaffoldFiles = ({
  appId,
  appName,
  appDescription,
  includeWeb,
  includeNative,
  dryRun,
}) => {
  const pascal = toPascalCase(appId);
  const camel = toCamelCase(appId);
  const appDir = path.join(APPS_SRC_DIR, appId);
  if (fs.existsSync(appDir)) {
    throw new Error(`App directory already exists: ${appDir}`);
  }

  const files = [];

  files.push({
    path: path.join(appDir, "core", "doc", "index.ts"),
    content: `import * as Y from "yjs";
import {
  createAppDoc,
  ensureAppMap,
  getAppRoot,
} from "../../../../sdk/doc/createAppDoc";

const ROOT_KEY = "${appId}";

export const create${pascal}Doc = (): Y.Doc => {
  return createAppDoc(ROOT_KEY, (root) => {
    ensureAppMap(root, "meta");
  });
};

export const get${pascal}Root = (doc: Y.Doc): Y.Map<unknown> => {
  return getAppRoot(doc, ROOT_KEY);
};
`,
  });

  files.push({
    path: path.join(appDir, "core", "index.ts"),
    content: `export * from "./doc/index";
`,
  });

  if (includeWeb) {
    files.push({
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
    });

    files.push({
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
    });
  }

  if (includeNative) {
    files.push({
      path: path.join(appDir, "native", "components", `${pascal}NativeApp.tsx`),
      content: `import { Text, View } from "react-native";
import { useAppDoc } from "../../../../sdk/hooks/useAppDoc";

export function ${pascal}NativeApp() {
  const { isActive, locked } = useAppDoc("${appId}");

  return (
    <View style={styles.container}>
      <Text style={styles.title}>${appName}</Text>
      <Text style={styles.subtitle}>
        {locked ? "Locked: read-only mode" : "Ready to build"}
      </Text>
      <Text style={styles.status}>{isActive ? "App active" : "App inactive"}</Text>
    </View>
  );
}

const styles = {
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "#0d0e0d",
  },
  title: {
    color: "#FEFCD9",
    fontSize: 18,
    fontWeight: "700",
  },
  subtitle: {
    marginTop: 8,
    color: "rgba(254, 252, 217, 0.7)",
    fontSize: 13,
  },
  status: {
    marginTop: 10,
    color: "rgba(254, 252, 217, 0.5)",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
} as const;
`,
    });

    files.push({
      path: path.join(appDir, "native", "index.ts"),
      content: `import { defineApp } from "../../../sdk/registry/index";
import { create${pascal}Doc } from "../core/doc/index";
import { ${pascal}NativeApp } from "./components/${pascal}NativeApp";

export const ${camel}App = defineApp({
  id: "${appId}",
  name: "${appName}",
  description: "${appDescription}",
  createDoc: create${pascal}Doc,
  native: ${pascal}NativeApp,
});

export { ${pascal}NativeApp };
`,
    });
  }

  for (const file of files) {
    writeFile(file.path, file.content, dryRun);
  }

  return files.map((file) => file.path);
};

const updatePackageExports = ({ appId, includeWeb, includeNative, dryRun }) => {
  const pkg = readJson(PACKAGE_JSON_PATH);
  const nextExports = { ...(pkg.exports ?? {}) };
  const updates = [];

  const upsert = (key, value) => {
    if (nextExports[key] === value) return;
    nextExports[key] = value;
    updates.push(key);
  };

  upsert(`./${appId}/core`, `./src/apps/${appId}/core/index.ts`);
  if (includeWeb) {
    upsert(`./${appId}/web`, `./src/apps/${appId}/web/index.ts`);
  }
  if (includeNative) {
    upsert(`./${appId}/native`, `./src/apps/${appId}/native/index.ts`);
  }

  if (updates.length === 0) return updates;
  pkg.exports = sortObjectKeys(nextExports);
  writeJson(PACKAGE_JSON_PATH, pkg, dryRun);
  return updates;
};

const updateMobileTsconfigPaths = ({
  appId,
  includeWeb,
  includeNative,
  dryRun,
}) => {
  const tsconfig = readJson(MOBILE_TSCONFIG_PATH);
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const paths = compilerOptions.paths ?? {};
  const updates = [];

  const upsert = (key, value) => {
    const current = paths[key];
    if (Array.isArray(current) && current.length === value.length) {
      const unchanged = current.every((entry, idx) => entry === value[idx]);
      if (unchanged) return;
    }
    paths[key] = value;
    updates.push(key);
  };

  upsert(`@conclave/apps-sdk/${appId}/core`, [
    `../../packages/apps-sdk/src/apps/${appId}/core/index.ts`,
  ]);
  if (includeWeb) {
    upsert(`@conclave/apps-sdk/${appId}/web`, [
      `../../packages/apps-sdk/src/apps/${appId}/web/index.ts`,
    ]);
  }
  if (includeNative) {
    upsert(`@conclave/apps-sdk/${appId}/native`, [
      `../../packages/apps-sdk/src/apps/${appId}/native/index.ts`,
    ]);
  }

  if (updates.length === 0) return updates;
  compilerOptions.paths = sortObjectKeys(paths);
  tsconfig.compilerOptions = compilerOptions;
  writeJson(MOBILE_TSCONFIG_PATH, tsconfig, dryRun);
  return updates;
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
  if (!appId) {
    throw new Error("Could not derive a valid app id.");
  }
  if (appId === "whiteboard") {
    throw new Error("App id whiteboard already exists.");
  }

  const includeWeb = !flags.has("no-web");
  const includeNative = !flags.has("no-native");
  if (!includeWeb && !includeNative) {
    throw new Error("At least one renderer is required. Remove --no-web or --no-native.");
  }

  const appName = (values.name ?? toTitleCase(appId)).trim();
  const appDescription = (values.description ?? `${appName} app`).trim();
  const dryRun = flags.has("dry-run");

  const createdFiles = scaffoldFiles({
    appId,
    appName,
    appDescription,
    includeWeb,
    includeNative,
    dryRun,
  });
  const exportUpdates = updatePackageExports({
    appId,
    includeWeb,
    includeNative,
    dryRun,
  });
  const mobilePathUpdates = updateMobileTsconfigPaths({
    appId,
    includeWeb,
    includeNative,
    dryRun,
  });

  console.log("");
  console.log(`Scaffold complete for "${appId}" (${appName}).`);
  console.log(`Created ${createdFiles.length} file(s).`);
  if (exportUpdates.length > 0) {
    console.log(`Updated package exports: ${exportUpdates.join(", ")}`);
  }
  if (mobilePathUpdates.length > 0) {
    console.log(`Updated mobile tsconfig paths: ${mobilePathUpdates.join(", ")}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("1. Register the app in web and mobile meeting hosts.");
  console.log("2. Add open/close controls in meeting UI via useApps().");
  console.log("3. Render the app when appsState.activeAppId matches your id.");
  console.log("4. Follow packages/apps-sdk/docs/add-a-new-app-integration.md for full wiring.");
  console.log("5. Run pnpm -C packages/apps-sdk run check:apps before opening a PR.");
  console.log("");
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
