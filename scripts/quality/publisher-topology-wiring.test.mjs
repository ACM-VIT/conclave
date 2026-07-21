import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runnerSource = readFileSync(
  new URL("./run-headless-video-quality.mjs", import.meta.url),
  "utf8",
);

test("runner binds native measurement to the post-topology producer", () => {
  assert.match(
    runnerSource,
    /initialProducerId:\s*codecTransition\.finalProducerId/,
  );
  assert.match(
    runnerSource,
    /publisherTopologyReadiness\?\.observed\?\.producerId/,
  );
  assert.match(
    runnerSource,
    /codecTransition\.stableMediaProducerId\s*=\s*expectedProducerId/,
  );
  assert.doesNotMatch(
    runnerSource,
    /Native-compatible VP8 always retains\s+three active simulcast encodings/,
  );
});

test("runner requires configured and active sender topology during stabilization", () => {
  assert.match(runnerSource, /expectedSenderEncodingCount/);
  assert.match(runnerSource, /expectedActiveSenderEncodings/);
  assert.match(
    runnerSource,
    /publisherTopologyReadiness\.expected\.encodings/,
  );
  assert.match(runnerSource, /expectedConsumerTemporalLayer/);
  assert.match(
    runnerSource,
    /codecScenario === "native-compat" && receiverCount > 1 \? 0 : null/,
  );
});

test("runner scores the audited startup consumer generation and visible interruption", () => {
  assert.match(runnerSource, /assessConsumerGenerationReset/);
  assert.match(runnerSource, /consumerGenerationResetVersion/);
  assert.match(runnerSource, /consumerGenerationResets/);
  assert.match(runnerSource, /maximumConsumerGenerationResetInterruptionMs/);
  assert.match(runnerSource, /enforceConsumerGenerationReset:\s*true/);
});

test("runner revalidates final topology and producer identity after measurement", () => {
  assert.match(runnerSource, /finalPublisherTopologyAssessment/);
  assert.match(
    runnerSource,
    /adaptivePublish:\s*publisherDebug\?\.adaptivePublish/,
  );
  assert.match(
    runnerSource,
    /finalPublisherTopologyAssessment\.observed\?\.producerId\s*!==\s*expectedProducerId/,
  );
  assert.match(runnerSource, /measurement\.publisherTopologyTransition/);
});

test("runner uses producer-bound sender stats and retains PC-wide diagnostics", () => {
  assert.match(runnerSource, /summarizePublisherVideoSenderStats/);
  assert.match(runnerSource, /bindPublisherVideoSender/);
  assert.match(runnerSource, /publisherSenderBindingStart\.senderId/);
  assert.match(runnerSource, /pcWideRtcDiagnostics:\s*publisherPcWideRtc/);
});

test("runner binds requested playout policy to the measured consumer generation", () => {
  assert.match(runnerSource, /const receiverPlayoutPolicy = \(debug, binding\)/);
  assert.match(runnerSource, /debug\?\.boundConsumer/);
  assert.match(
    runnerSource,
    /expectedConsumerId:\s*binding\?\.consumerId/,
  );
  assert.match(runnerSource, /expectedProducerId:\s*binding\?\.producerId/);
  assert.match(runnerSource, /observedTargetMs/);
  assert.match(
    runnerSource,
    /measurement\.receiverPlayoutPolicy = primaryReceiver\.playout/,
  );
});

test("runner measures every receiver concurrently and drains evidence in order", () => {
  assert.match(runnerSource, /resolveVideoQualityReceiverProfiles/);
  assert.match(runnerSource, /receiverProfiles:\s*receiverProfileNames/);
  assert.match(runnerSource, /const receiverMediaPathStabilities = await Promise\.all/);
  assert.match(runnerSource, /mode: index === 0 \? "visual" : "telemetry"/);
  assert.match(runnerSource, /startBrowserProcessObserver/);
  const receiverDrainAt = runnerSource.indexOf(
    "const receiverSamplerMeasurements = await Promise.all",
  );
  const codecDrainAt = runnerSource.indexOf(
    "await publisherCodecObserver.stop()",
  );
  const processDrainAt = runnerSource.indexOf(
    "const processObservationWindows = await Promise.all",
  );
  assert.ok(receiverDrainAt >= 0);
  assert.ok(codecDrainAt > receiverDrainAt);
  assert.ok(processDrainAt > codecDrainAt);
  assert.match(runnerSource, /measurement\.receivers = receiverRuns\.map/);
  assert.match(runnerSource, /receiver\.assessment = assessReceiverTelemetry/);
  assert.match(runnerSource, /enforceAllReceiverTelemetry:\s*true/);
  assert.match(runnerSource, /receiverProfiles:\s*receiverProfileNames/);
});
