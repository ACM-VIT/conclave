import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// posthog-cli `sourcemap inject` ends each chunk with this line.
const CHUNK_ID_TRAILER =
  /\/\/# chunkId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;
// A build's version is the git sha it was built from (next.config.ts).
const BUILD_VERSION = /^[0-9a-f]{7,40}$/;

/** The version the client was built with, as Next recorded it, or null. */
export async function readBuildVersion(nextDir) {
  try {
    const files = JSON.parse(await readFile(path.join(nextDir, "required-server-files.json"), "utf8"));
    const version = files?.config?.env?.NEXT_PUBLIC_CONCLAVE_CLIENT_VERSION;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Writes the build's chunk id to file map, `{ "<id>": "/_next/static/<file>" }`,
 * for every chunk posthog-cli injected under `staticDir`, at
 * posthog-chunk-ids/<version>.json, where the page and /ingest look for the
 * manifest of the build an event came from. Writes nothing, and returns null,
 * for a build whose version is not a git sha.
 */
export async function writeChunkManifest(staticDir, version) {
  if (typeof version !== "string" || !BUILD_VERSION.test(version)) return null;
  const entries = await readdir(staticDir, { recursive: true, withFileTypes: true });
  const manifest = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await readFile(file, "utf8");
    const id = CHUNK_ID_TRAILER.exec(text.slice(-200))?.[1];
    if (id) manifest[id] = `/_next/static/${path.relative(staticDir, file).split(path.sep).join("/")}`;
  }
  await mkdir(path.join(staticDir, "posthog-chunk-ids"), { recursive: true });
  await writeFile(path.join(staticDir, "posthog-chunk-ids", `${version}.json`), JSON.stringify(manifest));
  return manifest;
}
