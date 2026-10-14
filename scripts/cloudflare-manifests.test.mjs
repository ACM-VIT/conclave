import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
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
    const code = await updates[0].callback({ contents: `
      function loadManifest(path, shouldCache = true) { throw new Error("Filesystem unavailable"); }
      function evalManifest(path, shouldCache = true) { throw new Error("Filesystem unavailable"); }
    ` });
    const load = runInNewContext(`${code}\nloadManifest`);
    assert.deepEqual(JSON.parse(JSON.stringify(load("/.next/server/preview-props.json"))), preview);
    assert.deepEqual(JSON.parse(JSON.stringify(load("/.next/prerender-manifest.json"))), prerender);
    assert.throws(() => load("/.next/unknown.json"), /Unexpected loadManifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
