import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = dirname(dirname(fileURLToPath(
  import.meta.resolve("@sapphi-red/web-noise-suppressor"),
)));
const { version } = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
);

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
