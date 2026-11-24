#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newAppIdProblem } from "./app-id-rules.mjs";

const rootFlagIndex = process.argv.indexOf("--root");
// `--root` scaffolds into another copy of this package. Tests use it.
const packageDir =
  rootFlagIndex === -1
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : path.resolve(process.argv[rootFlagIndex + 1]);
const packageJsonPath = path.join(packageDir, "package.json");
const appsSourceDir = path.join(packageDir, "src", "apps");
const valueFlags = new Set(["name", "description", "id", "runtime", "root"]);
const RUNTIMES = ["doc", "authority"];

const printUsage = () => {
  console.log(`Usage:
  pnpm -C packages/apps-sdk run new:app <slug> [options]

Examples:
  pnpm -C packages/apps-sdk run new:app sketchpad
  pnpm -C packages/apps-sdk run new:app music-queue --name "Music Queue"
  pnpm -C packages/apps-sdk run new:app sign-up --runtime authority

Options:
  --id <id>              Explicit app id (defaults to normalized slug). An id
                         a contract could not have, one the SDK uses itself,
                         or one package.json already exports something under,
                         is refused.
  --name <name>          Display name (defaults from id)
  --description <text>   App description
  --runtime <runtime>    "doc" (default): a shared Yjs document everyone edits.
                         "authority": rules that run on the SFU, with views
                         per audience. Use it for anything a participant must
                         not be able to forge or read.
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

const scaffoldAuthorityApp = ({ appId, appName, appDescription, dryRun }) => {
  const pascal = toPascalCase(appId);
  const camel = toCamelCase(appId);
  const appDir = path.join(appsSourceDir, appId);
  if (fs.existsSync(appDir)) {
    throw new Error(`App directory already exists: ${appDir}`);
  }

  const files = [
    {
      path: path.join(appDir, "core", "index.ts"),
      content: `import { defineContract, s } from "@conclave/apps-sdk/authority";

/**
 * What the renderer and the server agree on. This file is the only part of
 * the app's rules a browser loads, so nothing private belongs here.
 */
const entry = s.object({
  id: s.string({ max: 64 }),
  name: s.string({ max: 200 }),
  joinedAt: s.number(),
});

export const ${camel}Contract = defineContract({
  id: "${appId}",
  major: 1,
  surface: "panel",
  actions: {
    join: { input: s.null(), receipt: s.null() },
    leave: { input: s.null(), receipt: s.null() },
  },
  queries: {},
  views: {
    /** Everyone on the list, for everyone who may open the app. */
    entries: entry,
    /** Present only for the viewer's own entry. */
    mine: s.object({}),
  },
});
`,
    },
    {
      path: path.join(appDir, "server", "index.ts"),
      content: `import { ${camel}Contract } from "@conclave/apps-sdk/${appId}/core";
import {
  defineAuthority,
  key,
  reject,
  table,
  type Subject,
} from "@conclave/apps-sdk/authority/server";

/**
 * The app's rules. This runs on the SFU and nowhere else: a browser never
 * loads it, and \`check:apps\` fails any web or native file that imports it.
 */
type Entry = { id: string; subject: Subject; name: string; joinedAt: number };

const MAX_ENTRIES = 500;

export const ${camel}Authority = defineAuthority({
  contract: ${camel}Contract,
  tables: {
    entries: table<Entry>({ maxRows: MAX_ENTRIES }),
  },
  timers: {},
  canView: ({ role }) => role === "moderator" || role === "member",
  actions: {
    join: {
      roles: ["moderator", "member"],
      rate: { burst: 5, perSecond: 1 },
      run(ctx, tx) {
        if (tx.count("entries") >= MAX_ENTRIES) reject("full");
        // One entry per person: the key is the person. A second tab, a
        // reconnect or a retry lands on the same key and changes nothing.
        tx.insertIfAbsent("entries", key(ctx.subject), {
          id: ctx.nextId("e"),
          subject: ctx.subject,
          name: ctx.displayName,
          joinedAt: ctx.now,
        });
        return null;
      },
    },
    leave: {
      roles: ["moderator", "member"],
      rate: { burst: 5, perSecond: 1 },
      run(ctx, tx) {
        tx.delete("entries", key(ctx.subject));
        return null;
      },
    },
  },
  queries: {},
  onTimer: {},
  views: {
    entries: {
      kind: "shared",
      source: "entries",
      // The subject never leaves the server. Each row has its own public id.
      project: (row) => ({
        key: row.id,
        value: { id: row.id, name: row.name, joinedAt: row.joinedAt },
      }),
    },
    mine: {
      kind: "personal",
      source: "entries",
      owner: (row) => row.subject,
      project: () => ({ key: "entry", value: {} }),
    },
  },
  mergeSubjects(_ctx, tx, { from, into }) {
    const entry = tx.get("entries", key(from));
    if (!entry) return undefined;
    tx.delete("entries", key(from));
    tx.insertIfAbsent("entries", key(into), { ...entry, subject: into });
    return undefined;
  },
});
`,
    },
    {
      path: path.join(appDir, "web", "components", `${pascal}Panel.tsx`),
      content: `import { useAuthority } from "../../../../sdk/authority/react";
import { ${camel}Contract } from "../../core/index";

export function ${pascal}Panel() {
  const app = useAuthority(${camel}Contract);
  if (app.state.kind !== "ready") {
    return (
      <p className="px-4 py-6 text-sm text-white/60">
        {app.state.kind === "connecting" ? "Loading" : "Not available here"}
      </p>
    );
  }

  const { view, actions } = app.state;
  const joined = view.mine.size > 0;
  const entries = [...view.entries.values()].sort(
    (a, b) => a.joinedAt - b.joinedAt,
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <ul className="flex flex-col gap-1 text-sm text-white">
        {entries.map((entry) => (
          <li key={entry.id}>{entry.name}</li>
        ))}
      </ul>
      {actions.has(joined ? "leave" : "join") && (
        <button
          type="button"
          className="rounded-lg border border-white/10 px-3 py-2 text-sm text-white"
          onClick={() => void app.act(joined ? "leave" : "join", null)}
        >
          {joined ? "Leave the list" : "Join the list"}
        </button>
      )}
    </div>
  );
}
`,
    },
    {
      path: path.join(appDir, "web", "index.ts"),
      content: `import { defineAuthorityApp } from "../../../sdk/authority/app";
import { ${camel}Contract } from "../core/index";
import { ${pascal}Panel } from "./components/${pascal}Panel";

export const ${camel}App = defineAuthorityApp({
  contract: ${camel}Contract,
  name: "${appName}",
  description: "${appDescription}",
  panel: ${pascal}Panel,
});

export { ${pascal}Panel };
`,
    },
  ];

  for (const file of files) {
    writeFile(file.path, file.content, dryRun);
  }
  return files.map((file) => file.path);
};

const updatePackageExports = (appId, runtime, dryRun) => {
  const pkg = readJson(packageJsonPath);
  const exports = {
    ...(pkg.exports ?? {}),
    [`./${appId}/core`]: `./src/apps/${appId}/core/index.ts`,
    [`./${appId}/web`]: `./src/apps/${appId}/web/index.ts`,
    ...(runtime === "authority"
      ? { [`./${appId}/server`]: `./src/apps/${appId}/server/index.ts` }
      : {}),
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
  // Decided before anything is written: a refused id leaves no files behind.
  const problem = newAppIdProblem(appId, readJson(packageJsonPath).exports);
  if (problem) throw new Error(problem);

  const appName = (values.name ?? toTitleCase(appId)).trim();
  const appDescription = (values.description ?? `${appName} app`).trim();
  const dryRun = flags.has("dry-run");
  const runtime = (values.runtime ?? "doc").trim();
  if (!RUNTIMES.includes(runtime)) {
    throw new Error(`Unknown runtime "${runtime}". Use one of: ${RUNTIMES.join(", ")}.`);
  }
  const scaffold = runtime === "authority" ? scaffoldAuthorityApp : scaffoldApp;
  const createdFiles = scaffold({
    appId,
    appName,
    appDescription,
    dryRun,
  });
  updatePackageExports(appId, runtime, dryRun);

  console.log(`Scaffold complete for "${appId}" (${appName}).`);
  console.log(`Created ${createdFiles.length} file(s) and updated package exports.`);
  if (runtime === "authority") {
    console.log(
      `Next: add the app's server entry to the SFU registry (packages/sfu/server/apps/authority/registry.ts), list ${toCamelCase(appId)}App in the web meeting host, then run check:apps.`,
    );
    return;
  }
  console.log("Next: register the app in the web meeting host, wire controls, then run check:apps.");
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
