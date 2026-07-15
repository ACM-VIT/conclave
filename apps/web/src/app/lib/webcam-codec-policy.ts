import type {
  ClientMediaCapabilities,
  WebcamCodecCapability,
  WebcamCodecPolicy,
} from "./types";

type BrowserCodecCapability = {
  mimeType?: string;
  sdpFmtpLine?: string;
  parameters?: Record<string, unknown>;
};

type BrowserRtpCapabilities = {
  codecs?: readonly BrowserCodecCapability[];
} | null;

type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

export type Vp9EncoderCapabilityScope = {
  handlerName: string;
  videoInputDeviceId?: string | null;
};

export type Vp9EncoderNegativeCapabilityCache = {
  has: (scope: Vp9EncoderCapabilityScope) => boolean;
  mark: (scope: Vp9EncoderCapabilityScope) => void;
};

export type Vp9CodecFailureClassification =
  | "proven-encoder-incompatibility"
  | "proven-zero-frame-stall"
  | "transient-or-unknown";

export type ProvenVp9ZeroFrameStall = {
  kind: "vp9-zero-frame-stall";
  epoch: number;
  initialProducerId: string;
  freshTrackId: string;
  reproducerProducerId: string;
};

export type Vp9ZeroFrameProof = Omit<
  ProvenVp9ZeroFrameStall,
  "kind" | "reproducerProducerId"
> & {
  reproducerProducerId: string | null;
};

export type WebcamCodecRecoveryOverride<TCodec> = {
  policyEpoch: number;
  codec: TCodec;
  forceSingleLayer: boolean;
  forceSimulcast?: boolean;
};

const VP9_NEGATIVE_CAPABILITY_STORAGE_KEY =
  "conclave:webcam-vp9-negative:v3";

const normalizeCapabilityScopePart = (
  value: string | null | undefined,
  fallback: string,
): string => {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || fallback;
};

export const getVp9EncoderCapabilityScopeKey = (
  scope: Vp9EncoderCapabilityScope,
): string =>
  `${normalizeCapabilityScopePart(scope.handlerName, "unknown-handler")}:${normalizeCapabilityScopePart(scope.videoInputDeviceId, "default-device")}`;

export const createVp9EncoderNegativeCapabilityCache = (
  storage: SessionStorageLike | null = null,
): Vp9EncoderNegativeCapabilityCache => {
  const memory = new Set<string>();

  const readStoredKeys = (): Set<string> => {
    if (!storage) return new Set();
    try {
      const parsed: unknown = JSON.parse(
        storage.getItem(VP9_NEGATIVE_CAPABILITY_STORAGE_KEY) ?? "[]",
      );
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed.filter((value): value is string => typeof value === "string"),
      );
    } catch {
      return new Set();
    }
  };

  return {
    has(scope) {
      const key = getVp9EncoderCapabilityScopeKey(scope);
      return memory.has(key) || readStoredKeys().has(key);
    },
    mark(scope) {
      const key = getVp9EncoderCapabilityScopeKey(scope);
      memory.add(key);
      if (!storage) return;
      try {
        const stored = readStoredKeys();
        stored.add(key);
        storage.setItem(
          VP9_NEGATIVE_CAPABILITY_STORAGE_KEY,
          JSON.stringify(Array.from(stored).sort()),
        );
      } catch {
        // The in-memory entry still makes reconnects conservative when storage
        // is disabled, full, or blocked by the browser.
      }
    },
  };
};

let defaultVp9EncoderNegativeCapabilityCache:
  | Vp9EncoderNegativeCapabilityCache
  | undefined;

const getDefaultVp9EncoderNegativeCapabilityCache = () => {
  if (!defaultVp9EncoderNegativeCapabilityCache) {
    let storage: SessionStorageLike | null = null;
    try {
      storage = typeof window === "undefined" ? null : window.sessionStorage;
    } catch {}
    defaultVp9EncoderNegativeCapabilityCache =
      createVp9EncoderNegativeCapabilityCache(storage);
  }
  return defaultVp9EncoderNegativeCapabilityCache;
};

export const hasProvenVp9EncoderIncompatibility = (
  scope: Vp9EncoderCapabilityScope,
  cache = getDefaultVp9EncoderNegativeCapabilityCache(),
): boolean => cache.has(scope);

export const rememberProvenVp9EncoderIncompatibility = (
  scope: Vp9EncoderCapabilityScope,
  cache = getDefaultVp9EncoderNegativeCapabilityCache(),
): void => cache.mark(scope);

const collectErrorDescriptions = (error: unknown): string[] => {
  const descriptions: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      descriptions.push(`${current.name}: ${current.message}`);
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const candidate = current as {
        name?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      descriptions.push(
        `${typeof candidate.name === "string" ? candidate.name : "Error"}: ${
          typeof candidate.message === "string" ? candidate.message : ""
        }`,
      );
      current = candidate.cause;
      continue;
    }
    descriptions.push(String(current));
    break;
  }

  return descriptions;
};

const TRANSIENT_OR_REMOTE_FAILURE_PATTERN =
  /\b(?:transport|producer transport|ice|dtls|socket|signal(?:ing|ling)?|network|connection|disconnected|closed|timeout|timed out|server|sfu|room policy|current room)\b/i;
const VP9_ENCODER_CONTEXT_PATTERN =
  /\b(?:vp9|video codec|sender codec|encoder|scalability(?:\s+mode)?|l3t3(?:[_-]?key)?)\b/i;
const EXPLICIT_ENCODER_REJECTION_PATTERN =
  /\b(?:unsupported|not supported|not implemented|unavailable|cannot encode|can(?:not|'t) use|failed to (?:create|initialize|initialise|init)(?: the| a)?(?: video)? encoder|encoder (?:creation|initialization|initialisation) failed|invalid scalability(?:\s+mode)?|no matching codec)\b/i;

export const classifyVp9CodecFailure = (
  failure: unknown,
): Vp9CodecFailureClassification => {
  if (
    failure &&
    typeof failure === "object" &&
    (failure as { kind?: unknown }).kind === "vp9-zero-frame-stall"
  ) {
    return "proven-zero-frame-stall";
  }

  for (const description of collectErrorDescriptions(failure)) {
    if (TRANSIENT_OR_REMOTE_FAILURE_PATTERN.test(description)) continue;
    if (
      VP9_ENCODER_CONTEXT_PATTERN.test(description) &&
      EXPLICIT_ENCODER_REJECTION_PATTERN.test(description)
    ) {
      return "proven-encoder-incompatibility";
    }
  }
  return "transient-or-unknown";
};

export const createVp9ZeroFrameProof = (options: {
  epoch: number;
  initialProducerId: string;
  freshTrackId: string;
}): Vp9ZeroFrameProof => ({
  ...options,
  reproducerProducerId: null,
});

export const attachVp9ZeroFrameReproducer = (
  proof: Vp9ZeroFrameProof | null,
  options: { epoch: number; producerId: string },
): Vp9ZeroFrameProof | null => {
  if (!proof || proof.epoch !== options.epoch) return null;
  if (proof.initialProducerId === options.producerId) return null;
  return { ...proof, reproducerProducerId: options.producerId };
};

export const getProvenVp9ZeroFrameStall = (
  proof: Vp9ZeroFrameProof | null,
  options: { epoch: number; producerId: string; frames: number | null },
): ProvenVp9ZeroFrameStall | null => {
  if (
    !proof ||
    proof.epoch !== options.epoch ||
    options.frames !== 0 ||
    proof.reproducerProducerId !== options.producerId
  ) {
    return null;
  }
  return {
    kind: "vp9-zero-frame-stall",
    epoch: proof.epoch,
    initialProducerId: proof.initialProducerId,
    freshTrackId: proof.freshTrackId,
    reproducerProducerId: proof.reproducerProducerId,
  };
};

export const resolveWebcamCodecRecoveryOverride = <TCodec>(
  override: WebcamCodecRecoveryOverride<TCodec> | null,
  policy: WebcamCodecPolicy,
): WebcamCodecRecoveryOverride<TCodec> | null =>
  override?.policyEpoch === policy.epoch ? override : null;

const parseFmtp = (value: string | undefined): Map<string, string> => {
  const result = new Map<string, string>();
  for (const part of (value ?? "").split(";")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim().toLowerCase();
    if (!key) continue;
    result.set(key, rawValue?.trim().toLowerCase() ?? "");
  }
  return result;
};

const hasCodec = (
  capabilities: BrowserRtpCapabilities,
  codec: "vp8" | "h264-cb" | "vp9-p0",
): boolean =>
  capabilities?.codecs?.some((entry) => {
    const mimeType = entry.mimeType?.trim().toLowerCase();
    if (codec === "vp8") return mimeType === "video/vp8";
    const fmtp = parseFmtp(entry.sdpFmtpLine);
    const parameter = (key: string): string | undefined => {
      const value = entry.parameters?.[key];
      if (typeof value === "string" || typeof value === "number") {
        return String(value).trim().toLowerCase();
      }
      return fmtp.get(key);
    };
    if (codec === "vp9-p0") {
      return (
        mimeType === "video/vp9" &&
        (parameter("profile-id") === undefined || parameter("profile-id") === "0")
      );
    }
    if (mimeType !== "video/h264") return false;
    const profile = parameter("profile-level-id");
    return (
      parameter("packetization-mode") === "1" &&
      typeof profile === "string" &&
      /^42(?:c0|e0)[0-9a-f]{2}$/i.test(profile)
    );
  }) === true;

const supportsVp9SvcHandler = (handlerName: string): boolean =>
  /^(Chrome|Firefox)\d+$/i.test(handlerName);

export const buildBrowserWebcamCodecCapabilities = (options: {
  handlerName: string;
  senderCapabilities: BrowserRtpCapabilities;
  receiverCapabilities: BrowserRtpCapabilities;
  allowVp9SvcSend?: boolean;
  provenVp9EncoderIncompatibility?: boolean;
  preferredBaseline?: "vp8" | "h264";
}): ClientMediaCapabilities => {
  const receive: WebcamCodecCapability[] = [];
  const send: WebcamCodecCapability[] = [];

  if (hasCodec(options.receiverCapabilities, "vp8")) receive.push("vp8");
  if (hasCodec(options.receiverCapabilities, "h264-cb")) {
    receive.push("h264-cb");
  }
  if (hasCodec(options.receiverCapabilities, "vp9-p0")) {
    receive.push("vp9-p0");
  }

  if (hasCodec(options.senderCapabilities, "vp8")) send.push("vp8");
  if (hasCodec(options.senderCapabilities, "h264-cb")) send.push("h264-cb");
  if (
    hasCodec(options.senderCapabilities, "vp9-p0") &&
    supportsVp9SvcHandler(options.handlerName) &&
    options.allowVp9SvcSend !== false &&
    options.provenVp9EncoderIncompatibility !== true
  ) {
    send.push("vp9-p0-l2t1");
  }

  return {
    webcam: {
      negotiationVersion: 3,
      receive,
      send,
      preferredBaseline: options.preferredBaseline ?? "vp8",
    },
  };
};

export const detectBrowserWebcamCodecCapabilities = (
  handlerName: string,
  options: {
    videoInputDeviceId?: string | null;
    negativeCapabilityCache?: Vp9EncoderNegativeCapabilityCache;
    allowVp9SvcSend?: boolean;
  } = {},
): ClientMediaCapabilities => {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const vendor = typeof navigator === "undefined" ? "" : navigator.vendor;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const maxTouchPoints =
    typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints;
  const isIOS =
    /\b(iPad|iPhone|iPod)\b/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(userAgent) &&
    /Apple/i.test(vendor) &&
    !/CriOS|FxiOS|EdgiOS|Chrome|Chromium|Edg\//i.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  const prefersHardwareH264 = isIOS || isSafari || isAndroid;
  const senderCapabilities =
    typeof RTCRtpSender !== "undefined" &&
    typeof RTCRtpSender.getCapabilities === "function"
      ? RTCRtpSender.getCapabilities("video")
      : null;
  const receiverCapabilities =
    typeof RTCRtpReceiver !== "undefined" &&
    typeof RTCRtpReceiver.getCapabilities === "function"
      ? RTCRtpReceiver.getCapabilities("video")
      : null;
  const provenVp9EncoderIncompatibility = hasProvenVp9EncoderIncompatibility(
    {
      handlerName,
      videoInputDeviceId: options.videoInputDeviceId,
    },
    options.negativeCapabilityCache,
  );
  return buildBrowserWebcamCodecCapabilities({
    handlerName,
    senderCapabilities,
    receiverCapabilities,
    allowVp9SvcSend:
      !prefersHardwareH264 && options.allowVp9SvcSend !== false,
    provenVp9EncoderIncompatibility,
    preferredBaseline: prefersHardwareH264 ? "h264" : "vp8",
  });
};

export const detectLoadedDeviceWebcamCodecCapabilities = (
  device: {
    handlerName: string;
    sendRtpCapabilities?: BrowserRtpCapabilities;
    rtpCapabilities?: BrowserRtpCapabilities;
  },
  options: {
    videoInputDeviceId?: string | null;
    negativeCapabilityCache?: Vp9EncoderNegativeCapabilityCache;
  } = {},
): ClientMediaCapabilities => {
  const staticCapabilities = detectBrowserWebcamCodecCapabilities(
    device.handlerName,
    {
      ...options,
      // The loaded Device reflects the router intersection, while these
      // browser capabilities reflect the sender/receiver surface that will
      // actually encode and decode. Require both. This also preserves a
      // truthful native or proven-negative capability override instead of
      // re-introducing a codec from the router after Device.load().
      allowVp9SvcSend: true,
    },
  );
  const loadedCapabilities = buildBrowserWebcamCodecCapabilities({
    handlerName: device.handlerName,
    senderCapabilities: device.sendRtpCapabilities ?? null,
    receiverCapabilities: device.rtpCapabilities ?? null,
    allowVp9SvcSend: true,
    provenVp9EncoderIncompatibility: hasProvenVp9EncoderIncompatibility(
      {
        handlerName: device.handlerName,
        videoInputDeviceId: options.videoInputDeviceId,
      },
      options.negativeCapabilityCache,
    ),
    preferredBaseline:
      staticCapabilities.webcam.preferredBaseline === "h264" ? "h264" : "vp8",
  });

  const staticReceive = new Set(staticCapabilities.webcam.receive);
  const staticSend = new Set(staticCapabilities.webcam.send);
  return {
    webcam: {
      negotiationVersion: 3,
      receive: loadedCapabilities.webcam.receive.filter((codec) =>
        staticReceive.has(codec),
      ),
      send: loadedCapabilities.webcam.send.filter((codec) =>
        staticSend.has(codec),
      ),
      preferredBaseline: staticCapabilities.webcam.preferredBaseline,
    },
  };
};

export const BASELINE_WEBCAM_CODEC_POLICY: WebcamCodecPolicy = {
  codec: "vp8",
  mimeType: "video/VP8",
  epoch: 0,
};

export const normalizeWebcamCodecPolicy = (
  value: unknown,
): WebcamCodecPolicy | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WebcamCodecPolicy>;
  if (!Number.isInteger(candidate.epoch) || (candidate.epoch ?? -1) < 0) {
    return null;
  }

  if (
    candidate.codec === "vp9" &&
    candidate.mimeType === "video/VP9" &&
    candidate.profileId === 0 &&
    candidate.scalabilityMode === "L2T1"
  ) {
    return {
      codec: "vp9",
      mimeType: "video/VP9",
      profileId: 0,
      scalabilityMode: "L2T1",
      epoch: candidate.epoch!,
    };
  }
  if (candidate.codec === "h264" && candidate.mimeType === "video/H264") {
    return {
      codec: "h264",
      mimeType: "video/H264",
      epoch: candidate.epoch!,
    };
  }
  if (candidate.codec === "vp8" && candidate.mimeType === "video/VP8") {
    return {
      codec: "vp8",
      mimeType: "video/VP8",
      epoch: candidate.epoch!,
    };
  }
  return null;
};

export const isNewerWebcamCodecPolicy = (
  current: WebcamCodecPolicy,
  next: WebcamCodecPolicy,
): boolean => next.epoch > current.epoch;
