import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SFU = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(SFU, "server/analytics/source-manifest.json");
const LEFT_OUT = new Set(["node_modules", "test", "scripts", "data", ".turbo", "dist"]);
const SOURCE = /\.(?:ts|js|mjs|cjs)$/;

const shippedSources = (root = SFU) => {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!LEFT_OUT.has(entry.name) && !entry.name.startsWith(".")) walk(child);
      } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(child);
      }
    }
  };
  walk("");
  return found.sort();
};

const text = `${JSON.stringify(shippedSources(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(MANIFEST, "utf8");
  } catch {}
  if (current !== text) {
    console.error("packages/sfu/server/analytics/source-manifest.json is out of date: run node packages/sfu/scripts/gen-source-manifest.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(MANIFEST, text);
}
