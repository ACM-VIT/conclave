#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");

const APPS_SRC_DIR = path.join(packageDir, "src", "apps");
const PACKAGE_JSON_PATH = path.join(packageDir, "package.json");

const args = new Set(process.argv.slice(2));
const shouldFix = args.has("--fix");
const showHelp = args.has("--help");

const usage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run check:apps
  pnpm -C packages/apps-sdk run check:apps --fix

Options:
  --fix      Apply safe JSON fixes for package exports
  --help     Show this help
`);
};

if (showHelp) {
  usage();
  process.exit(0);
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

const getApps = () => {
  const entries = fs.readdirSync(APPS_SRC_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((appId) => {
      const appDir = path.join(APPS_SRC_DIR, appId);
      const hasCore = fs.existsSync(path.join(appDir, "core", "index.ts"));
      const hasWeb = fs.existsSync(path.join(appDir, "web", "index.ts"));
      return hasCore || hasWeb;
    })
    .sort((a, b) => a.localeCompare(b));
};

const appInfo = (appId) => {
  const appDir = path.join(APPS_SRC_DIR, appId);
  const core = fs.existsSync(path.join(appDir, "core", "index.ts"));
  const coreDoc = fs.existsSync(path.join(appDir, "core", "doc", "index.ts"));
  const web = fs.existsSync(path.join(appDir, "web", "index.ts"));
  return { appId, core, coreDoc, web };
};

const apps = getApps().map(appInfo);

const errors = [];
const warnings = [];
const fixes = [];

for (const app of apps) {
  if (!app.core) {
    errors.push(`[${app.appId}] missing core/index.ts`);
  }
  if (!app.coreDoc) {
    warnings.push(`[${app.appId}] missing core/doc/index.ts`);
  }
  if (!app.web) {
    errors.push(`[${app.appId}] missing web/index.ts`);
  }
}

const pkg = readJson(PACKAGE_JSON_PATH);
const pkgExports = { ...(pkg.exports ?? {}) };
const nextExports = { ...pkgExports };

const expectedExports = {};
for (const app of apps) {
  if (app.core) {
    expectedExports[`./${app.appId}/core`] = `./src/apps/${app.appId}/core/index.ts`;
  }
  if (app.web) {
    expectedExports[`./${app.appId}/web`] = `./src/apps/${app.appId}/web/index.ts`;
  }
}

for (const [key, expected] of Object.entries(expectedExports)) {
  const current = nextExports[key];
  if (current === expected) continue;
  if (typeof current === "undefined") {
    errors.push(`package.json exports missing ${key}`);
  } else {
    errors.push(`package.json exports mismatch for ${key} (got "${current}")`);
  }
  if (shouldFix) {
    nextExports[key] = expected;
    fixes.push(`package.json: set exports["${key}"]`);
  }
}

for (const key of Object.keys(nextExports)) {
  const match = key.match(/^\.\/([^/]+)\/(core|web)$/);
  if (!match) continue;
  const [, appId, part] = match;
  const app = apps.find((item) => item.appId === appId);
  if (!app) {
    warnings.push(`package.json exports has stale entry ${key}`);
    if (shouldFix) {
      delete nextExports[key];
      fixes.push(`package.json: removed stale exports["${key}"]`);
    }
    continue;
  }
  if (!app[part]) {
    warnings.push(`package.json exports has ${key} but ${appId}/${part}/index.ts is missing`);
    if (shouldFix) {
      delete nextExports[key];
      fixes.push(`package.json: removed invalid exports["${key}"]`);
    }
  }
}

if (shouldFix) {
  const exportsChanged =
    JSON.stringify(sortObjectKeys(nextExports)) !==
    JSON.stringify(sortObjectKeys(pkgExports));
  if (exportsChanged) {
    pkg.exports = sortObjectKeys(nextExports);
    writeJson(PACKAGE_JSON_PATH, pkg);
  }
}

if (warnings.length > 0) {
  console.log("Warnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}

if (errors.length > 0) {
  console.log("Errors:");
  for (const error of errors) {
    console.log(`- ${error}`);
  }
}

if (fixes.length > 0) {
  console.log("Applied fixes:");
  for (const fix of fixes) {
    console.log(`- ${fix}`);
  }
}

if (errors.length === 0) {
  console.log(`Apps SDK integration check passed for ${apps.length} app(s).`);
  process.exit(0);
}

if (shouldFix) {
  console.log("Ran with --fix; re-run the check to confirm a clean state.");
}
process.exit(1);
