#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const argv = process.argv.slice(2);
const args = new Set(argv);
const shouldFix = args.has("--fix");
const showHelp = args.has("--help");
const rootIndex = argv.indexOf("--root");
// `--root` points the check at another copy of this package. Tests use it.
const packageDir =
  rootIndex === -1
    ? path.resolve(__dirname, "..")
    : path.resolve(argv[rootIndex + 1]);

const SRC_DIR = path.join(packageDir, "src");
const APPS_SRC_DIR = path.join(SRC_DIR, "apps");
const PACKAGE_JSON_PATH = path.join(packageDir, "package.json");
const PACKAGE_NAME = "@conclave/apps-sdk";
const WEB_SRC_DIR = path.resolve(packageDir, "..", "..", "apps", "web", "src");
const SFU_REGISTRY_PATH = path.resolve(
  packageDir,
  "..",
  "sfu",
  "server",
  "apps",
  "authority",
  "registry.ts",
);

const usage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run check:apps
  pnpm -C packages/apps-sdk run check:apps --fix

Options:
  --fix          Apply safe JSON fixes for package exports
  --root <dir>   Check another copy of this package
  --help         Show this help
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

const APP_PARTS = ["core", "web", "server"];

const getApps = () => {
  if (!fs.existsSync(APPS_SRC_DIR)) return [];
  const entries = fs.readdirSync(APPS_SRC_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((appId) =>
      APP_PARTS.some((part) =>
        fs.existsSync(path.join(APPS_SRC_DIR, appId, part, "index.ts")),
      ),
    )
    .sort((a, b) => a.localeCompare(b));
};

const appInfo = (appId) => {
  const appDir = path.join(APPS_SRC_DIR, appId);
  const has = (...parts) => fs.existsSync(path.join(appDir, ...parts));
  return {
    appId,
    core: has("core", "index.ts"),
    coreDoc: has("core", "doc", "index.ts"),
    web: has("web", "index.ts"),
    // A `server` entry makes this an authority app: its rules run on the SFU.
    server: has("server", "index.ts"),
  };
};

const apps = getApps().map(appInfo);

const errors = [];
const warnings = [];
const fixes = [];

const readAppFile = (appId, ...parts) =>
  fs.readFileSync(path.join(APPS_SRC_DIR, appId, ...parts), "utf8");

for (const app of apps) {
  if (!app.core) {
    errors.push(`[${app.appId}] missing core/index.ts`);
  }
  if (!app.server && !app.coreDoc) {
    warnings.push(`[${app.appId}] missing core/doc/index.ts`);
  }
  if (!app.web) {
    errors.push(`[${app.appId}] missing web/index.ts`);
  }
  if (!app.server) continue;

  // An authority app's contract lives in `core`, the one part a renderer and
  // the SFU both load. Its id must be the app's folder name.
  if (app.core) {
    const core = readAppFile(app.appId, "core", "index.ts");
    if (!/\bdefineContract\s*\(/.test(core)) {
      errors.push(
        `[${app.appId}] core/index.ts must define the app's contract with defineContract`,
      );
    } else if (!new RegExp(`\\bid:\\s*["']${app.appId}["']`).test(core)) {
      errors.push(
        `[${app.appId}] the contract in core/index.ts must have id "${app.appId}"`,
      );
    }
  }
  const server = readAppFile(app.appId, "server", "index.ts");
  if (!/\bdefineAuthority\s*\(/.test(server)) {
    errors.push(
      `[${app.appId}] server/index.ts must define the app's rules with defineAuthority`,
    );
  }
}

/* ---- Server code never reaches a browser or native bundle ---------------- */

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

const listSources = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSources(full));
    else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) found.push(full);
  }
  return found;
};

/** The text a path starts with before its first run-time part, if any. */
const fixedHead = (expression) => {
  if (ts.isTemplateExpression(expression)) return expression.head.text;
  let leftmost = expression;
  while (
    ts.isBinaryExpression(leftmost) &&
    leftmost.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    leftmost = leftmost.left;
  }
  return ts.isStringLiteralLike(leftmost) ? leftmost.text : "";
};

/**
 * Every module a file loads, read from its syntax tree. Text matching would
 * miss a path written as a template string or after a comment, and would
 * trip over a comment that only mentions an import.
 *
 * `fixed` holds the paths written out in full. `computed` holds the fixed
 * head of each path that is put together at run time.
 */
const importsOf = (filePath) => {
  const tree = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const fixed = [];
  const computed = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      fixed.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      fixed.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      fixed.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const [target] = node.arguments;
      if (target && ts.isStringLiteralLike(target)) fixed.push(target.text);
      else if (target) computed.push(fixedHead(target));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { fixed, computed };
};

const resolveFile = (candidate) => {
  const withoutJs = candidate.replace(/\.js$/, "");
  const attempts = [
    candidate,
    ...SOURCE_EXTENSIONS.map((extension) => `${withoutJs}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(withoutJs, `index${extension}`)),
  ];
  return attempts.find(
    (attempt) => fs.existsSync(attempt) && fs.statSync(attempt).isFile(),
  );
};

const pkg = readJson(PACKAGE_JSON_PATH);

/** The file inside this package a specifier points at, if it points here. */
const resolveSpecifier = (fromFile, specifier) => {
  if (specifier.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  }
  if (specifier.startsWith("#")) {
    const target = pkg.imports?.[specifier];
    return typeof target === "string"
      ? resolveFile(path.resolve(packageDir, target))
      : undefined;
  }
  if (specifier === PACKAGE_NAME || specifier.startsWith(`${PACKAGE_NAME}/`)) {
    const subpath = `.${specifier.slice(PACKAGE_NAME.length)}`;
    const target = pkg.exports?.[subpath === "." ? "." : subpath];
    return typeof target === "string"
      ? resolveFile(path.resolve(packageDir, target))
      : undefined;
  }
  return undefined;
};

const relative = (filePath) => path.relative(packageDir, filePath);

/**
 * Server-only code: an app's `server` folder and the SDK's server definition
 * API. It holds an app's private rules, and can hold secrets such as a quiz's
 * answer key, so nothing a browser or a native embed loads may import it.
 */
const isServerOnly = (filePath) => {
  const rel = relative(filePath).split(path.sep).join("/");
  return (
    /^src\/apps\/[^/]+\/server\//.test(rel) ||
    rel === "src/sdk/authority/server.ts" ||
    rel === "src/sdk/authority/definition.ts"
  );
};

// A bundler cannot tell which file a run-time path will name, so it ships
// every file the path could name. Near server-only code that is a leak.
const COMPUTED_IMPORT =
  "builds an import path at run time. Write the path out in full: a bundler ships every file such a path could name, an app's server entry included.";

for (const filePath of listSources(SRC_DIR)) {
  if (isServerOnly(filePath)) continue;
  const imports = importsOf(filePath);
  for (const specifier of imports.fixed) {
    const target = resolveSpecifier(filePath, specifier);
    if (target && isServerOnly(target)) {
      errors.push(
        `${relative(filePath)} imports server-only code (${specifier}). Only the SFU may load an app's server entry.`,
      );
    }
  }
  if (imports.computed.length > 0) {
    errors.push(`${relative(filePath)} ${COMPUTED_IMPORT}`);
  }
}

const SERVER_SUBPATH = new RegExp(
  `^${PACKAGE_NAME.replace("/", "\\/")}\\/(?:authority\\/server|[^/]+\\/server)$`,
);
/** Whether a run-time path that starts with `head` could name a file here. */
const couldReachPackage = (fromFile, head) => {
  if (head.startsWith(PACKAGE_NAME)) return true;
  if (!head.startsWith(".")) return false;
  const start = path.resolve(path.dirname(fromFile), head);
  const within = (parent, child) =>
    child === parent || child.startsWith(`${parent}${path.sep}`);
  return within(packageDir, start) || within(start, packageDir);
};

for (const filePath of listSources(WEB_SRC_DIR)) {
  const webFile = path.relative(path.resolve(packageDir, "..", ".."), filePath);
  const imports = importsOf(filePath);
  for (const specifier of imports.fixed) {
    // By package name, or by a relative path that reaches into this package.
    const reached = specifier.startsWith(".")
      ? resolveFile(path.resolve(path.dirname(filePath), specifier))
      : undefined;
    const reachesServer =
      reached !== undefined &&
      reached.startsWith(`${packageDir}${path.sep}`) &&
      isServerOnly(reached);
    if (SERVER_SUBPATH.test(specifier) || reachesServer) {
      errors.push(
        `${webFile} imports server-only code (${specifier}). Only the SFU may load an app's server entry.`,
      );
    }
  }
  if (imports.computed.some((head) => couldReachPackage(filePath, head))) {
    errors.push(`${webFile} ${COMPUTED_IMPORT}`);
  }
}

/* ---- The SFU's allowlist names real apps --------------------------------- */

if (fs.existsSync(SFU_REGISTRY_PATH)) {
  const registry = fs.readFileSync(SFU_REGISTRY_PATH, "utf8");
  const registered = new Set();
  const pattern = new RegExp(
    `["']${PACKAGE_NAME.replace("/", "\\/")}\\/([^/"']+)\\/server["']`,
    "g",
  );
  for (const match of registry.matchAll(pattern)) {
    // `authority/server` is the SDK's own definition API, not an app.
    if (match[1] !== "authority") registered.add(match[1]);
  }
  for (const appId of registered) {
    if (!apps.some((app) => app.appId === appId && app.server)) {
      errors.push(
        `The SFU registry imports ${PACKAGE_NAME}/${appId}/server, but ${appId} has no server/index.ts`,
      );
    }
  }
  for (const app of apps) {
    if (app.server && !registered.has(app.appId)) {
      warnings.push(
        `[${app.appId}] is an authority app but is not in the SFU registry (packages/sfu/server/apps/authority/registry.ts), so no room runs it`,
      );
    }
  }
}

/* ---- Package exports ------------------------------------------------------ */

const pkgExports = { ...(pkg.exports ?? {}) };
const nextExports = { ...pkgExports };

const expectedExports = {};
for (const app of apps) {
  for (const part of APP_PARTS) {
    if (app[part]) {
      expectedExports[`./${app.appId}/${part}`] =
        `./src/apps/${app.appId}/${part}/index.ts`;
    }
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
  const match = key.match(/^\.\/([^/]+)\/(core|web|server)$/);
  if (!match) continue;
  const [, appId, part] = match;
  // `./authority/server` is the SDK's own subpath, not an app's.
  if (appId === "authority") continue;
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
