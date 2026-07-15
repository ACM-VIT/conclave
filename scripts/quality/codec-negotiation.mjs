import {
  expectedActiveVideoSenderEncodingCount,
  expectedNativeVp8PublisherTopology,
  parseVideoQualityReceiverCount,
} from "./receiver-count.mjs";

const CODEC_SCENARIOS = new Set(["all-modern", "native-compat"]);

const normalizeMimeType = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const parseFmtp = (value) => {
  const entries = new Map();
  for (const part of String(value ?? "").split(";")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim().toLowerCase();
    if (!key) continue;
    entries.set(key, rawValue?.trim().toLowerCase() ?? "");
  }
  return entries;
};

const isMediaVideoCodec = (codec) => {
  const mimeType = normalizeMimeType(codec?.mimeType);
  return (
    mimeType.startsWith("video/") &&
    ![
      "video/rtx",
      "video/red",
      "video/ulpfec",
      "video/flexfec-03",
    ].includes(mimeType)
  );
};

const getLiveVideoSenders = (snapshot) => {
  const senders = [];
  for (const connection of snapshot?.peerConnections ?? []) {
    for (const sender of connection.senders ?? []) {
      if (
        sender?.track?.kind === "video" &&
        sender.track.readyState === "live"
      ) {
        senders.push({
          connectionId: connection.id ?? null,
          ...sender,
        });
      }
    }
  }
  return senders;
};

const getPrimaryCodec = (sender) =>
  (sender?.parameters?.codecs ?? []).find(isMediaVideoCodec) ?? null;

const getSenderEncodings = (sender) =>
  Array.isArray(sender?.parameters?.encodings)
    ? sender.parameters.encodings
    : [];

const getActiveOutboundEncodings = (publisherRtc) =>
  (publisherRtc?.encodings ?? []).filter((encoding) => encoding.active === true);

const hasVp9ProfileZeroFmtp = (value) => {
  const profileId = parseFmtp(value).get("profile-id");
  return profileId === undefined || profileId === "0";
};

const hasVp9ProfileZero = (codec) => {
  if (normalizeMimeType(codec?.mimeType) !== "video/vp9") return false;
  return hasVp9ProfileZeroFmtp(codec?.sdpFmtpLine);
};

const hasActualVp9ProfileZero = (encoding) =>
  normalizeMimeType(encoding?.codecMimeType) === "video/vp9" &&
  hasVp9ProfileZeroFmtp(encoding?.codecFmtpLine);

const addCheck = (checks, failures, name, passed, failure, observed = null) => {
  checks.push({ name, passed, observed });
  if (!passed) failures.push(failure);
};

export function parseCodecScenario(value) {
  const normalized = value == null || value === "" ? "all-modern" : String(value);
  if (!CODEC_SCENARIOS.has(normalized)) {
    throw new RangeError(
      `codec scenario must be one of ${Array.from(CODEC_SCENARIOS).join(", ")}`,
    );
  }
  return normalized;
}

/**
 * Build a pre-document capability override for the active Skip/native contract.
 * It only removes VP9 from video RTP capabilities. No media capture or output
 * API is touched, so the runner's independent synthetic-silence guarantees stay
 * in force.
 */
export function buildCodecCapabilityOverrideScript(scenario) {
  const normalized = parseCodecScenario(scenario);
  if (normalized !== "native-compat") return "";

  return `(() => {
    const state = {
      scenario: "native-compat",
      sender: null,
      receiver: null,
    };
    const describeCodecs = (capabilities) =>
      Array.from(capabilities?.codecs ?? [], (codec) => ({
        mimeType: typeof codec?.mimeType === "string" ? codec.mimeType : null,
        sdpFmtpLine:
          typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
      }));
    const install = (constructorValue, key) => {
      const nativeGetCapabilities = constructorValue?.getCapabilities;
      const record = {
        installed: false,
        videoCalls: 0,
        nativeCodecs: [],
        advertisedCodecs: [],
        vp9Removed: false,
        vp8Present: false,
        h264Removed: false,
        h264Present: false,
      };
      state[key] = record;
      if (typeof nativeGetCapabilities !== "function") return;
      const wrapped = function (kind) {
        const capabilities = nativeGetCapabilities.call(this, kind);
        if (kind !== "video" || !capabilities) return capabilities;
        const nativeCodecs = describeCodecs(capabilities);
        const codecs = Array.from(capabilities.codecs ?? [])
          .filter((codec) => {
            const mimeType = String(codec?.mimeType ?? "")
              .trim()
              .toLowerCase();
            if (mimeType === "video/vp9") return false;
            if (key === "sender" && mimeType === "video/h264") return false;
            return true;
          })
          .map((codec) => ({ ...codec }));
        const filtered = {
          ...capabilities,
          codecs,
          headerExtensions: Array.from(
            capabilities.headerExtensions ?? [],
            (extension) => ({ ...extension }),
          ),
        };
        record.videoCalls += 1;
        record.nativeCodecs = nativeCodecs;
        record.advertisedCodecs = describeCodecs(filtered);
        record.vp9Removed =
          nativeCodecs.some(
            (codec) =>
              String(codec.mimeType ?? "").toLowerCase() === "video/vp9",
          ) &&
          !record.advertisedCodecs.some(
            (codec) =>
              String(codec.mimeType ?? "").toLowerCase() === "video/vp9",
          );
        record.vp8Present = record.advertisedCodecs.some(
          (codec) =>
            String(codec.mimeType ?? "").toLowerCase() === "video/vp8",
        );
        record.h264Present = record.advertisedCodecs.some(
          (codec) =>
            String(codec.mimeType ?? "").toLowerCase() === "video/h264",
        );
        record.h264Removed =
          nativeCodecs.some(
            (codec) =>
              String(codec.mimeType ?? "").toLowerCase() === "video/h264",
          ) && !record.h264Present;
        return filtered;
      };
      try {
        const descriptor = Object.getOwnPropertyDescriptor(
          constructorValue,
          "getCapabilities",
        );
        Object.defineProperty(constructorValue, "getCapabilities", {
          configurable: descriptor?.configurable ?? true,
          enumerable: descriptor?.enumerable ?? false,
          writable: descriptor?.writable ?? true,
          value: wrapped,
        });
        record.installed = constructorValue.getCapabilities === wrapped;
        if (record.installed) constructorValue.getCapabilities("video");
      } catch {}
    };
    globalThis.__conclaveQualityCodecCapabilities = state;
    install(globalThis.RTCRtpSender, "sender");
    install(globalThis.RTCRtpReceiver, "receiver");
  })();`;
}

/**
 * Assess negotiated media from receiver stats, publisher RTP stats, and the
 * publisher's live RTCRtpSender parameters. Missing evidence is a failure.
 */
export function assessCodecNegotiation({
  scenario,
  receiverRtc,
  publisherRtc,
  publisherSnapshot,
  viewerCapabilities = null,
  transition = null,
  receiverCount = 1,
  receiverConsumer = null,
}) {
  const normalized = parseCodecScenario(scenario);
  const failures = [];
  const checks = [];
  const receiverMimeType = normalizeMimeType(receiverRtc?.codecMimeType);
  const liveVideoSenders = getLiveVideoSenders(publisherSnapshot);
  const primarySenderCodec =
    liveVideoSenders.length === 1 ? getPrimaryCodec(liveVideoSenders[0]) : null;
  const senderEncodings =
    liveVideoSenders.length === 1
      ? getSenderEncodings(liveVideoSenders[0])
      : [];
  const activeOutboundEncodings = getActiveOutboundEncodings(publisherRtc);
  const configuredActiveSenderEncodings = senderEncodings.filter(
    (encoding) => encoding?.active !== false,
  );
  const singleActiveOutboundEncoding =
    activeOutboundEncodings.length === 1 ? activeOutboundEncodings[0] : null;
  const boundedReceiverCount = parseVideoQualityReceiverCount(receiverCount);

  addCheck(
    checks,
    failures,
    "single-live-video-sender",
    liveVideoSenders.length === 1,
    `expected exactly one live publisher video sender, observed ${liveVideoSenders.length}`,
    liveVideoSenders.length,
  );
  addCheck(
    checks,
    failures,
    "publisher-current-sender-stats-bound",
    publisherRtc?.binding?.matched === true &&
      liveVideoSenders.length === 1 &&
      publisherRtc.binding.trackId === liveVideoSenders[0]?.track?.id,
    `expected publisher RTP evidence bound to the sole live sender, observed sender=${publisherRtc?.binding?.senderId ?? "missing"} track=${publisherRtc?.binding?.trackId ?? "missing"}`,
    publisherRtc?.binding ?? null,
  );

  if (normalized === "all-modern") {
    addCheck(
      checks,
      failures,
      "receiver-vp9",
      receiverMimeType === "video/vp9",
      `expected receiver codec video/VP9, observed ${receiverRtc?.codecMimeType ?? "missing"}`,
      receiverRtc?.codecMimeType ?? null,
    );
    addCheck(
      checks,
      failures,
      "sender-vp9-profile-zero",
      hasVp9ProfileZero(primarySenderCodec),
      `expected publisher primary codec VP9 profile 0, observed ${primarySenderCodec?.mimeType ?? "missing"}${primarySenderCodec?.sdpFmtpLine ? ` (${primarySenderCodec.sdpFmtpLine})` : ""}`,
      primarySenderCodec,
    );
    addCheck(
      checks,
      failures,
      "sender-l2t1-key",
      senderEncodings.length === 1 &&
        senderEncodings[0]?.scalabilityMode === "L2T1",
      `expected exactly one publisher sender encoding with L2T1, observed ${senderEncodings.length === 0 ? "missing" : senderEncodings.map((encoding) => encoding.scalabilityMode ?? "none").join(", ")}`,
      senderEncodings,
    );
    addCheck(
      checks,
      failures,
      "single-active-vp9-outbound",
      activeOutboundEncodings.length === 1 &&
        activeOutboundEncodings.every(
          (encoding) =>
            normalizeMimeType(encoding.codecMimeType) === "video/vp9",
        ),
      `expected exactly one active VP9 outbound encoding, observed ${activeOutboundEncodings.length} (${activeOutboundEncodings.map((encoding) => encoding.codecMimeType ?? "unknown").join(", ") || "none"})`,
      activeOutboundEncodings,
    );
    addCheck(
      checks,
      failures,
      "active-outbound-vp9-profile-zero",
      hasActualVp9ProfileZero(singleActiveOutboundEncoding),
      `expected the active outbound RTP codec to be VP9 profile 0, observed ${singleActiveOutboundEncoding?.codecMimeType ?? "missing"}${singleActiveOutboundEncoding?.codecFmtpLine ? ` (${singleActiveOutboundEncoding.codecFmtpLine})` : ""}`,
      singleActiveOutboundEncoding,
    );
    addCheck(
      checks,
      failures,
      "active-outbound-l2t1-key",
      singleActiveOutboundEncoding?.scalabilityMode === "L2T1",
      `expected the active outbound RTP encoding to report L2T1, observed ${singleActiveOutboundEncoding?.scalabilityMode ?? "missing"}`,
      singleActiveOutboundEncoding,
    );
    addCheck(
      checks,
      failures,
      "modern-join-producer-stability",
      typeof transition?.initialProducerId === "string" &&
        transition.initialProducerId === transition?.finalProducerId,
      `expected an all-modern join to preserve the publisher producer, observed ${transition?.initialProducerId ?? "missing"} -> ${transition?.finalProducerId ?? "missing"}`,
      transition,
    );
  } else {
    const expectedTopology = expectedNativeVp8PublisherTopology(
      boundedReceiverCount,
    );
    const expectedEncodingCount = expectedActiveVideoSenderEncodingCount({
      codecScenario: normalized,
      receiverCount: boundedReceiverCount,
    });
    for (const key of ["sender", "receiver"]) {
      const capability = viewerCapabilities?.[key];
      addCheck(
        checks,
        failures,
        `viewer-${key}-override-installed`,
        capability?.installed === true &&
          capability?.videoCalls > 0 &&
          capability?.vp9Removed === true &&
          capability?.vp8Present === true &&
          (key === "sender"
            ? capability?.h264Removed === true
            : capability?.h264Present === true),
        `native-compat viewer ${key} capability override was not proven (installed=${String(capability?.installed ?? false)}, calls=${capability?.videoCalls ?? 0}, vp9Removed=${String(capability?.vp9Removed ?? false)}, vp8Present=${String(capability?.vp8Present ?? false)}, h264Removed=${String(capability?.h264Removed ?? false)}, h264Present=${String(capability?.h264Present ?? false)})`,
        capability ?? null,
      );
    }
    addCheck(
      checks,
      failures,
      "receiver-vp8",
      receiverMimeType === "video/vp8",
      `expected native-compatible receiver codec video/VP8, observed ${receiverRtc?.codecMimeType ?? "missing"}`,
      receiverRtc?.codecMimeType ?? null,
    );
    addCheck(
      checks,
      failures,
      "sender-vp8",
      normalizeMimeType(primarySenderCodec?.mimeType) === "video/vp8",
      `expected native-compatible publisher primary codec video/VP8, observed ${primarySenderCodec?.mimeType ?? "missing"}`,
      primarySenderCodec,
    );
    addCheck(
      checks,
      failures,
      "configured-vp8-sender-topology",
      senderEncodings.length === expectedEncodingCount &&
        configuredActiveSenderEncodings.length === expectedEncodingCount &&
        expectedTopology.encodings.every((expectedEncoding, index) => {
          const encoding = senderEncodings[index];
          return (
            encoding?.active === true &&
            (encoding.rid ?? null) === expectedEncoding.rid &&
            encoding.maxBitrate === expectedEncoding.maxBitrate &&
            encoding.maxFramerate === expectedEncoding.maxFramerate &&
            encoding.scalabilityMode === expectedEncoding.scalabilityMode
          );
        }),
      `expected exactly ${expectedEncodingCount} configured active VP8 sender encoding(s) with ${expectedTopology.mode} caps and L1T1, observed ${senderEncodings.length} total and ${configuredActiveSenderEncodings.length} configured active (${senderEncodings.map((encoding) => encoding.scalabilityMode ?? "missing").join(", ") || "no modes"})`,
      { expected: expectedTopology.encodings, actual: senderEncodings },
    );
    addCheck(
      checks,
      failures,
      "actual-vp8-outbound-topology",
      publisherRtc?.encodingCount === expectedEncodingCount &&
        publisherRtc?.activeEncodingCount === expectedEncodingCount &&
        (publisherRtc?.encodings ?? []).length === expectedEncodingCount &&
        activeOutboundEncodings.length === expectedEncodingCount &&
        (publisherRtc?.encodings ?? []).every(
          (encoding) =>
            encoding.active === true &&
            encoding.transmitted === true &&
            Number.isFinite(encoding.bytesSentDelta) &&
            encoding.bytesSentDelta > 0 &&
            Number.isFinite(encoding.framesEncodedDelta) &&
            encoding.framesEncodedDelta > 0 &&
            normalizeMimeType(encoding.codecMimeType) === "video/vp8" &&
            encoding.scalabilityMode === "L1T1",
        ),
      `expected exactly ${expectedEncodingCount} live VP8 L1T1 outbound encoding(s) and no placeholders, observed ${publisherRtc?.encodingCount ?? "missing"} total and ${activeOutboundEncodings.length} active (${(publisherRtc?.encodings ?? []).map((encoding) => encoding.scalabilityMode ?? "missing").join(", ") || "no modes"})`,
      {
        expectedEncodingCount,
        actual: publisherRtc?.encodings ?? [],
      },
    );
    if (boundedReceiverCount > 1) {
      addCheck(
        checks,
        failures,
        "receiver-vp8-temporal-layer-zero",
        receiverConsumer?.currentLayers?.temporalLayer === 0,
        `expected the bound VP8 simulcast consumer to remain on temporal layer 0, observed ${receiverConsumer?.currentLayers?.temporalLayer ?? "missing"}`,
        receiverConsumer?.currentLayers ?? null,
      );
    }
    const initialActive = getActiveOutboundEncodings(transition?.initialPublisherRtc);
    addCheck(
      checks,
      failures,
      "vp9-to-vp8-republish",
      typeof transition?.initialProducerId === "string" &&
        typeof transition?.finalProducerId === "string" &&
        transition.initialProducerId !== transition.finalProducerId &&
        initialActive.length === 1 &&
        initialActive.every(
          (encoding) =>
            normalizeMimeType(encoding.codecMimeType) === "video/vp9",
        ) &&
        Number.isFinite(transition?.durationMs) &&
        transition.durationMs <= 15_000,
      `expected a VP9-to-VP8 producer replacement within 15000ms, observed ${transition?.initialProducerId ?? "missing"} -> ${transition?.finalProducerId ?? "missing"} in ${transition?.durationMs ?? "unknown"}ms with initial ${initialActive.map((encoding) => encoding.codecMimeType ?? "unknown").join(", ") || "no active codec"}`,
      transition,
    );
  }

  return {
    scenario: normalized,
    passed: failures.length === 0,
    expected:
      normalized === "all-modern"
        ? {
            receiverCodec: "video/VP9",
            publisherCodec: "video/VP9; profile-id=0",
            activeOutboundEncodings: 1,
            scalabilityMode: "L2T1",
            transition: "publisher producer remains stable",
          }
        : {
            viewerCapabilities:
              "send VP8; receive VP8 + H264 constrained baseline; no VP9",
            receiverCodec: "video/VP8",
            publisherCodec: "video/VP8",
            receiverCount: boundedReceiverCount,
            senderTopology:
              boundedReceiverCount === 1
                ? "one full-rate VP8 encoding"
                : "three active adaptive VP8 simulcast encodings",
            scalabilityMode: "L1T1 on every configured and outbound encoding",
            receiverTemporalLayer:
              boundedReceiverCount > 1 ? 0 : "not spatially layered",
            activeOutboundEncodings: expectedActiveVideoSenderEncodingCount({
              codecScenario: normalized,
              receiverCount: boundedReceiverCount,
            }),
            transition: "VP9 producer replaced by VP8 within 15000ms",
          },
    observed: {
      receiverCodec: receiverRtc?.codecMimeType ?? null,
      liveVideoSenderCount: liveVideoSenders.length,
      primarySenderCodec,
      senderEncodings,
      activeOutboundEncodings,
      viewerCapabilities,
      transition,
    },
    checks,
    failures,
  };
}
