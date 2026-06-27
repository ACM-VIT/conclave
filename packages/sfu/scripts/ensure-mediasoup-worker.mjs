import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const findPackageJson = () => {
  const starts = [process.cwd(), scriptDir];
  for (const start of starts) {
    let current = start;
    while (true) {
      const candidate = join(current, "node_modules", "mediasoup", "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
};

const packageJsonPath = findPackageJson();
if (!packageJsonPath) {
  console.error("[SFU] mediasoup is not installed. Run pnpm install first.");
  process.exit(1);
}

const mediasoupDir = dirname(packageJsonPath);
const workerPath = join(
  mediasoupDir,
  "worker",
  "out",
  "Release",
  "mediasoup-worker",
);

if (existsSync(workerPath)) {
  process.exit(0);
}

console.warn("[SFU] mediasoup worker binary missing; running mediasoup postinstall.");

const result = spawnSync(
  process.execPath,
  [join(mediasoupDir, "npm-scripts.mjs"), "postinstall"],
  {
    cwd: mediasoupDir,
    stdio: "inherit",
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
