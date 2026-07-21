export const PUBLISHER_BANDWIDTH_ASSESSMENT_VERSION = 2;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const canonicalEncoding = (encoding) => ({
  rid: encoding?.rid ?? null,
  active: encoding?.active ?? null,
  maxBitrate: finite(encoding?.maxBitrate),
  maxFramerate: finite(encoding?.maxFramerate),
  scalabilityMode:
    typeof encoding?.scalabilityMode === "string"
      ? encoding.scalabilityMode
      : null,
});

const bindingSignature = (binding) =>
  JSON.stringify({
    connectionId: binding?.connectionId ?? null,
    senderId: binding?.senderId ?? null,
    trackId: binding?.trackId ?? null,
    encodings: (binding?.parameters?.encodings ?? []).map(canonicalEncoding),
  });

export function resolvePublisherBandwidthBudget({
  codecScenario,
  receiverCount,
} = {}) {
  if (!Number.isInteger(receiverCount) || receiverCount < 1) return null;
  if (codecScenario === "all-modern") {
    return {
      topology: "vp9-spatial-svc",
      codecMimeType: "video/vp9",
      expectedActiveEncodingCount: 1,
      maximumAggregateBitrateBps: 1_750_000,
      minimumQualityPerMbps: 0.45,
    };
  }
  if (codecScenario === "native-compat" && receiverCount === 1) {
    return {
      topology: "vp8-true-single",
      codecMimeType: "video/vp8",
      expectedActiveEncodingCount: 1,
      maximumAggregateBitrateBps: 1_750_000,
      minimumQualityPerMbps: 0.5,
    };
  }
  if (codecScenario === "native-compat" && receiverCount > 1) {
    return {
      topology: "vp8-three-layer",
      codecMimeType: "video/vp8",
      expectedActiveEncodingCount: 3,
      maximumAggregateBitrateBps: 2_050_000,
      minimumQualityPerMbps: 0.4,
    };
  }
  return null;
}

export function assessPublisherBandwidth({
  publisher,
  codecScenario,
  receiverCount,
  qualityPerMbps,
} = {}) {
  const harnessFailures = [];
  const productFailures = [];
  const budget = resolvePublisherBandwidthBudget({
    codecScenario,
    receiverCount,
  });
  if (!budget) {
    harnessFailures.push("publisher bandwidth topology is missing or unsupported");
  }
  const startBinding = publisher?.senderBinding?.start;
  const endBinding = publisher?.senderBinding?.end;
  const counterAuthority = publisher?.rtc?.counterAuthority;
  if (
    counterAuthority?.valid !== true ||
    counterAuthority?.byteCounterResetDetected === true ||
    counterAuthority?.frameCounterResetDetected === true ||
    counterAuthority?.missingStartStatDetected === true
  ) {
    harnessFailures.push(
      "publisher RTP byte/frame counter authority is missing, reset, or incomplete",
    );
  }
  if (startBinding?.matched !== true || endBinding?.matched !== true) {
    harnessFailures.push("publisher sender cap binding is missing");
  }
  if (bindingSignature(startBinding) !== bindingSignature(endBinding)) {
    harnessFailures.push("publisher sender cap binding changed during measurement");
  }
  const configured = (startBinding?.parameters?.encodings ?? [])
    .map((encoding, index) => ({
      ...canonicalEncoding(encoding),
      index,
    }))
    .filter((encoding) => encoding.active === true);
  const live = (publisher?.rtc?.encodings ?? [])
    .filter((encoding) => encoding?.active === true)
    .map((encoding, index) => ({ ...encoding, index }));
  if (
    !budget ||
    configured.length !== budget.expectedActiveEncodingCount ||
    live.length !== budget.expectedActiveEncodingCount
  ) {
    harnessFailures.push(
      `publisher live/configured layers ${live.length}/${configured.length} do not match the required ${budget?.expectedActiveEncodingCount ?? "unknown"}`,
    );
  }
  const configuredByRid = new Map();
  for (const encoding of configured) {
    const key = encoding.rid ?? (configured.length === 1 ? "single" : null);
    if (!key || configuredByRid.has(key)) {
      harnessFailures.push("configured publisher layers lack unique cap identities");
      continue;
    }
    configuredByRid.set(key, encoding);
  }
  const layers = [];
  const observedKeys = new Set();
  for (const encoding of live) {
    const key = encoding.rid ?? (live.length === 1 ? "single" : null);
    const configuredEncoding = key ? configuredByRid.get(key) : null;
    if (!key || observedKeys.has(key) || !configuredEncoding) {
      harnessFailures.push("live publisher layer is not bound to one configured cap");
      continue;
    }
    observedKeys.add(key);
    const configuredCapBps = finite(configuredEncoding.maxBitrate);
    const observedBitrateBps = finite(encoding.bitrateBps);
    if (
      encoding?.counterAuthority?.valid !== true ||
      encoding?.counterAuthority?.bytesSent?.reset === true ||
      encoding?.counterAuthority?.framesEncoded?.reset === true
    ) {
      harnessFailures.push(
        `publisher layer ${key} counter authority is missing or reset`,
      );
    }
    const allowedBitrateBps =
      configuredCapBps !== null ? configuredCapBps * 1.05 + 5_000 : null;
    if (
      configuredCapBps === null ||
      configuredCapBps <= 0 ||
      observedBitrateBps === null ||
      observedBitrateBps <= 0
    ) {
      harnessFailures.push("publisher layer bitrate/cap evidence is missing");
    } else if (observedBitrateBps > allowedBitrateBps) {
      productFailures.push(
        `publisher layer ${key} bitrate ${Math.round(observedBitrateBps)}bps exceeds configured-cap allowance ${Math.round(allowedBitrateBps)}bps`,
      );
    }
    const codecMimeType = String(encoding.codecMimeType ?? "").toLowerCase();
    if (budget && codecMimeType !== budget.codecMimeType) {
      harnessFailures.push(`publisher layer ${key} codec is missing or mismatched`);
    }
    layers.push({
      key,
      rid: encoding.rid ?? null,
      configuredCapBps,
      allowedBitrateBps: round(allowedBitrateBps, 0),
      observedBitrateBps,
      capUtilizationRatio:
        configuredCapBps && observedBitrateBps
          ? round(observedBitrateBps / configuredCapBps)
          : null,
      codecMimeType: encoding.codecMimeType ?? null,
      scalabilityMode: encoding.scalabilityMode ?? null,
      counterAuthority: encoding.counterAuthority ?? null,
    });
  }
  if (
    observedKeys.size !== configuredByRid.size ||
    observedKeys.size !== live.length
  ) {
    harnessFailures.push("publisher live/configured cap coverage is incomplete");
  }
  const aggregateBitrateBps = finite(publisher?.rtc?.averageVideoBitrateBps);
  if (aggregateBitrateBps === null || aggregateBitrateBps <= 0) {
    harnessFailures.push("publisher aggregate bitrate is missing");
  } else if (
    budget &&
    aggregateBitrateBps > budget.maximumAggregateBitrateBps
  ) {
    productFailures.push(
      `publisher ${budget.topology} aggregate bitrate ${Math.round(aggregateBitrateBps)}bps exceeds ${budget.maximumAggregateBitrateBps}bps`,
    );
  }
  const qualityDensity = finite(qualityPerMbps);
  if (qualityDensity === null) {
    harnessFailures.push("publisher quality/Mbps evidence is missing");
  } else if (budget && qualityDensity < budget.minimumQualityPerMbps) {
    productFailures.push(
      `publisher ${budget.topology} quality/Mbps ${qualityDensity} is below ${budget.minimumQualityPerMbps}`,
    );
  }
  const uniqueHarnessFailures = Array.from(new Set(harnessFailures));
  const uniqueProductFailures = Array.from(new Set(productFailures));
  return {
    version: PUBLISHER_BANDWIDTH_ASSESSMENT_VERSION,
    valid: uniqueHarnessFailures.length === 0,
    passed:
      uniqueHarnessFailures.length === 0 && uniqueProductFailures.length === 0,
    harnessFailures: uniqueHarnessFailures,
    productFailures: uniqueProductFailures,
    failures: [...uniqueHarnessFailures, ...uniqueProductFailures],
    budget,
    topology: budget?.topology ?? null,
    aggregateBitrateBps,
    aggregateBudgetUtilizationRatio:
      aggregateBitrateBps !== null && budget
        ? round(aggregateBitrateBps / budget.maximumAggregateBitrateBps)
        : null,
    qualityPerMbps: qualityDensity,
    counterAuthority: counterAuthority ?? null,
    layers,
    binding: {
      start: startBinding ?? null,
      end: endBinding ?? null,
      stable:
        startBinding?.matched === true &&
        endBinding?.matched === true &&
        bindingSignature(startBinding) === bindingSignature(endBinding),
    },
  };
}
