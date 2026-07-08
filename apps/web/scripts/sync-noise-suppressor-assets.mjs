/**
 * Copies the RNNoise wasm binaries + worklet module from
 * @sapphi-red/web-noise-suppressor into public/noise-suppressor/<version>/.
 *
 * The version-suffixed path keeps the immutable Cache-Control in public/_headers
 * safe across package upgrades (new version = new URLs). After bumping the
 * package, run `pnpm sync:noise-suppressor` and update
 * NOISE_SUPPRESSOR_ASSET_VERSION in src/app/lib/noise-cancellation.ts to match.
 */
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = join(
  webRoot,
  "node_modules",
  "@sapphi-red",
  "web-noise-suppressor",
);
const { version } = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
);

// Older version directories are left in place on purpose: their URLs are
// cached as immutable, and in-flight clients may still reference them during
// a deploy. Remove stale ones manually once no deployed HTML points at them.
const outDir = join(webRoot, "public", "noise-suppressor", version);
mkdirSync(outDir, { recursive: true });

const files = [
  ["dist/rnnoise.wasm", "rnnoise.wasm"],
  ["dist/rnnoise_simd.wasm", "rnnoise_simd.wasm"],
  ["dist/rnnoise/workletProcessor.js", "rnnoise-worklet.js"],
];
for (const [from, to] of files) {
  cpSync(join(pkgRoot, from), join(outDir, to));
}

console.log(
  `Synced ${files.length} noise-suppressor assets to public/noise-suppressor/${version}/`,
);
