#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

const fixtureUrl =
  process.env.CONCLAVE_FACE_FIXTURE_URL ??
  "https://commons.wikimedia.org/wiki/Special:Redirect/file/President_Barack_Obama,_2012_portrait_crop.jpg?width=640";
const fixturePath =
  process.env.CONCLAVE_FAKE_VIDEO_SOURCE_IMAGE ??
  join(tmpdir(), "conclave-fixtures", "face-portrait.jpg");

const ensureFixture = async () => {
  if (existsSync(fixturePath) && statSync(fixturePath).size > 16 * 1024) {
    return;
  }

  mkdirSync(dirname(fixturePath), { recursive: true });
  const response = await fetch(fixtureUrl);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download face fixture: HTTP ${response.status} ${response.statusText}`,
    );
  }
  await pipeline(response.body, createWriteStream(fixturePath));
};

await ensureFixture();

const child = spawn(
  process.execPath,
  ["scripts/debug-video-effects-headless.mjs"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONCLAVE_EXPECT_FACE: "1",
      CONCLAVE_FAKE_VIDEO_SOURCE_IMAGE: fixturePath,
      CONCLAVE_HEADLESS_TIMEOUT_MS:
        process.env.CONCLAVE_HEADLESS_TIMEOUT_MS ?? "140000",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
