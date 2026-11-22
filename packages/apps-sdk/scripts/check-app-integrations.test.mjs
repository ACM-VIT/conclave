/**
 * Runs `new:app` and `check:apps` against a throwaway copy of the package
 * layout, so the rules are tested by breaking them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));

const run = (script, args) => {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

/** A minimal monorepo: this package, a web app and the SFU's registry. */
const makeRepo = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "apps-sdk-check-"));
  const root = path.join(repo, "packages", "apps-sdk");
  fs.mkdirSync(path.join(root, "src", "apps"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "sdk", "authority"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "sdk", "authority", "server.ts"), "export {};\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@conclave/apps-sdk",
        exports: {
          ".": "./src/index.ts",
          "./authority/server": "./src/sdk/authority/server.ts",
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.mkdirSync(path.join(repo, "apps", "web", "src"), { recursive: true });
  const registry = path.join(repo, "packages", "sfu", "server", "apps", "authority");
  fs.mkdirSync(registry, { recursive: true });
  const write = (relative, content) => {
    const target = path.join(repo, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write(
    "packages/sfu/server/apps/authority/registry.ts",
    'import type { AuthorityModule } from "@conclave/apps-sdk/authority/server";\nexport const AUTHORITY_MODULES: readonly AuthorityModule[] = [];\n',
  );
  return {
    root,
    write,
    check: () => run("check-app-integrations.mjs", ["--root", root]),
    scaffold: (id, ...args) => run("create-app-integration.mjs", [id, "--root", root, ...args]),
  };
};

test("a scaffolded authority app passes the check", () => {
  const repo = makeRepo();

  const scaffolded = repo.scaffold("sign-up", "--runtime", "authority");
  const checked = repo.check();

  assert.equal(scaffolded.status, 0, scaffolded.output);
  assert.equal(checked.status, 0, checked.output);
  assert.match(checked.output, /passed for 1 app/);
  for (const part of ["core", "web", "server"]) {
    assert.ok(fs.existsSync(path.join(repo.root, "src", "apps", "sign-up", part, "index.ts")));
  }
  const exported = JSON.parse(fs.readFileSync(path.join(repo.root, "package.json"), "utf8")).exports;
  assert.equal(exported["./sign-up/server"], "./src/apps/sign-up/server/index.ts");
});

test("a scaffolded doc app still passes the check", () => {
  const repo = makeRepo();

  const scaffolded = repo.scaffold("sketchpad");
  const checked = repo.check();

  assert.equal(scaffolded.status, 0, scaffolded.output);
  assert.equal(checked.status, 0, checked.output);
  assert.ok(!fs.existsSync(path.join(repo.root, "src", "apps", "sketchpad", "server")));
});

test("an app's renderer may not import its server entry", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/leak.ts",
    'import { signUpAuthority } from "../server/index";\nexport const leak = signUpAuthority;\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /sign-up\/web\/leak\.ts imports server-only code/);
});

test("type-only and package-name imports of server code are refused too", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/core/types.ts",
    'import type { Subject } from "@conclave/apps-sdk/authority/server";\nexport type Who = Subject;\n',
  );
  repo.write(
    "packages/apps-sdk/src/native-embed/sign-up.ts",
    'export { signUpAuthority } from "@conclave/apps-sdk/sign-up/server";\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /core\/types\.ts imports server-only code/);
  assert.match(checked.output, /native-embed\/sign-up\.ts imports server-only code/);
});

test("the web app may not import any server entry", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "apps/web/src/app/panel.tsx",
    'import { signUpAuthority } from "@conclave/apps-sdk/sign-up/server";\nexport const rules = signUpAuthority;\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /apps\/web\/src\/app\/panel\.tsx imports server-only code/);
});

test("the web app may not reach a server entry by relative path either", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "apps/web/src/app/panel.tsx",
    'import { signUpAuthority } from "../../../../packages/apps-sdk/src/apps/sign-up/server/index";\nexport const rules = signUpAuthority;\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /apps\/web\/src\/app\/panel\.tsx imports server-only code/);
});

test("a lazy import is read however its path is written", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/template.ts",
    "export const load = () => import(`../server/index`);\n",
  );
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/commented.ts",
    'export const load = () => import(/* webpackChunkName: "rules" */ "../server/index");\n',
  );
  repo.write(
    "apps/web/src/app/required.ts",
    'export const rules = require("@conclave/apps-sdk/sign-up/server");\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /sign-up\/web\/template\.ts imports server-only code/);
  assert.match(checked.output, /sign-up\/web\/commented\.ts imports server-only code/);
  assert.match(checked.output, /apps\/web\/src\/app\/required\.ts imports server-only code/);
});

test("a lazy import whose path is worked out at run time is refused near server code", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  // A bundler ships every file such a path could name, the server entry too.
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/computed.ts",
    "export const load = (part: string) => import(`../${part}/index`);\n",
  );
  repo.write(
    "apps/web/src/app/computed.ts",
    "export const load = (app: string) => import(`@conclave/apps-sdk/${app}/server`);\n",
  );
  // Elsewhere in the web app a computed path cannot reach this package.
  repo.write(
    "apps/web/src/app/locale.ts",
    "export const load = (lang: string) => import(`./locales/${lang}`);\n",
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /sign-up\/web\/computed\.ts builds an import path at run time/);
  assert.match(checked.output, /apps\/web\/src\/app\/computed\.ts builds an import path at run time/);
  assert.doesNotMatch(checked.output, /locale\.ts/);
});

test("a JavaScript file is checked like a TypeScript one", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  // The web project compiles JavaScript too, so each of these would ship.
  repo.write(
    "apps/web/src/app/panel.js",
    'import { signUpAuthority } from "@conclave/apps-sdk/sign-up/server";\nexport const rules = signUpAuthority;\n',
  );
  repo.write(
    "apps/web/src/app/panel-view.jsx",
    'import { signUpAuthority } from "@conclave/apps-sdk/sign-up/server";\nexport const Panel = () => <p>{signUpAuthority.contract.id}</p>;\n',
  );
  repo.write(
    "apps/web/src/app/worker.mjs",
    'export const load = () => import("@conclave/apps-sdk/sign-up/server");\n',
  );
  repo.write(
    "apps/web/src/app/legacy.cjs",
    'module.exports = require("@conclave/apps-sdk/sign-up/server");\n',
  );
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/leak.jsx",
    'import { signUpAuthority } from "../server/index";\nexport const Leak = () => <p>{signUpAuthority.contract.id}</p>;\n',
  );
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/computed.js",
    "export const load = (part) => import(`../${part}/index`);\n",
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /apps\/web\/src\/app\/panel\.js imports server-only code/);
  assert.match(checked.output, /apps\/web\/src\/app\/panel-view\.jsx imports server-only code/);
  assert.match(checked.output, /apps\/web\/src\/app\/worker\.mjs imports server-only code/);
  assert.match(checked.output, /apps\/web\/src\/app\/legacy\.cjs imports server-only code/);
  assert.match(checked.output, /sign-up\/web\/leak\.jsx imports server-only code/);
  assert.match(checked.output, /sign-up\/web\/computed\.js builds an import path at run time/);
});

test("a server entry reached through a JavaScript file's own extension is still found", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/server/secrets.mjs",
    'export const answerKey = "42";\n',
  );
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/peek.ts",
    'export { answerKey } from "../server/secrets.mjs";\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /sign-up\/web\/peek\.ts imports server-only code/);
});

test("a Node script that loads files by path is not taken for bundled code", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  // It imports a Node builtin, so no browser or native bundle can hold it.
  repo.write(
    "packages/apps-sdk/src/native-embed/tests/contract-test.mjs",
    'import path from "node:path";\nimport { pathToFileURL } from "node:url";\nexport const load = (file) => import(pathToFileURL(path.join("..", file)).href);\n',
  );
  // Its fixed imports are held to the rule all the same.
  repo.write(
    "packages/apps-sdk/src/native-embed/tests/peek-test.mjs",
    'import path from "node:path";\nimport { signUpAuthority } from "../../apps/sign-up/server/index.ts";\nexport const where = path.sep + signUpAuthority.contract.id;\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.doesNotMatch(checked.output, /contract-test\.mjs/);
  assert.match(checked.output, /tests\/peek-test\.mjs imports server-only code/);
});

test("words that only look like an import are left alone", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/apps-sdk/src/apps/sign-up/web/notes.ts",
    '// import { signUpAuthority } from "../server/index";\nexport const hint = \'import("../server/index")\';\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 0, checked.output);
});

test("an authority app needs a contract with its own id and a server definition", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  const core = path.join(repo.root, "src", "apps", "sign-up", "core", "index.ts");
  fs.writeFileSync(core, fs.readFileSync(core, "utf8").replace('id: "sign-up"', 'id: "other"'));
  fs.writeFileSync(
    path.join(repo.root, "src", "apps", "sign-up", "server", "index.ts"),
    "export const rules = {};\n",
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /must have id "sign-up"/);
  assert.match(checked.output, /must define the app's rules with defineAuthority/);
});

test("the SFU registry may only name apps that have a server entry", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  repo.write(
    "packages/sfu/server/apps/authority/registry.ts",
    'import { ghostAuthority } from "@conclave/apps-sdk/ghost/server";\nexport const AUTHORITY_MODULES = [ghostAuthority];\n',
  );

  const checked = repo.check();

  assert.equal(checked.status, 1);
  assert.match(checked.output, /ghost has no server\/index\.ts/);
  assert.match(checked.output, /\[sign-up\] is an authority app but is not in the SFU registry/);
});

test("a missing server export is reported and fixed", () => {
  const repo = makeRepo();
  repo.scaffold("sign-up", "--runtime", "authority");
  const manifest = path.join(repo.root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  delete pkg.exports["./sign-up/server"];
  fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2));

  const broken = repo.check();
  run("check-app-integrations.mjs", ["--root", repo.root, "--fix"]);
  const fixed = repo.check();

  assert.equal(broken.status, 1);
  assert.match(broken.output, /exports missing \.\/sign-up\/server/);
  assert.equal(fixed.status, 0, fixed.output);
});
