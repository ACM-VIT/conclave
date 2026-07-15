import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMeasurementContract,
  VIDEO_QUALITY_HARNESS_VERSION,
} from "./measurement-contract.mjs";

test("measurement contract fingerprints every critical harness source", () => {
  const first = buildMeasurementContract();
  const second = buildMeasurementContract();

  assert.equal(first.schemaVersion, VIDEO_QUALITY_HARNESS_VERSION);
  assert.equal(VIDEO_QUALITY_HARNESS_VERSION, 13);
  assert.equal(first.measurementContractId, second.measurementContractId);
  assert.match(first.measurementContractId, /^[a-f0-9]{64}$/);
  assert.ok(Object.keys(first.sourceHashes).length >= 7);
  for (const source of [
    "run-headless-video-quality.mjs",
    "cdp.mjs",
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
    "media-latency.mjs",
    "comparison.mjs",
    "dynamic-network-transition.mjs",
    "dynamic-network-runner.mjs",
    "../../apps/web/src/app/lib/network-information.ts",
    "../../apps/web/src/app/hooks/useConnectionQuality.ts",
  ]) {
    assert.match(first.sourceHashes[source], /^[a-f0-9]{64}$/);
  }
  for (const hash of Object.values(first.sourceHashes)) {
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
});
