import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";

// Runs after the OpenNext build, on the exact files wrangler deploys:
// PostHog matches a stack frame to its source map by the chunk id that
// `sourcemap inject` writes into each served file.
const assetsDir = path.join(process.cwd(), ".open-next/assets");
const staticDir = path.join(assetsDir, "_next/static");
// The same .env files `next build` read when it decided to build the maps.
nextEnv.loadEnvConfig(process.cwd());
const uploadRequested = Boolean(
  process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID,
);
// Inject and upload together get 90 s. A release's ~70 maps upload in a few
// seconds even on a slow link, so past that the uploader has stalled, and
// wrangler deploy is waiting on cf:build behind it.
const uploadTimeoutMs = Number(process.env.POSTHOG_SOURCEMAPS_TIMEOUT_MS) || 90_000;
const uploadDeadline = Date.now() + uploadTimeoutMs;

const listSourceMaps = async (dir) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const posthogCli = (args) => {
  const result = spawnSync("posthog-cli", args, {
    stdio: "inherit",
    timeout: Math.max(1, uploadDeadline - Date.now()),
    killSignal: "SIGKILL",
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
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(
      `posthog-cli ${args.slice(0, 2).join(" ")} did not finish within ${uploadTimeoutMs / 1000} s and was stopped`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`posthog-cli ${args.join(" ")} exited with ${result.status}`);
  }
};

const upload = async () => {
  if (!uploadRequested) {
    console.log("[sourcemaps] upload skipped (POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID not set)");
    return;
  }
  if ((await listSourceMaps(staticDir)).length === 0) {
    throw new Error("No source maps were built; check productionBrowserSourceMaps in next.config.ts.");
  }
  const release = ["--release-name", "conclave-web"];
  posthogCli(["sourcemap", "inject", "--directory", staticDir, ...release]);
  posthogCli([
    "sourcemap",
    "upload",
    "--directory",
    staticDir,
    ...release,
    "--delete-after",
  ]);
  console.log("[sourcemaps] uploaded to PostHog");
};

try {
  await upload();
} catch (error) {
  // A failed upload only costs this release its readable stack traces, so it
  // warns instead of blocking the deploy.
  console.warn(`[sourcemaps] upload failed; deploying without readable stacks: ${error.message}`);
} finally {
  // Maps never ship: if one cannot be removed, this throws and stops the deploy.
  const leftover = await listSourceMaps(assetsDir);
  await Promise.all(leftover.map((file) => rm(file)));
  if (leftover.length > 0) console.log(`[sourcemaps] removed ${leftover.length} map files from the deploy`);
}
