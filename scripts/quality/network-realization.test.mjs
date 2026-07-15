import assert from "node:assert/strict";
import test from "node:test";
import { assessNetworkRealization } from "./network-realization.mjs";
import { getVideoQualityProfile } from "./profiles.mjs";

test("unthrottled references remain valid while surfacing TCP", () => {
  const result = assessNetworkRealization(getVideoQualityProfile("pristine"), {
    rtc: { selectedCandidatePairProtocol: "tcp" },
  });
  assert.equal(result.valid, true);
  assert.match(result.warnings[0], /tcp/i);
});

test("UDP-strict references reject an ICE-TCP path", () => {
  const result = assessNetworkRealization(
    getVideoQualityProfile("pristine"),
    { rtc: { selectedCandidatePairProtocol: "tcp" } },
    { requireUdp: true },
  );
  assert.equal(result.valid, false);
  assert.equal(result.checks[0]?.name, "transport-protocol");
  assert.equal(result.checks[0]?.status, "fail");
});

test("UDP-strict references accept a real UDP path", () => {
  const result = assessNetworkRealization(
    getVideoQualityProfile("pristine"),
    { rtc: { selectedCandidatePairProtocol: "udp" } },
    { requireUdp: true },
  );
  assert.equal(result.valid, true);
  assert.equal(result.checks[0]?.status, "pass");
});

test("rejects a named latency profile that remains loopback-fast", () => {
  const result = assessNetworkRealization(
    getVideoQualityProfile("constrained"),
    {
      rtc: {
        selectedCandidatePairProtocol: "tcp",
        packetLossRatio: 0,
        packetsReceivedDelta: 400,
        packetsLostDelta: 0,
        publisherVideoBitrateBps: 500_000,
        selectedCandidatePair: { currentRoundTripTimeMs: 1 },
      },
      publisher: { debug: { network: { publishRttMs: 1 } } },
    },
  );
  assert.equal(result.valid, false);
  assert.equal(
    result.checks.find((entry) => entry.name === "latency")?.status,
    "fail",
  );
  assert.equal(
    result.checks.find((entry) => entry.name === "packet-loss")?.status,
    "indeterminate",
  );
});

test("accepts observable UDP latency, loss, and upload ceiling", () => {
  const result = assessNetworkRealization(getVideoQualityProfile("poor"), {
    rtc: {
      selectedCandidatePairProtocol: "udp",
      packetLossRatio: 0.022,
      packetsReceivedDelta: 500,
      packetsLostDelta: 11,
      publisherVideoBitrateBps: 360_000,
      selectedCandidatePair: { currentRoundTripTimeMs: 230 },
    },
    publisher: { debug: { network: { publishRttMs: 230 } } },
  });
  assert.equal(result.valid, true);
  assert.ok(result.checks.every((entry) => entry.status === "pass"));
});

test("asymmetric viewer impairment does not invent a publisher upload ceiling", () => {
  const result = assessNetworkRealization(
    getVideoQualityProfile("poor"),
    {
      rtc: {
        selectedCandidatePairProtocol: "udp",
        packetLossRatio: 0.022,
        packetsReceivedDelta: 500,
        packetsLostDelta: 11,
        publisherVideoBitrateBps: 1_700_000,
        selectedCandidatePair: { currentRoundTripTimeMs: 230 },
      },
      publisher: { debug: { network: { publishRttMs: 1 } } },
    },
    { publisherNetworkProfile: getVideoQualityProfile("pristine") },
  );

  assert.equal(result.valid, true);
  assert.equal(
    result.checks.some((entry) => entry.name === "upload-ceiling"),
    false,
  );
  assert.deepEqual(result.configuredEndpoints, {
    publisher: false,
    viewer: true,
  });
});

test("rejects a token unrelated UDP loss event as proof of the named impairment", () => {
  const result = assessNetworkRealization(getVideoQualityProfile("poor"), {
    rtc: {
      selectedCandidatePairProtocol: "udp",
      packetLossRatio: 0.001,
      packetsReceivedDelta: 999,
      packetsLostDelta: 1,
      publisherVideoBitrateBps: 300_000,
      selectedCandidatePair: { currentRoundTripTimeMs: 280 },
    },
    publisher: { debug: { network: { publishRttMs: 280 } } },
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.checks.find((entry) => entry.name === "packet-loss")?.status,
    "fail",
  );
});

test("marks too few packets and missing publisher bitrate indeterminate", () => {
  const result = assessNetworkRealization(getVideoQualityProfile("poor"), {
    rtc: {
      selectedCandidatePairProtocol: "udp",
      packetLossRatio: 0.05,
      packetsReceivedDelta: 18,
      packetsLostDelta: 1,
      selectedCandidatePair: { currentRoundTripTimeMs: 280 },
    },
    publisher: { debug: { network: { publishRttMs: 280 } } },
  });

  assert.equal(result.valid, false);
  assert.equal(
    result.checks.find((entry) => entry.name === "packet-loss")?.status,
    "indeterminate",
  );
  assert.equal(
    result.checks.find((entry) => entry.name === "upload-ceiling")?.status,
    "indeterminate",
  );
});
