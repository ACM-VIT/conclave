import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import { readBuildVersion, writeChunkManifest } from "./posthog-chunk-manifest.mjs";
import { sourceMapUploadRequested } from "./posthog-sourcemaps-policy.mjs";
import { groupAlive, signalGroup } from "./process-group.mjs";

// Runs after the OpenNext build, on the exact files wrangler deploys:
// PostHog matches a stack frame to its source map by the chunk id that
// `sourcemap inject` writes into each served file.
const assetsDir = path.join(process.cwd(), ".open-next/assets");
const staticDir = path.join(assetsDir, "_next/static");
// The same .env files `next build` read when it decided to build the maps.
nextEnv.loadEnvConfig(process.cwd());
const uploadRequested = sourceMapUploadRequested(process.env);
// Inject and upload together get 90 s. A release's ~70 maps upload in a few
// seconds even on a slow link, so past that the uploader has stalled, and
// wrangler deploy is waiting on cf:build behind it.
const uploadTimeoutMs = Number(process.env.POSTHOG_SOURCEMAPS_TIMEOUT_MS) || 90_000;
const uploadDeadline = Date.now() + uploadTimeoutMs;
// How long the CLI's process group gets to exit after SIGTERM before SIGKILL.
const stopGraceMs = 2000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ctrl-C (SIGINT) or a stop (SIGTERM) reaches this script, not the uploader in
// its own process group, so it is passed on there. The maps are still removed
// before the script exits with the signal's status.
let interruptedBy = null;
let markInterrupted;
const interruption = new Promise((resolve) => {
  markInterrupted = resolve;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedBy) return;
    interruptedBy = signal;
    console.warn(`[sourcemaps] ${signal}: stopping the upload and removing the maps`);
    markInterrupted(signal);
  });
}

const listSourceMaps = async (dir) => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

// The npm posthog-cli is a node wrapper that runs the native uploader as its
// own child. It runs in a process group of its own, so stopping it stops that
// child too, and nothing of it outlives this step.
const waitForGroupExit = async (groupId, ms) => {
  const deadline = Date.now() + ms;
  while (groupAlive(groupId)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
};

const stopGroup = async (groupId, signal = "SIGTERM") => {
  if (!groupAlive(groupId)) return;
  signalGroup(groupId, signal);
  if (await waitForGroupExit(groupId, stopGraceMs)) return;
  signalGroup(groupId, "SIGKILL");
  if (!(await waitForGroupExit(groupId, stopGraceMs))) {
    throw new Error("posthog-cli did not stop after SIGKILL");
  }
};

const posthogCli = async (args) => {
  if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
  const child = spawn("posthog-cli", args, {
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      POSTHOG_CLI_HOST: process.env.POSTHOG_CLI_HOST ?? "https://eu.posthog.com",
    },
  });
  let timer;
  const outcome = await new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, uploadDeadline - Date.now()));
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (status) => resolve({ status }));
    void interruption.then((signal) => resolve({ interrupted: signal }));
  });
  clearTimeout(timer);
  // Stops a stalled or interrupted upload with the signal that stopped us;
  // after a normal exit it reaps stragglers.
  if (child.pid) await stopGroup(child.pid, outcome.interrupted ?? "SIGTERM");
  if (outcome.interrupted) throw new Error(`interrupted by ${outcome.interrupted}`);
  if (outcome.error?.code === "ENOENT") {
    throw new Error(
      "posthog-cli is not installed. Install it with `npm install -g @posthog/cli` or unset POSTHOG_CLI_API_KEY.",
    );
  }
  if (outcome.error) throw outcome.error;
  if (outcome.timedOut) {
    throw new Error(
      `posthog-cli ${args.slice(0, 2).join(" ")} did not finish within ${uploadTimeoutMs / 1000} s and was stopped`,
    );
  }
  if (outcome.status !== 0) {
    throw new Error(`posthog-cli ${args.join(" ")} exited with ${outcome.status}`);
  }
};

const upload = async () => {
  if (!uploadRequested) {
    console.log(
      "[sourcemaps] upload skipped: it needs CI=true, POSTHOG_SOURCEMAPS_UPLOAD=1, POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID",
    );
    return;
  }
  if ((await listSourceMaps(staticDir)).length === 0) {
    throw new Error("No source maps were built; check productionBrowserSourceMaps in next.config.ts.");
  }
  const release = ["--release-name", "conclave-web"];
  await posthogCli(["sourcemap", "inject", "--directory", staticDir, ...release]);
  const version = await readBuildVersion(path.join(process.cwd(), ".next"));
  const manifest = await writeChunkManifest(staticDir, version);
  console.log(
    manifest
      ? `[sourcemaps] chunk manifest for ${version} lists ${Object.keys(manifest).length} injected chunks`
      : `[sourcemaps] no chunk manifest: build version ${version ?? "unknown"} is not a git sha`,
  );
  await posthogCli([
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
  if (!interruptedBy) {
    console.warn(`[sourcemaps] upload failed; deploying without readable stacks: ${error.message}`);
  }
} finally {
  // Maps never ship: if one cannot be removed, this throws and stops the deploy.
  const leftover = await listSourceMaps(assetsDir);
  await Promise.all(leftover.map((file) => rm(file)));
  if (leftover.length > 0) console.log(`[sourcemaps] removed ${leftover.length} map files from the deploy`);
}
// An interrupted build stops here, with the status a shell gives that signal.
if (interruptedBy) process.exit(interruptedBy === "SIGINT" ? 130 : 143);
