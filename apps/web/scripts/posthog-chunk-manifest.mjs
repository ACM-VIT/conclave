import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// posthog-cli `sourcemap inject` ends each chunk with this line.
const CHUNK_ID_TRAILER =
  /\/\/# chunkId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;

/** Served at /_next/static/posthog-chunk-ids.json. */
export const CHUNK_MANIFEST_FILE = "posthog-chunk-ids.json";

/**
 * Writes the build's chunk id to file map, `{ "<id>": "/_next/static/<file>" }`,
 * for every chunk posthog-cli injected under `staticDir`. Telemetry keeps a
 * frame's chunk path only when its exact id and file pair is in this map.
 */
export async function writeChunkManifest(staticDir) {
  const entries = await readdir(staticDir, { recursive: true, withFileTypes: true });
  const manifest = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = await readFile(file, "utf8");
    const id = CHUNK_ID_TRAILER.exec(text.slice(-200))?.[1];
    if (id) manifest[id] = `/_next/static/${path.relative(staticDir, file).split(path.sep).join("/")}`;
  }
  await writeFile(path.join(staticDir, CHUNK_MANIFEST_FILE), JSON.stringify(manifest));
  return manifest;
}
