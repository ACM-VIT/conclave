import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VIDEO_QUALITY_SCORING_VERSION } from "./scoring.mjs";

export const VIDEO_QUALITY_HARNESS_VERSION = 13;
export const VIDEO_QUALITY_FIXTURE_VERSION =
  "meeting-camera-hybrid-photo-v2-rolling-sequence";
export const VIDEO_QUALITY_METRIC_VERSION = "bt709-ms-ssim-5scale-v1";
export const VIDEO_QUALITY_CALIBRATION_VERSION =
  "v9-schema13-dynamic-network-r0-2026-07-14";

const CRITICAL_SOURCES = [
  "browser-fixture.mjs",
  "cdp.mjs",
  "media-latency.mjs",
  "visual-metrics.mjs",
  "scoring.mjs",
  "comparison.mjs",
  "profiles.mjs",
  "run-headless-video-quality.mjs",
  "startup-tracker.mjs",
  "consumer-generation-reset.mjs",
  "codec-negotiation.mjs",
  "receiver-count.mjs",
  "receiver-telemetry.mjs",
  "codec-performance.mjs",
  "process-performance.mjs",
  "epoch-aligned-observer.mjs",
  "publisher-codec-observer.mjs",
  "publisher-bandwidth.mjs",
  "media-path-stability.mjs",
  "rtc-summary.mjs",
  "network-realization.mjs",
  "dynamic-network-transition.mjs",
  "dynamic-network-runner.mjs",
  "../../apps/web/src/app/lib/network-information.ts",
  "../../apps/web/src/app/hooks/useConnectionQuality.ts",
  "../../apps/web/public/effects/backgrounds/office-green-space.webp",
  "../../apps/web/public/effects/backgrounds/dog-office.webp",
  "../../apps/web/public/effects/backgrounds/rainy-cafe.webp",
];

const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export function buildMeasurementContract() {
  const qualityDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceHashes = Object.fromEntries(
    CRITICAL_SOURCES.map((relativePath) => {
      const contents = readFileSync(resolve(qualityDirectory, relativePath));
      return [relativePath, sha256(contents)];
    }),
  );
  const contract = {
    schemaVersion: VIDEO_QUALITY_HARNESS_VERSION,
    fixtureVersion: VIDEO_QUALITY_FIXTURE_VERSION,
    metricVersion: VIDEO_QUALITY_METRIC_VERSION,
    scoringVersion: VIDEO_QUALITY_SCORING_VERSION,
    calibrationVersion: VIDEO_QUALITY_CALIBRATION_VERSION,
    sourceHashes,
  };
  return {
    ...contract,
    measurementContractId: sha256(JSON.stringify(contract)),
  };
}
