import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = dirname(fileURLToPath(import.meta.resolve("@mediapipe/tasks-vision")));
const { version } = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
const outputRoot = join(webRoot, "public", "mediapipe", "tasks-vision", version);

mkdirSync(outputRoot, { recursive: true });
cpSync(join(packageRoot, "wasm"), join(outputRoot, "wasm"), { recursive: true });
console.log(`Synced Tasks Vision WASM assets to public/mediapipe/tasks-vision/${version}/`);
