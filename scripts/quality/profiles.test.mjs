import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveVideoCodecPerformanceLimits,
  resolveVideoProcessCpuLimit,
  resolveVideoQualityReceiverProfiles,
  VIDEO_QUALITY_PROFILES,
} from "./profiles.mjs";

test("receiver profiles default to the primary profile in stable order", () => {
  const profiles = resolveVideoQualityReceiverProfiles(null, {
    receiverCount: 3,
    primaryProfileName: "constrained",
  });

  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["constrained", "constrained", "constrained"],
  );
});

test("receiver profiles preserve an ordered heterogeneous topology", () => {
  const profiles = resolveVideoQualityReceiverProfiles("pristine, poor", {
    receiverCount: 2,
    primaryProfileName: "pristine",
  });

  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["pristine", "poor"],
  );
  assert.equal(profiles[1], VIDEO_QUALITY_PROFILES.poor);
});

test("receiver profiles reject count, primary, empty, and unknown mismatches", () => {
  assert.throws(
    () =>
      resolveVideoQualityReceiverProfiles("pristine", {
        receiverCount: 2,
        primaryProfileName: "pristine",
      }),
    /exactly 2/,
  );
  assert.throws(
    () =>
      resolveVideoQualityReceiverProfiles("poor,pristine", {
        receiverCount: 2,
        primaryProfileName: "pristine",
      }),
    /first receiver profile/,
  );
  assert.throws(
    () =>
      resolveVideoQualityReceiverProfiles("pristine,", {
        receiverCount: 2,
        primaryProfileName: "pristine",
      }),
    /empty profile/,
  );
  assert.throws(
    () =>
      resolveVideoQualityReceiverProfiles("pristine,unknown", {
        receiverCount: 2,
        primaryProfileName: "pristine",
      }),
    /Unknown video quality profile/,
  );
});

test("every receiver profile defines hard loss and bitrate ceilings", () => {
  for (const profile of Object.values(VIDEO_QUALITY_PROFILES)) {
    assert.ok(profile.maximumReceiverPacketLossRatio > 0);
    assert.ok(profile.maximumReceiverVideoBitrateBps > 0);
  }
});

test("every profile defines hard interval codec, CPU, and process ceilings", () => {
  for (const profile of Object.values(VIDEO_QUALITY_PROFILES)) {
    const encode = resolveVideoCodecPerformanceLimits(profile, "encode");
    const decode = resolveVideoCodecPerformanceLimits(profile, "decode");
    assert.ok(encode.maximumMeanMsPerFrame > 0);
    assert.ok(encode.maximumP95MsPerFrame >= encode.maximumMeanMsPerFrame);
    assert.ok(encode.maximumMsPerFrame >= encode.maximumP95MsPerFrame);
    assert.ok(encode.maximumCpuQualityLimitationRatio >= 0);
    assert.ok(decode.maximumMeanMsPerFrame > 0);
    assert.ok(decode.maximumP95MsPerFrame >= decode.maximumMeanMsPerFrame);
    assert.ok(decode.maximumMsPerFrame >= decode.maximumP95MsPerFrame);
    assert.ok(
      resolveVideoProcessCpuLimit(profile, "publisher", {
        receiverCount: 1,
      }) > 0,
    );
    assert.ok(
      resolveVideoProcessCpuLimit(profile, "publisher", {
        receiverCount: 3,
      }) >=
        resolveVideoProcessCpuLimit(profile, "publisher", {
          receiverCount: 1,
        }),
    );
    assert.ok(
      resolveVideoProcessCpuLimit(profile, "primary-visual-receiver") > 0,
    );
    assert.ok(
      resolveVideoProcessCpuLimit(profile, "passive-telemetry-receiver") > 0,
    );
  }
});

test("performance limit resolvers reject ambiguous kinds and topologies", () => {
  const profile = VIDEO_QUALITY_PROFILES.pristine;
  assert.throws(
    () => resolveVideoCodecPerformanceLimits(profile, "transcode"),
    /Unknown codec performance kind/,
  );
  assert.throws(
    () => resolveVideoProcessCpuLimit(profile, "publisher"),
    /receiver count/,
  );
  assert.throws(
    () => resolveVideoProcessCpuLimit(profile, "unknown", { receiverCount: 1 }),
    /Unknown browser process role/,
  );
});
