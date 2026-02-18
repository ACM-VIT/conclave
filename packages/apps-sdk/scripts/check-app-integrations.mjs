#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");

const APPS_SRC_DIR = path.join(packageDir, "src", "apps");
const PACKAGE_JSON_PATH = path.join(packageDir, "package.json");
const MOBILE_TSCONFIG_PATH = path.join(repoRoot, "apps", "mobile", "tsconfig.json");

const args = new Set(process.argv.slice(2));
const shouldFix = args.has("--fix");
const showHelp = args.has("--help");

const usage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run check:apps
  pnpm -C packages/apps-sdk run check:apps --fix

Options:
  --fix      Apply safe JSON fixes for package exports and mobile tsconfig aliases
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
      const hasNative = fs.existsSync(path.join(appDir, "native", "index.ts"));
      return hasCore || hasWeb || hasNative;
    })
    .sort((a, b) => a.localeCompare(b));
};

const appInfo = (appId) => {
  const appDir = path.join(APPS_SRC_DIR, appId);
  const core = fs.existsSync(path.join(appDir, "core", "index.ts"));
  const coreDoc = fs.existsSync(path.join(appDir, "core", "doc", "index.ts"));
  const web = fs.existsSync(path.join(appDir, "web", "index.ts"));
  const native = fs.existsSync(path.join(appDir, "native", "index.ts"));
  return { appId, core, coreDoc, web, native };
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
  if (!app.web && !app.native) {
    errors.push(`[${app.appId}] missing web/native renderer entrypoint`);
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
  if (app.native) {
    expectedExports[`./${app.appId}/native`] = `./src/apps/${app.appId}/native/index.ts`;
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
  const match = key.match(/^\.\/([^/]+)\/(core|web|native)$/);
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

const mobileTsconfig = readJson(MOBILE_TSCONFIG_PATH);
const compilerOptions = mobileTsconfig.compilerOptions ?? {};
const mobilePaths = { ...(compilerOptions.paths ?? {}) };
const nextMobilePaths = { ...mobilePaths };

const expectedMobilePaths = {};
for (const app of apps) {
  if (app.core) {
    expectedMobilePaths[`@conclave/apps-sdk/${app.appId}/core`] = [
      `../../packages/apps-sdk/src/apps/${app.appId}/core/index.ts`,
    ];
  }
  if (app.web) {
    expectedMobilePaths[`@conclave/apps-sdk/${app.appId}/web`] = [
      `../../packages/apps-sdk/src/apps/${app.appId}/web/index.ts`,
    ];
  }
  if (app.native) {
    expectedMobilePaths[`@conclave/apps-sdk/${app.appId}/native`] = [
      `../../packages/apps-sdk/src/apps/${app.appId}/native/index.ts`,
    ];
  }
}

const sameArray = (a, b) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((item, idx) => item === b[idx]);

for (const [key, expected] of Object.entries(expectedMobilePaths)) {
  const current = nextMobilePaths[key];
  if (sameArray(current, expected)) continue;
  if (typeof current === "undefined") {
    errors.push(`apps/mobile/tsconfig.json missing paths["${key}"]`);
  } else {
    errors.push(
      `apps/mobile/tsconfig.json mismatch for paths["${key}"]`
    );
  }
  if (shouldFix) {
    nextMobilePaths[key] = expected;
    fixes.push(`apps/mobile/tsconfig.json: set paths["${key}"]`);
  }
}

for (const key of Object.keys(nextMobilePaths)) {
  const match = key.match(/^@conclave\/apps-sdk\/([^/]+)\/(core|web|native)$/);
  if (!match) continue;
  const [, appId, part] = match;
  const app = apps.find((item) => item.appId === appId);
  if (!app) {
    warnings.push(`apps/mobile/tsconfig.json has stale alias ${key}`);
    if (shouldFix) {
      delete nextMobilePaths[key];
      fixes.push(`apps/mobile/tsconfig.json: removed stale paths["${key}"]`);
    }
    continue;
  }
  if (!app[part]) {
    warnings.push(`apps/mobile/tsconfig.json has ${key} but ${appId}/${part}/index.ts is missing`);
    if (shouldFix) {
      delete nextMobilePaths[key];
      fixes.push(`apps/mobile/tsconfig.json: removed invalid paths["${key}"]`);
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

  const pathsChanged =
    JSON.stringify(sortObjectKeys(nextMobilePaths)) !==
    JSON.stringify(sortObjectKeys(mobilePaths));
  if (pathsChanged) {
    mobileTsconfig.compilerOptions = compilerOptions;
    mobileTsconfig.compilerOptions.paths = sortObjectKeys(nextMobilePaths);
    writeJson(MOBILE_TSCONFIG_PATH, mobileTsconfig);
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
