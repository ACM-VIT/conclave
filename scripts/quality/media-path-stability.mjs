const normalizeMimeType = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const isInboundVideo = (stat) => {
  const kind = String(stat?.kind ?? stat?.mediaType ?? "").toLowerCase();
  return (
    stat?.type === "inbound-rtp" &&
    kind === "video" &&
    stat?.isRemote !== true &&
    stat?.mid !== "probator" &&
    stat?.trackIdentifier !== "probator"
  );
};

export function findInboundVideoEvidence(snapshot, consumerId = null) {
  const candidates = [];
  for (const connection of snapshot?.peerConnections ?? []) {
    const codecs = new Map(
      (connection.stats ?? [])
        .filter((stat) => stat?.type === "codec")
        .map((stat) => [stat.id, stat]),
    );
    for (const stat of connection.stats ?? []) {
      if (!isInboundVideo(stat)) continue;
      if (consumerId && stat.trackIdentifier !== consumerId) continue;
      const codec = stat.codecId ? codecs.get(stat.codecId) : null;
      candidates.push({
        connectionId: connection.id ?? null,
        statId: stat.id ?? null,
        ssrc: stat.ssrc ?? null,
        consumerId: stat.trackIdentifier ?? null,
        framesDecoded:
          Number.isFinite(stat.framesDecoded) ? stat.framesDecoded : 0,
        bytesReceived:
          Number.isFinite(stat.bytesReceived) ? stat.bytesReceived : 0,
        frameWidth: Number.isFinite(stat.frameWidth) ? stat.frameWidth : 0,
        frameHeight: Number.isFinite(stat.frameHeight) ? stat.frameHeight : 0,
        codecMimeType: codec?.mimeType ?? null,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.framesDecoded - left.framesDecoded ||
      right.bytesReceived - left.bytesReceived,
  );
  return candidates[0] ?? null;
}

export function assessStableMediaPath({
  publisher,
  publisherRtc,
  viewer,
  viewerStats,
  expectedProducerId,
  expectedCodecMimeType,
  expectedSenderEncodingCount = null,
  expectedActiveSenderEncodings = null,
  expectedSenderEncodings = null,
  expectedConsumerTemporalLayer = null,
  minimumDecodedHeight,
}) {
  const reasons = [];
  const consumer = (viewer?.consumers ?? []).find(
    (entry) => entry?.producerId === expectedProducerId,
  );
  const inbound = findInboundVideoEvidence(viewerStats, consumer?.consumerId);
  const senderEncodings = Array.isArray(publisher?.encodings)
    ? publisher.encodings
    : [];
  const activeSenderEncodings = senderEncodings.filter(
    (encoding) => encoding?.active === true,
  );
  const expectedCodec = normalizeMimeType(expectedCodecMimeType);
  const publisherCodecs = (publisher?.codecs ?? []).map((codec) =>
    normalizeMimeType(codec?.mimeType ?? codec),
  );
  const expectedScalabilityModes = Array.isArray(expectedSenderEncodings)
    ? new Set(
        expectedSenderEncodings
          .map((encoding) => encoding?.scalabilityMode)
          .filter((mode) => typeof mode === "string"),
      )
    : new Set();
  const currentSpatialLayer = consumer?.currentLayers?.spatialLayer;
  const preferredSpatialLayer = consumer?.preferredLayers?.spatialLayer;

  if (publisher?.producerId !== expectedProducerId || publisher?.closed === true) {
    reasons.push("publisher producer is not the expected live producer");
  }
  if (
    publisherRtc?.binding?.matched !== true ||
    publisherRtc.binding.trackId !== publisher?.trackId
  ) {
    reasons.push("publisher RTP evidence is not bound to the current sender");
  }
  if (!publisherCodecs.includes(expectedCodec)) {
    reasons.push("publisher codec does not match the expected codec");
  }
  if (
    Number.isInteger(expectedSenderEncodingCount) &&
    senderEncodings.length !== expectedSenderEncodingCount
  ) {
    reasons.push("publisher configured sender encoding count is not stable");
  }
  if (
    Number.isInteger(expectedSenderEncodingCount) &&
    publisherRtc?.encodingCount !== expectedSenderEncodingCount
  ) {
    reasons.push("publisher actual sender RTP encoding count is not stable");
  }
  if (
    Number.isInteger(expectedActiveSenderEncodings) &&
    activeSenderEncodings.length !== expectedActiveSenderEncodings
  ) {
    reasons.push("publisher sender encoding count is not stable");
  } else if (activeSenderEncodings.length === 0) {
    reasons.push("publisher has no active sender encoding");
  }
  if (
    Number.isInteger(expectedActiveSenderEncodings) &&
    publisherRtc?.activeEncodingCount !== expectedActiveSenderEncodings
  ) {
    reasons.push("publisher actual active RTP encoding count is not stable");
  }
  for (const encoding of publisherRtc?.encodings ?? []) {
    if (
      encoding.active !== true ||
      encoding.transmitted !== true ||
      !(encoding.bytesSentDelta > 0) ||
      !(encoding.framesEncodedDelta > 0) ||
      normalizeMimeType(encoding.codecMimeType) !== expectedCodec ||
      (expectedScalabilityModes.size > 0 &&
        !expectedScalabilityModes.has(encoding.scalabilityMode))
    ) {
      reasons.push("publisher current sender RTP encoding is not flowing");
    }
  }
  if (Array.isArray(expectedSenderEncodings)) {
    if (senderEncodings.length !== expectedSenderEncodings.length) {
      reasons.push("publisher sender encoding topology does not match");
    }
    for (let index = 0; index < expectedSenderEncodings.length; index += 1) {
      const expectedEncoding = expectedSenderEncodings[index];
      const encoding = senderEncodings[index];
      if (!encoding) continue;
      if (
        (encoding.rid ?? null) !== (expectedEncoding.rid ?? null) ||
        encoding.active !== true ||
        encoding.maxBitrate !== expectedEncoding.maxBitrate ||
        encoding.maxFramerate !== expectedEncoding.maxFramerate ||
        encoding.scalabilityMode !== expectedEncoding.scalabilityMode
      ) {
        reasons.push(
          `publisher sender encoding ${expectedEncoding.rid ?? index} does not match the expected active cap`,
        );
      }
    }
  }
  if (viewer?.connectionState !== "joined") {
    reasons.push("viewer is not joined");
  }
  if (!consumer || consumer.status !== "applied" || consumer.paused === true) {
    reasons.push("final producer consumer is not applied and flowing");
  }
  if (
    Number.isInteger(preferredSpatialLayer) &&
    currentSpatialLayer !== preferredSpatialLayer
  ) {
    reasons.push("consumer has not reached its preferred spatial layer");
  }
  if (
    Number.isInteger(expectedConsumerTemporalLayer) &&
    consumer?.currentLayers?.temporalLayer !== expectedConsumerTemporalLayer
  ) {
    reasons.push(
      `consumer temporal layer is ${consumer?.currentLayers?.temporalLayer ?? "missing"}; expected ${expectedConsumerTemporalLayer}`,
    );
  }
  if (!inbound) {
    reasons.push("final consumer inbound RTP stream is missing");
  } else {
    if (normalizeMimeType(inbound.codecMimeType) !== expectedCodec) {
      reasons.push("inbound RTP codec does not match the expected codec");
    }
    if (inbound.frameHeight < minimumDecodedHeight) {
      reasons.push("inbound RTP stream has not reached target resolution");
    }
  }
  if ((viewer?.renderedVideo?.height ?? 0) < minimumDecodedHeight) {
    reasons.push("rendered video has not reached target resolution");
  }

  const signature =
    reasons.length === 0
      ? [
          expectedProducerId,
          consumer.consumerId,
          inbound.connectionId,
          inbound.statId,
          inbound.ssrc,
          normalizeMimeType(inbound.codecMimeType),
          `${inbound.frameWidth}x${inbound.frameHeight}`,
          `${currentSpatialLayer ?? "none"}/${consumer?.currentLayers?.temporalLayer ?? "none"}`,
          publisherRtc.binding.senderId,
          (publisherRtc.encodings ?? [])
            .map((encoding) => `${encoding.id ?? "unknown"}:${encoding.ssrc ?? "none"}`)
            .sort()
            .join(","),
          senderEncodings
            .map(
              (encoding) =>
                `${encoding.rid ?? "single"}:${encoding.active === true ? "active" : "inactive"}:${encoding.maxBitrate ?? "none"}:${encoding.maxFramerate ?? "none"}:${encoding.scalabilityMode ?? "none"}`,
            )
            .join(","),
        ].join("|")
      : null;

  return {
    passed: reasons.length === 0,
    reasons,
    signature,
    expectedProducerId,
    expectedCodecMimeType,
    publisherTrackId: publisher?.trackId ?? null,
    senderEncodingCount: senderEncodings.length,
    activeSenderEncodingCount: activeSenderEncodings.length,
    senderEncodings,
    publisherSenderBinding: publisherRtc?.binding ?? null,
    publisherRtc: publisherRtc ?? null,
    consumer: consumer ?? null,
    inbound,
    renderedVideo: viewer?.renderedVideo ?? null,
  };
}

export function advanceMediaPathStability(
  previous,
  assessment,
  { now, requiredStableMs, minimumDecodedFrames },
) {
  if (!assessment?.passed || !assessment.signature) {
    return {
      signature: null,
      since: null,
      startFramesDecoded: null,
      stableMs: 0,
      decodedFrames: 0,
      ready: false,
      assessment,
    };
  }

  const framesDecoded = assessment.inbound?.framesDecoded ?? 0;
  const reset =
    previous?.signature !== assessment.signature ||
    !Number.isFinite(previous?.startFramesDecoded) ||
    framesDecoded < previous.startFramesDecoded;
  const since = reset ? now : previous.since;
  const startFramesDecoded = reset ? framesDecoded : previous.startFramesDecoded;
  const stableMs = Math.max(0, now - since);
  const decodedFrames = Math.max(0, framesDecoded - startFramesDecoded);

  return {
    signature: assessment.signature,
    since,
    startFramesDecoded,
    stableMs,
    decodedFrames,
    ready:
      stableMs >= requiredStableMs && decodedFrames >= minimumDecodedFrames,
    assessment,
  };
}
