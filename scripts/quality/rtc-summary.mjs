const finite = (value, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const counterDelta = (current, previous, { required = false } = {}) => {
  const currentValue = finite(current, null);
  const previousValue = finite(previous, null);
  if (currentValue === null || previousValue === null) {
    return {
      value: null,
      valid: !required && currentValue === null && previousValue === null,
      missing: true,
      reset: false,
    };
  }
  if (currentValue < 0 || previousValue < 0 || currentValue < previousValue) {
    return { value: null, valid: false, missing: false, reset: true };
  }
  return {
    value: currentValue - previousValue,
    valid: true,
    missing: false,
    reset: false,
  };
};

const indexSnapshot = (snapshot) => {
  const index = new Map();
  for (const connection of snapshot?.peerConnections ?? []) {
    for (const stat of connection.stats ?? []) {
      index.set(`${connection.id}:${stat.id}`, stat);
    }
  }
  return index;
};

const findVideoSenderCandidates = (
  snapshot,
  {
    trackId = null,
    senderId = null,
    expectedEncodings = null,
    allowTrackReplacement = false,
  } = {},
) => {
  const candidates = [];
  for (const connection of snapshot?.peerConnections ?? []) {
    for (const sender of connection.senders ?? []) {
      if (sender?.track?.kind !== "video") continue;
      if (trackId && !allowTrackReplacement && sender.track.id !== trackId) {
        continue;
      }
      if (senderId && sender.id !== senderId) continue;
      if (
        Array.isArray(expectedEncodings) &&
        !senderEncodingsMatch(sender?.parameters?.encodings, expectedEncodings)
      ) {
        continue;
      }
      candidates.push({ connection, sender });
    }
  }
  return candidates;
};

const senderEncodingsMatch = (actualValue, expected) => {
  const actual = Array.isArray(actualValue) ? actualValue : [];
  return (
    actual.length === expected.length &&
    expected.every((expectedEncoding, index) => {
      const encoding = actual[index];
      return (
        (encoding?.rid ?? null) === (expectedEncoding?.rid ?? null) &&
        encoding?.active === true &&
        encoding?.maxBitrate === expectedEncoding?.maxBitrate &&
        encoding?.maxFramerate === expectedEncoding?.maxFramerate &&
        (typeof expectedEncoding?.scalabilityMode !== "string" ||
          encoding?.scalabilityMode === expectedEncoding.scalabilityMode)
      );
    })
  );
};

export function bindPublisherVideoSender(
  snapshot,
  {
    trackId,
    senderId = null,
    expectedEncodings = null,
    allowTrackReplacement = false,
  } = {},
) {
  const reasons = [];
  if (
    !allowTrackReplacement &&
    (typeof trackId !== "string" || trackId.length === 0)
  ) {
    reasons.push("current producer track id is missing");
  }
  if (
    allowTrackReplacement &&
    (typeof senderId !== "string" || senderId.length === 0)
  ) {
    reasons.push("fixed publisher sender id is missing");
  }
  const trackCandidates = findVideoSenderCandidates(snapshot, {
    trackId,
    senderId,
    allowTrackReplacement,
  });
  const candidates = findVideoSenderCandidates(snapshot, {
    trackId,
    senderId,
    expectedEncodings,
    allowTrackReplacement,
  });
  if (
    Array.isArray(expectedEncodings) &&
    trackCandidates.length > 0 &&
    candidates.length === 0
  ) {
    reasons.push("no current producer sender matches the configured topology");
  }
  if (candidates.length !== 1) {
    reasons.push(
      `expected exactly one sender for the current producer track, observed ${candidates.length}`,
    );
  }
  const selected = candidates.length === 1 ? candidates[0] : null;
  if (typeof selected?.sender?.id !== "string" || selected.sender.id.length === 0) {
    reasons.push("current producer sender id is missing");
  }
  if (selected?.sender?.track?.readyState !== "live") {
    reasons.push("current producer sender track is not live");
  }
  if (selected?.sender?.statsError) {
    reasons.push(
      `current producer sender stats failed: ${selected.sender.statsError}`,
    );
  }
  return {
    matched: reasons.length === 0,
    reasons,
    candidateCount: candidates.length,
    trackCandidateCount: trackCandidates.length,
    connectionId: selected?.connection?.id ?? null,
    senderId: selected?.sender?.id ?? null,
    trackId: selected?.sender?.track?.id ?? null,
    parameters: selected?.sender?.parameters ?? null,
  };
}

export function summarizePublisherVideoSenderStats(
  startSnapshot,
  endSnapshot,
  durationMs,
  {
    trackId,
    senderId = null,
    expectedEncodings = null,
    allowTrackReplacement = false,
  } = {},
) {
  const binding = bindPublisherVideoSender(endSnapshot, {
    trackId,
    senderId,
    expectedEncodings,
    allowTrackReplacement,
  });
  if (!binding.matched) {
    return {
      ...summarizePublisherVideoStats(null, { peerConnections: [] }, durationMs),
      binding,
    };
  }

  const [{ connection: endConnection, sender: endSender }] =
    findVideoSenderCandidates(endSnapshot, {
      trackId: binding.trackId,
      senderId: binding.senderId,
      expectedEncodings,
      allowTrackReplacement,
    });
  const startCandidate = findVideoSenderCandidates(startSnapshot, {
    trackId: allowTrackReplacement ? trackId : binding.trackId,
    senderId: binding.senderId,
    expectedEncodings,
    allowTrackReplacement,
  }).find(({ connection }) => connection.id === endConnection.id);
  const connectionId = `${endConnection.id}:${endSender.id}`;
  const summary = summarizePublisherVideoStats(
    {
      peerConnections: [
        {
          id: connectionId,
          stats: startCandidate?.sender?.stats ?? [],
        },
      ],
    },
    {
      peerConnections: [
        {
          id: connectionId,
          stats: endSender.stats ?? [],
        },
      ],
    },
    durationMs,
  );
  return {
    ...summary,
    binding,
    sender: {
      id: endSender.id,
      connectionId: endConnection.id,
      track: endSender.track ?? null,
      parameters: endSender.parameters ?? null,
      parametersError: endSender.parametersError ?? null,
      statsError: endSender.statsError ?? null,
    },
  };
}

export function summarizePublisherVideoStats(
  startSnapshot,
  endSnapshot,
  durationMs,
) {
  const start = indexSnapshot(startSnapshot);
  const durationSeconds = Math.max(0.001, durationMs / 1000);
  const encodings = [];

  for (const connection of endSnapshot?.peerConnections ?? []) {
    const codecs = new Map(
      (connection.stats ?? [])
        .filter((stat) => stat.type === "codec")
        .map((stat) => [stat.id, stat]),
    );
    for (const stat of connection.stats ?? []) {
      const kind = String(stat.kind ?? stat.mediaType ?? "").toLowerCase();
      if (stat.type !== "outbound-rtp" || kind !== "video" || stat.isRemote) {
        continue;
      }
      if (stat.mid === "probator" || stat.trackIdentifier === "probator") {
        continue;
      }
      const previous = start.get(`${connection.id}:${stat.id}`) ?? null;
      const bytes = counterDelta(stat.bytesSent, previous?.bytesSent, {
        required: true,
      });
      const frames = counterDelta(
        stat.framesEncoded,
        previous?.framesEncoded,
        { required: true },
      );
      const qp = counterDelta(stat.qpSum, previous?.qpSum);
      const retransmittedBytes = counterDelta(
        stat.retransmittedBytesSent,
        previous?.retransmittedBytesSent,
      );
      const nack = counterDelta(stat.nackCount, previous?.nackCount);
      const pli = counterDelta(stat.pliCount, previous?.pliCount);
      const fir = counterDelta(stat.firCount, previous?.firCount);
      const bytesSentDelta = bytes.value;
      const framesEncodedDelta = frames.value;
      const qpSumDelta = qp.value;
      const codec = stat.codecId ? codecs.get(stat.codecId) : null;
      const transmitted =
        bytes.valid &&
        frames.valid &&
        ((bytesSentDelta ?? 0) > 0 || (framesEncodedDelta ?? 0) > 0);
      encodings.push({
        id: stat.id,
        ssrc: stat.ssrc ?? null,
        rid: stat.rid ?? null,
        // Chromium may retain zero-byte RTP placeholders marked `active`, or
        // send an occasional maintenance frame after an encoding is disabled.
        // Count an encoding as live only when both configured active and
        // transmitting; aggregate bandwidth below still counts every byte.
        active:
          (typeof stat.active === "boolean" ? stat.active : true) &&
          transmitted,
        transmitted,
        bytesSentDelta,
        bitrateBps:
          bytesSentDelta === null
            ? null
            : round((bytesSentDelta * 8) / durationSeconds, 0),
        framesEncodedDelta,
        framesPerSecond: finite(stat.framesPerSecond, null),
        frameWidth: finite(stat.frameWidth, null),
        frameHeight: finite(stat.frameHeight, null),
        averageQp:
          framesEncodedDelta > 0 && qpSumDelta !== null
            ? round(qpSumDelta / framesEncodedDelta)
            : null,
        retransmittedBytesSentDelta: retransmittedBytes.value,
        nackCountDelta: nack.value,
        pliCountDelta: pli.value,
        firCountDelta: fir.value,
        counterAuthority: {
          valid: bytes.valid && frames.valid,
          startStatPresent: previous !== null,
          bytesSent: bytes,
          framesEncoded: frames,
          qpSum: qp,
          retransmittedBytesSent: retransmittedBytes,
          nackCount: nack,
          pliCount: pli,
          firCount: fir,
        },
        qualityLimitationReason: stat.qualityLimitationReason ?? null,
        encoderImplementation: stat.encoderImplementation ?? null,
        powerEfficientEncoder:
          typeof stat.powerEfficientEncoder === "boolean"
            ? stat.powerEfficientEncoder
            : null,
        scalabilityMode:
          typeof stat.scalabilityMode === "string" ? stat.scalabilityMode : null,
        codecMimeType: codec?.mimeType ?? null,
        codecFmtpLine:
          typeof codec?.sdpFmtpLine === "string" ? codec.sdpFmtpLine : null,
      });
    }
  }

  const activeEncodings = encodings.filter((encoding) => encoding.active);
  const counterEvidenceValid =
    encodings.length > 0 &&
    encodings.every((encoding) => encoding.counterAuthority.valid === true);
  const byteCounterResetDetected = encodings.some(
    (encoding) => encoding.counterAuthority.bytesSent.reset === true,
  );
  const frameCounterResetDetected = encodings.some(
    (encoding) => encoding.counterAuthority.framesEncoded.reset === true,
  );
  const bytesSentDelta = counterEvidenceValid
    ? encodings.reduce((sum, encoding) => sum + encoding.bytesSentDelta, 0)
    : null;
  const retransmittedValues = encodings.map(
    (encoding) => encoding.retransmittedBytesSentDelta,
  );
  const retransmittedBytesSentDelta = retransmittedValues.every(
    (value) => value !== null,
  )
    ? retransmittedValues.reduce((sum, value) => sum + value, 0)
    : null;
  return {
    bytesSentDelta,
    averageVideoBitrateBps:
      bytesSentDelta === null
        ? null
        : round((bytesSentDelta * 8) / durationSeconds, 0),
    retransmittedBytesSentDelta,
    retransmissionRatio:
      bytesSentDelta > 0 && retransmittedBytesSentDelta !== null
        ? round(retransmittedBytesSentDelta / bytesSentDelta, 5)
        : bytesSentDelta === 0 && retransmittedBytesSentDelta === 0
          ? 0
          : null,
    durationMs,
    counterAuthority: {
      valid: counterEvidenceValid,
      byteCounterResetDetected,
      frameCounterResetDetected,
      missingStartStatDetected: encodings.some(
        (encoding) => encoding.counterAuthority.startStatPresent !== true,
      ),
    },
    activeEncodingCount: activeEncodings.length,
    encodingCount: encodings.length,
    encodings,
  };
}
