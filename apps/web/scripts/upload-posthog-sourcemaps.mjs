import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

// Runs after the OpenNext build, on the exact files wrangler deploys:
// PostHog matches a stack frame to its source map by the chunk id that
// `sourcemap inject` writes into each served file.
const assetsDir = path.join(process.cwd(), ".open-next/assets");
const staticDir = path.join(assetsDir, "_next/static");
const uploadRequested = Boolean(
  process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID,
);

const listSourceMaps = async (dir) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const posthogCli = (args) => {
  const result = spawnSync("posthog-cli", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      POSTHOG_CLI_HOST: process.env.POSTHOG_CLI_HOST ?? "https://eu.posthog.com",
    },
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "posthog-cli is not installed. Install it with `npm install -g @posthog/cli` or unset POSTHOG_CLI_API_KEY.",
    );
  }
  if (result.status !== 0) {
    throw new Error(`posthog-cli ${args.join(" ")} exited with ${result.status}`);
  }
};

if (uploadRequested) {
  if ((await listSourceMaps(staticDir)).length === 0) {
    throw new Error("No source maps were built; check productionBrowserSourceMaps in next.config.ts.");
  }
  posthogCli(["sourcemap", "inject", "--directory", staticDir]);
  posthogCli([
    "sourcemap",
    "upload",
    "--directory",
    staticDir,
    "--release-name",
    "conclave-web",
    "--delete-after",
  ]);
}

const leftover = await listSourceMaps(assetsDir);
await Promise.all(leftover.map((file) => rm(file)));
console.log(
  uploadRequested
    ? `[sourcemaps] uploaded to PostHog; removed ${leftover.length} leftover map files`
    : "[sourcemaps] upload skipped (POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID not set)",
);
