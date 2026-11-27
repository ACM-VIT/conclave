import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as vm from "node:vm";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const adapterEntry = pathToFileURL(require.resolve("@opennextjs/cloudflare"));
const { inlineLoadManifest } = await import(
  new URL("../cli/build/patches/plugins/load-manifest.js", adapterEntry)
);

test("Cloudflare inlines Next.js preview props and rejects unknown manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conclave-manifests-"));
  try {
    const outputDir = path.join(root, ".open-next");
    const nextDir = path.join(outputDir, "server-functions/default/apps/web/.next");
    await mkdir(path.join(nextDir, "server"), { recursive: true });
    const preview = {
      previewModeId: "fixture-id",
      previewModeSigningKey: "fixture-signing-key",
      previewModeEncryptionKey: "fixture-encryption-key",
    };
    const prerender = { version: 4, routes: {} };
    await writeFile(path.join(nextDir, "server/preview-props.json"), JSON.stringify(preview));
    await writeFile(path.join(nextDir, "prerender-manifest.json"), JSON.stringify(prerender));

    let updates;
    inlineLoadManifest({
      updateContent(_name, entries) { updates = entries; },
    }, {
      outputDir,
      monorepoRoot: root,
      appBuildOutputPath: path.join(root, "apps/web"),
    });
    const nextLoadManifest = require.resolve("next/dist/server/load-manifest.external.js", {
      paths: [path.join(import.meta.dirname, "../apps/web")],
    });
    const code = await updates[0].callback({
      contents: await readFile(nextLoadManifest, "utf8"),
      path: nextLoadManifest,
    });
    const module = { exports: {} };
    const unavailableFs = {
      readFileSync() {
        throw new Error("Filesystem unavailable");
      },
    };
    const stubs = {
      fs: unavailableFs,
      path,
      vm,
      "../shared/lib/deep-freeze": { deepFreeze: (value) => value },
    };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: (id) => {
        if (!(id in stubs)) throw new Error(`Unexpected require(${id})`);
        return stubs[id];
      },
      process: { env: { NEXT_BUILD_ID: "fixture-build" } },
    });
    const { loadManifest } = module.exports;
    const load = (manifest) => loadManifest(manifest, false);
    assert.deepEqual(JSON.parse(JSON.stringify(load("/.next/server/preview-props.json"))), preview);
    assert.deepEqual(JSON.parse(JSON.stringify(load("/.next/prerender-manifest.json"))), prerender);
    assert.throws(() => load("/.next/unknown.json"), /Unexpected loadManifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging has its own namespaces for every production Worker rate limiter", () => {
  const { unstable_readConfig: readConfig } = require("wrangler");
  const config = path.join(import.meta.dirname, "../apps/web/wrangler.jsonc");
  const production = readConfig({ config }).ratelimits;
  const staging = readConfig({ config, env: "staging" }).ratelimits;
  assert.deepEqual(staging.map(({ name }) => name).toSorted(), production.map(({ name }) => name).toSorted());
  const namespaces = [...production, ...staging].map(({ namespace_id }) => namespace_id);
  assert.equal(new Set(namespaces).size, namespaces.length);
});

test("staging declares and migrates the telemetry quota on its own Worker", () => {
  const { unstable_readConfig: readConfig } = require("wrangler");
  const config = path.join(import.meta.dirname, "../apps/web/wrangler.jsonc");
  const staging = readConfig({ config, env: "staging" });
  const quota = staging.durable_objects.bindings.find(({ name }) => name === "INGEST_QUOTA");
  assert.deepEqual(quota, { name: "INGEST_QUOTA", class_name: "IngestQuota" });
  assert.ok(staging.migrations.some(({ new_sqlite_classes }) => new_sqlite_classes?.includes("IngestQuota")));
});
