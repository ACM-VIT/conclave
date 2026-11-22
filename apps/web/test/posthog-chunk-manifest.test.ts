import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBuildVersion, writeChunkManifest } from "../scripts/posthog-chunk-manifest.mjs";
import { parseChunkManifest } from "../src/app/lib/telemetry-privacy";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Chunks the real posthog-cli injected (round 5's fixture), and one it did not.
it("maps each chunk id posthog-cli injected to its file, and nothing else", async () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), "next-static-"));
  dirs.push(staticDir);
  cpSync(path.join(import.meta.dirname, "fixtures/posthog-chunks"), staticDir, { recursive: true });

  const version = "0b2d3b480f4621392a4151d750c90965b7c8b76c";
  await writeChunkManifest(staticDir, version);

  const written = JSON.parse(readFileSync(path.join(staticDir, `posthog-chunk-ids/${version}.json`), "utf8"));
  expect(written).toEqual({
    "84787b9c-ab15-5b15-90a5-08bc789d96e0": "/_next/static/chunks/app1.js",
    "c304faa4-4e32-54fe-8740-db63d2d9f56f": "/_next/static/chunks/app2.js",
    "147fc2df-e663-5d76-aa13-f67e1e894071": "/_next/static/chunks/app3.js",
  });
  expect([...parseChunkManifest(written)]).toHaveLength(3);
});

it("reads no manifest that is not ids to build chunk files", () => {
  expect([...parseChunkManifest({ "not-a-uuid": "/_next/static/chunks/a.js" })]).toEqual([]);
  expect([...parseChunkManifest({ "147fc2df-e663-5d76-aa13-f67e1e894071": "https://cdn.example.net/a.js" })]).toEqual([]);
  expect([...parseChunkManifest(["/_next/static/chunks/a.js"])]).toEqual([]);
});

it("names the manifest after the build, and writes none for a build without a git version", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "next-build-"));
  dirs.push(root);
  const nextDir = path.join(root, ".next");
  mkdirSync(path.join(nextDir, "static"), { recursive: true });
  writeFileSync(
    path.join(nextDir, "required-server-files.json"),
    JSON.stringify({ config: { env: { NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION: "1a2b3c4d5e6f" } } }),
  );

  expect(await readBuildVersion(nextDir)).toBe("1a2b3c4d5e6f");
  expect(await writeChunkManifest(path.join(nextDir, "static"), "local")).toBeNull();
  expect(existsSync(path.join(nextDir, "static/posthog-chunk-ids"))).toBe(false);
});
