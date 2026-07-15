import assert from "node:assert/strict";
import test from "node:test";
import {
  assessPublisherBandwidth,
  resolvePublisherBandwidthBudget,
} from "./publisher-bandwidth.mjs";

const healthyLayerCounterAuthority = () => ({
  valid: true,
  bytesSent: { reset: false },
  framesEncoded: { reset: false },
});

const healthyAggregateCounterAuthority = () => ({
  valid: true,
  byteCounterResetDetected: false,
  frameCounterResetDetected: false,
  missingStartStatDetected: false,
});

const publisher = ({
  configured = [
    {
      rid: null,
      active: true,
      maxBitrate: 1_650_000,
      maxFramerate: 30,
      scalabilityMode: "L2T1",
    },
  ],
  live = [
    {
      id: "out-1",
      rid: null,
      active: true,
      bitrateBps: 1_600_000,
      codecMimeType: "video/VP9",
      scalabilityMode: "L2T1",
    },
  ],
  aggregateBitrateBps = 1_600_000,
  endConfigured = configured,
  aggregateCounterAuthority = healthyAggregateCounterAuthority(),
} = {}) => ({
  senderBinding: {
    start: {
      matched: true,
      connectionId: "pc-1",
      senderId: "sender-1",
      trackId: "track-1",
      parameters: { encodings: configured },
    },
    end: {
      matched: true,
      connectionId: "pc-1",
      senderId: "sender-1",
      trackId: "track-1",
      parameters: { encodings: endConfigured },
    },
  },
  rtc: {
    averageVideoBitrateBps: aggregateBitrateBps,
    counterAuthority: aggregateCounterAuthority,
    encodings: live.map((encoding) => ({
      ...encoding,
      counterAuthority:
        encoding.counterAuthority ?? healthyLayerCounterAuthority(),
    })),
  },
});

test("publisher budgets are explicit for every supported topology", () => {
  assert.deepEqual(
    resolvePublisherBandwidthBudget({
      codecScenario: "native-compat",
      receiverCount: 1,
    }),
    {
      topology: "vp8-true-single",
      codecMimeType: "video/vp8",
      expectedActiveEncodingCount: 1,
      maximumAggregateBitrateBps: 1_750_000,
      minimumQualityPerMbps: 0.5,
    },
  );
  assert.equal(
    resolvePublisherBandwidthBudget({
      codecScenario: "native-compat",
      receiverCount: 2,
    }).maximumAggregateBitrateBps,
    2_050_000,
  );
  assert.equal(
    resolvePublisherBandwidthBudget({
      codecScenario: "all-modern",
      receiverCount: 4,
    }).minimumQualityPerMbps,
    0.45,
  );
});

test("VP9 aggregate, exact layer cap, and quality density pass authoritatively", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher(),
    codecScenario: "all-modern",
    receiverCount: 2,
    qualityPerMbps: 0.52,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.topology, "vp9-spatial-svc");
  assert.equal(result.layers[0].configuredCapBps, 1_650_000);
  assert.equal(result.layers[0].allowedBitrateBps, 1_737_500);
});

test("VP8 three-layer topology binds every live RID to its configured cap", () => {
  const configured = [
    { rid: "q", active: true, maxBitrate: 80_000, maxFramerate: 30 },
    { rid: "h", active: true, maxBitrate: 220_000, maxFramerate: 30 },
    { rid: "f", active: true, maxBitrate: 1_650_000, maxFramerate: 30 },
  ];
  const live = [
    { rid: "q", active: true, bitrateBps: 80_000, codecMimeType: "video/VP8" },
    { rid: "h", active: true, bitrateBps: 215_000, codecMimeType: "video/VP8" },
    { rid: "f", active: true, bitrateBps: 1_620_000, codecMimeType: "video/VP8" },
  ];
  const result = assessPublisherBandwidth({
    publisher: publisher({
      configured,
      live,
      aggregateBitrateBps: 1_915_000,
    }),
    codecScenario: "native-compat",
    receiverCount: 3,
    qualityPerMbps: 0.44,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.layers.map((layer) => layer.key),
    ["q", "h", "f"],
  );
});

test("missing configured/live layer binding invalidates instead of guessing a cap", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher({
      configured: [
        { rid: "q", active: true, maxBitrate: 80_000 },
        { rid: "h", active: true, maxBitrate: 220_000 },
        { rid: "f", active: true, maxBitrate: 1_650_000 },
      ],
      live: [
        { rid: "q", active: true, bitrateBps: 70_000, codecMimeType: "video/VP8" },
        { rid: "f", active: true, bitrateBps: 1_600_000, codecMimeType: "video/VP8" },
      ],
    }),
    codecScenario: "native-compat",
    receiverCount: 2,
    qualityPerMbps: 0.5,
  });

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /live\/configured layers/);
  assert.match(result.harnessFailures.join("\n"), /coverage is incomplete/);
});

test("configured cap changes during the measurement invalidate authority", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher({
      endConfigured: [
        {
          rid: null,
          active: true,
          maxBitrate: 1_700_000,
          maxFramerate: 30,
          scalabilityMode: "L2T1",
        },
      ],
    }),
    codecScenario: "all-modern",
    receiverCount: 1,
    qualityPerMbps: 0.5,
  });

  assert.equal(result.valid, false);
  assert.match(result.harnessFailures.join("\n"), /cap binding changed/);
});

test("per-layer 1.05 plus 5kbps allowance is a product gate", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher({
      live: [
        {
          id: "out-1",
          rid: null,
          active: true,
          bitrateBps: 1_737_501,
          codecMimeType: "video/VP9",
        },
      ],
      aggregateBitrateBps: 1_700_000,
    }),
    codecScenario: "all-modern",
    receiverCount: 1,
    qualityPerMbps: 0.5,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /configured-cap allowance/);
});

test("aggregate ceiling excess is a product failure", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher({ aggregateBitrateBps: 1_750_001 }),
    codecScenario: "all-modern",
    receiverCount: 1,
    qualityPerMbps: 0.5,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.match(result.productFailures.join("\n"), /aggregate bitrate/);
});

test("topology quality/Mbps floor is a product failure and raw density persists", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher(),
    codecScenario: "all-modern",
    receiverCount: 2,
    qualityPerMbps: 0.4499,
  });

  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.qualityPerMbps, 0.4499);
  assert.match(result.productFailures.join("\n"), /quality\/Mbps/);
});

test("RTP counter reset invalidates bandwidth and quality-density authority", () => {
  const result = assessPublisherBandwidth({
    publisher: publisher({
      aggregateCounterAuthority: {
        valid: false,
        byteCounterResetDetected: true,
        frameCounterResetDetected: false,
        missingStartStatDetected: false,
      },
      live: [
        {
          id: "out-1",
          rid: null,
          active: true,
          bitrateBps: 1_600_000,
          codecMimeType: "video/VP9",
          scalabilityMode: "L2T1",
          counterAuthority: {
            valid: false,
            bytesSent: { reset: true },
            framesEncoded: { reset: false },
          },
        },
      ],
    }),
    codecScenario: "all-modern",
    receiverCount: 2,
    qualityPerMbps: 0.9,
  });

  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.match(result.harnessFailures.join("\n"), /counter authority/);
  assert.equal(result.counterAuthority.byteCounterResetDetected, true);
});
