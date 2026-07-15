export const WEBCAM_CODEC_NEGOTIATION_VERSION = 3 as const;

export type WebcamCodecCapability =
  | "vp8"
  | "h264-cb"
  | "vp9-p0"
  | "vp9-p0-l2t1";

export type ClientMediaCapabilities = {
  webcam?: {
    negotiationVersion?: number;
    receive?: string[];
    send?: string[];
    preferredBaseline?: "vp8" | "h264";
  };
};

export type NormalizedWebcamCodecCapabilities = {
  negotiationVersion: typeof WEBCAM_CODEC_NEGOTIATION_VERSION;
  receive: ReadonlySet<WebcamCodecCapability>;
  send: ReadonlySet<WebcamCodecCapability>;
  preferredBaseline: "vp8" | "h264";
};

export type WebcamCodecPolicy = {
  codec: "vp8" | "h264" | "vp9";
  mimeType: "video/VP8" | "video/H264" | "video/VP9";
  profileId?: 0;
  scalabilityMode?: "L2T1";
  epoch: number;
};

export type WebcamCodecPolicyParticipant = {
  id: string;
  isObserver: boolean;
  capabilities: NormalizedWebcamCodecCapabilities | null;
};

const KNOWN_CAPABILITIES = new Set<WebcamCodecCapability>([
  "vp8",
  "h264-cb",
  "vp9-p0",
  "vp9-p0-l2t1",
]);

const normalizeCapabilityList = (
  value: unknown,
): ReadonlySet<WebcamCodecCapability> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .slice(0, 8)
      .filter(
        (entry): entry is WebcamCodecCapability =>
          typeof entry === "string" &&
          KNOWN_CAPABILITIES.has(entry as WebcamCodecCapability),
      ),
  );
};

export const normalizeClientMediaCapabilities = (
  value: unknown,
): NormalizedWebcamCodecCapabilities | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const webcam = (value as ClientMediaCapabilities).webcam;
  if (!webcam || typeof webcam !== "object" || Array.isArray(webcam)) {
    return null;
  }
  if (webcam.negotiationVersion !== WEBCAM_CODEC_NEGOTIATION_VERSION) {
    return null;
  }
  return {
    negotiationVersion: WEBCAM_CODEC_NEGOTIATION_VERSION,
    receive: normalizeCapabilityList(webcam.receive),
    send: normalizeCapabilityList(webcam.send),
    preferredBaseline:
      webcam.preferredBaseline === "h264" ? "h264" : "vp8",
  };
};

const allCanReceive = (
  participants: readonly WebcamCodecPolicyParticipant[],
  capability: WebcamCodecCapability,
): boolean =>
  participants.every((participant) =>
    participant.capabilities?.receive.has(capability),
  );

const allPublishersCanSend = (
  participants: readonly WebcamCodecPolicyParticipant[],
  capability: WebcamCodecCapability,
): boolean =>
  participants.every(
    (participant) =>
      participant.isObserver || participant.capabilities?.send.has(capability),
  );

export const participantsSupportWebcamCodec = (
  participants: readonly WebcamCodecPolicyParticipant[],
  codec: WebcamCodecPolicy["codec"],
): boolean => {
  if (participants.length === 0) return codec === "vp8";
  if (codec === "vp9") {
    return (
      allCanReceive(participants, "vp9-p0") &&
      allPublishersCanSend(participants, "vp9-p0-l2t1")
    );
  }
  if (codec === "h264") {
    return (
      allCanReceive(participants, "h264-cb") &&
      allPublishersCanSend(participants, "h264-cb")
    );
  }
  return (
    allCanReceive(participants, "vp8") &&
    allPublishersCanSend(participants, "vp8")
  );
};

export const selectRoomWebcamCodec = (
  participants: readonly WebcamCodecPolicyParticipant[],
): WebcamCodecPolicy["codec"] => {
  if (participants.length === 0) return "vp8";

  // VP9 is deliberately fail closed. A missing/legacy declaration, a receiver
  // without profile 0, or a potential publisher without continuous L2T1
  // inter-layer prediction support keeps
  // the entire room on the interoperable baseline.
  if (participantsSupportWebcamCodec(participants, "vp9")) {
    return "vp9";
  }

  // Prefer the common VP8 baseline even when one client reports that H264 is
  // likely hardware accelerated. Conclave's VP8 path carries receiver-selectable
  // simulcast layers; the current H264 sender path is single-layer and can force
  // a constrained participant to decode the full stream. H264 remains the
  // interoperability fallback when VP8 is genuinely unavailable.
  if (participantsSupportWebcamCodec(participants, "vp8")) {
    return "vp8";
  }

  if (participantsSupportWebcamCodec(participants, "h264")) {
    return "h264";
  }

  // Legacy clients predate capability negotiation and historically publish
  // VP8. Never infer VP9 from router support or from another participant.
  return "vp8";
};

export const buildWebcamCodecPolicy = (
  codec: WebcamCodecPolicy["codec"],
  epoch: number,
): WebcamCodecPolicy => {
  if (codec === "vp9") {
    return {
      codec,
      mimeType: "video/VP9",
      profileId: 0,
      scalabilityMode: "L2T1",
      epoch,
    };
  }
  if (codec === "h264") {
    return { codec, mimeType: "video/H264", epoch };
  }
  return { codec, mimeType: "video/VP8", epoch };
};

const normalizedMimeType = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const getProducerMediaCodec = (rtpParameters: unknown): {
  mimeType: string;
  parameters: Record<string, unknown>;
  scalabilityMode: string | null;
} | null => {
  if (!rtpParameters || typeof rtpParameters !== "object") return null;
  const record = rtpParameters as {
    codecs?: unknown;
    encodings?: unknown;
  };
  if (!Array.isArray(record.codecs)) return null;
  const codec = record.codecs.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const mimeType = normalizedMimeType(
      (entry as { mimeType?: unknown }).mimeType,
    );
    return mimeType.startsWith("video/") && mimeType !== "video/rtx";
  }) as { mimeType?: unknown; parameters?: unknown } | undefined;
  if (!codec) return null;
  const firstEncoding: unknown = Array.isArray(record.encodings)
    ? (record.encodings as unknown[])[0]
    : null;
  const scalabilityMode =
    firstEncoding && typeof firstEncoding === "object"
      ? (firstEncoding as { scalabilityMode?: unknown }).scalabilityMode
      : null;
  return {
    mimeType: normalizedMimeType(codec.mimeType),
    parameters:
      codec.parameters &&
      typeof codec.parameters === "object" &&
      !Array.isArray(codec.parameters)
        ? (codec.parameters as Record<string, unknown>)
        : {},
    scalabilityMode:
      typeof scalabilityMode === "string" ? scalabilityMode : null,
  };
};

export const producerMatchesWebcamCodecPolicy = (
  rtpParameters: unknown,
  policy: WebcamCodecPolicy,
): boolean => {
  const codec = getProducerMediaCodec(rtpParameters);
  if (!codec || codec.mimeType !== policy.mimeType.toLowerCase()) return false;
  if (policy.codec === "h264") {
    const profileLevelId = codec.parameters["profile-level-id"];
    const packetizationMode = codec.parameters["packetization-mode"];
    return (
      typeof profileLevelId === "string" &&
      /^42(?:c0|e0)[0-9a-f]{2}$/i.test(profileLevelId) &&
      (packetizationMode === 1 ||
        packetizationMode === "1")
    );
  }
  if (policy.codec !== "vp9") return true;
  const encodings = (rtpParameters as { encodings?: unknown }).encodings;
  if (!Array.isArray(encodings) || encodings.length !== 1) return false;
  const profileId = codec.parameters["profile-id"];
  const isProfileZero =
    profileId === undefined || profileId === 0 || profileId === "0";
  return (
    isProfileZero &&
    codec.scalabilityMode === policy.scalabilityMode
  );
};
