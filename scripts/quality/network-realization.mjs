const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const check = (name, status, details) => ({ name, status, ...details });

export function assessNetworkRealization(
  profile,
  measurement,
  { publisherNetworkProfile = profile, requireUdp = false } = {},
) {
  const configured = profile?.network ?? null;
  const protocol =
    measurement?.rtc?.selectedCandidatePairProtocol ??
    measurement?.rtc?.selectedCandidatePair?.protocol ??
    null;
  const protocolIsUdp = String(protocol).toLowerCase() === "udp";
  const protocolChecks = requireUdp
    ? [
        check(
          "transport-protocol",
          protocolIsUdp ? "pass" : "fail",
          { requiredProtocol: "udp", observedProtocol: protocol },
        ),
      ]
    : [];
  if (!configured) {
    return {
      valid: !requireUdp || protocolIsUdp,
      configured: false,
      protocol,
      checks: protocolChecks,
      warnings:
        protocol && protocol !== "udp"
          ? [`reference path selected ${protocol}, not UDP`]
          : [],
    };
  }

  const checks = [...protocolChecks];
  const warnings = [];
  const publisherNetwork = measurement?.publisher?.debug?.network ?? {};
  const observedRttMs = Math.max(
    finite(publisherNetwork.publishRttMs) ?? 0,
    finite(measurement?.rtc?.selectedCandidatePair?.currentRoundTripTimeMs) ??
      0,
  );
  const expectedRttMs = finite(configured.latencyMs) ?? 0;
  if (expectedRttMs > 0) {
    const minimumRealizedRttMs = Math.max(10, expectedRttMs * 0.4);
    checks.push(
      check(
        "latency",
        observedRttMs >= minimumRealizedRttMs ? "pass" : "fail",
        {
          expectedRttMs,
          observedRttMs: round(observedRttMs),
          minimumRealizedRttMs: round(minimumRealizedRttMs),
        },
      ),
    );
  }

  const expectedLossRatio = Math.max(
    0,
    (finite(configured.packetLossPercent) ?? 0) / 100,
  );
  const observedLossRatio = Math.max(
    finite(measurement?.rtc?.packetLossRatio) ?? 0,
    finite(publisherNetwork.publishPacketLoss) ?? 0,
  );
  const packetSampleCount = Math.max(
    0,
    (finite(measurement?.rtc?.packetsReceivedDelta) ?? 0) +
      (finite(measurement?.rtc?.packetsLostDelta) ?? 0),
  );
  if (expectedLossRatio > 0) {
    if (String(protocol).toLowerCase().includes("tcp")) {
      checks.push(
        check("packet-loss", "indeterminate", {
          expectedLossRatio,
          observedLossRatio: round(observedLossRatio, 5),
          packetSampleCount,
          reason: "ICE-TCP can conceal network loss with transport retransmission",
        }),
      );
      warnings.push(
        "configured packet loss cannot be verified on the selected ICE-TCP path",
      );
    } else {
      const probabilityOfZeroObservedLoss =
        packetSampleCount > 0
          ? (1 - expectedLossRatio) ** packetSampleCount
          : 1;
      const minimumUsefulPacketSampleCount = Math.max(
        50,
        Math.ceil(2 / expectedLossRatio),
      );
      const statisticallyObservable =
        packetSampleCount >= minimumUsefulPacketSampleCount &&
        probabilityOfZeroObservedLoss <= 0.1;
      const minimumRealizedLossRatio = expectedLossRatio * 0.2;
      const realized =
        statisticallyObservable &&
        observedLossRatio >= minimumRealizedLossRatio;
      checks.push(
        check(
          "packet-loss",
          statisticallyObservable ? (realized ? "pass" : "fail") : "indeterminate",
          {
          expectedLossRatio,
          observedLossRatio: round(observedLossRatio, 5),
          packetSampleCount,
          minimumUsefulPacketSampleCount,
          minimumRealizedLossRatio: round(minimumRealizedLossRatio, 5),
          probabilityOfZeroObservedLoss: round(
            probabilityOfZeroObservedLoss,
            5,
          ),
          },
        ),
      );
    }
  }

  const publisherConfigured = publisherNetworkProfile?.network ?? null;
  const uploadCeilingBps =
    (finite(publisherConfigured?.uploadKbps) ?? 0) * 1_000;
  const observedPublisherBps = finite(
    measurement?.rtc?.publisherVideoBitrateBps ??
      measurement?.publisher?.rtc?.averageVideoBitrateBps,
  );
  if (uploadCeilingBps > 0) {
    const targetVideoBitrateBps =
      finite(publisherNetworkProfile?.targetVideoBitrateBps) ?? 0;
    const minimumObservablePublisherBps = Math.min(
      uploadCeilingBps * 0.35,
      targetVideoBitrateBps > 0
        ? targetVideoBitrateBps * 0.5
        : uploadCeilingBps * 0.35,
    );
    const ratio =
      observedPublisherBps === null
        ? null
        : observedPublisherBps / uploadCeilingBps;
    const status =
      observedPublisherBps === null ||
      observedPublisherBps < minimumObservablePublisherBps
        ? "indeterminate"
        : ratio !== null && ratio <= 1.15
          ? "pass"
          : "fail";
    checks.push(
      check("upload-ceiling", status, {
        configuredUploadBps: uploadCeilingBps,
        observedPublisherVideoBps: round(observedPublisherBps, 0),
        minimumObservablePublisherBps: round(
          minimumObservablePublisherBps,
          0,
        ),
        ratio: round(ratio),
      }),
    );
    if (status === "indeterminate") {
      warnings.push(
        "publisher traffic was too low to prove that the configured upload ceiling was exercised",
      );
    }
  }

  const failures = checks.filter((entry) => entry.status === "fail");
  const indeterminate = checks.filter(
    (entry) => entry.status === "indeterminate",
  );
  if (indeterminate.length > 0) {
    warnings.push(
      `${indeterminate.length} configured impairment check(s) were indeterminate`,
    );
  }
  return {
    valid: failures.length === 0 && indeterminate.length === 0,
    configured: true,
    configuredEndpoints: {
      publisher: publisherConfigured !== null,
      viewer: configured !== null,
    },
    protocol,
    checks,
    warnings,
  };
}
