import type {
  Device,
  ProducerCodecOptions,
  RtpCodecCapability,
} from "mediasoup-client/types";
import type { Producer, ProducerType, Transport, VideoQuality } from "./types";
import type { WebcamCodecPolicy } from "./types";
import {
  MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE,
  SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE,
  SCREEN_SHARE_MAX_BITRATE,
  SCREEN_SHARE_MAX_FRAMERATE,
} from "./constants";
import {
  buildWebcamSimulcastEncodings,
  buildWebcamSingleLayerEncoding,
  buildScreenShareEncoding,
} from "./video-encodings";
import type { WebcamProducerTopology } from "./webcam-topology-transition";
import { toError } from "./utils";

// Desktop Chromium/Firefox generally get the strongest simulcast behavior with
// VP8. Safari/iOS/Android are more sensitive to software video paths, so prefer
// H264 there when the router/browser intersection supports it.
const SOFTWARE_VP8_SENSITIVE_CODEC_MIME_TYPES = [
  "video/H264",
  "video/VP8",
] as const;
const SIMULCAST_FRIENDLY_CODEC_MIME_TYPES = [
  "video/VP8",
  "video/H264",
] as const;
// Keep screen share on the same reliable codec order as the native app.
// Desktop VP9 screen capture can look good when it works, but monitor/full
// screen captures have been observed to publish decodable black frames on some
// GPU/browser combinations. Keep VP9 only as a last-resort fallback.
const SCREEN_SHARE_CODEC_MIME_TYPES = [
  "video/VP8",
  "video/H264",
  "video/VP9",
] as const;

type CodecCapabilityDevice = {
  sendRtpCapabilities?: Device["sendRtpCapabilities"];
  rtpCapabilities?: Device["rtpCapabilities"];
};

const getSendVideoCodecs = (
  device: CodecCapabilityDevice | null | undefined,
) =>
  device?.sendRtpCapabilities?.codecs ??
  device?.rtpCapabilities?.codecs ??
  [];

const isLikelyHardwareAcceleratedH264Browser = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  const vendor = navigator.vendor;
  const platform = navigator.platform;
  const isIOS =
    /\b(iPad|iPhone|iPod)\b/.test(userAgent) ||
    (platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari =
    /Safari/i.test(userAgent) &&
    /Apple/i.test(vendor) &&
    !/CriOS|FxiOS|EdgiOS|Chrome|Chromium|Edg\//i.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  return isIOS || isSafari || isAndroid;
};

const getPreferredVideoCodecMimeTypes = () =>
  isLikelyHardwareAcceleratedH264Browser()
    ? SOFTWARE_VP8_SENSITIVE_CODEC_MIME_TYPES
    : SIMULCAST_FRIENDLY_CODEC_MIME_TYPES;

const isPreferredVideoCodec = (
  codec: RtpCodecCapability,
  mimeType: string,
): boolean => {
  return (
    codec.kind === "video" &&
    codec.mimeType.toLowerCase() === mimeType.toLowerCase()
  );
};

export const shouldUseWebcamSimulcast = (
  preferredCodec?: RtpCodecCapability,
): boolean => {
  if (preferredCodec?.mimeType.toLowerCase() === "video/vp9") return false;
  if (!isLikelyHardwareAcceleratedH264Browser()) return true;
  if (!preferredCodec || isPreferredVideoCodec(preferredCodec, "video/H264")) {
    return false;
  }
  return true;
};

export const getWebcamEncodingCountForQuality = (
  quality: VideoQuality,
  useSimulcast: boolean,
): number =>
  useSimulcast ? buildWebcamSimulcastEncodings(quality).length : 1;

export const shouldRecreateWebcamProducerForQuality = (
  quality: VideoQuality,
  useSimulcast: boolean,
  currentEncodingCount: number,
): boolean =>
  currentEncodingCount > 0 &&
  currentEncodingCount !==
    getWebcamEncodingCountForQuality(quality, useSimulcast);

export const getPreferredWebcamCodec = (
  device: CodecCapabilityDevice | null | undefined,
  policy?: WebcamCodecPolicy | null,
): RtpCodecCapability | undefined => {
  const codecs = getSendVideoCodecs(device);

  if (policy) {
    return codecs.find((candidate) => {
      if (!isPreferredVideoCodec(candidate, policy.mimeType)) return false;
      if (policy.codec !== "vp9") return true;
      const profileId = candidate.parameters?.["profile-id"];
      return profileId === undefined || profileId === 0 || profileId === "0";
    });
  }

  for (const mimeType of getPreferredVideoCodecMimeTypes()) {
    const codec = codecs.find((candidate) =>
      isPreferredVideoCodec(candidate, mimeType),
    );
    if (codec) {
      return codec;
    }
  }

  return undefined;
};

export const getFallbackWebcamCodec = (
  device: CodecCapabilityDevice | null | undefined,
  currentCodec?: RtpCodecCapability,
  policy?: WebcamCodecPolicy | null,
): RtpCodecCapability | undefined => {
  if (policy) return getPreferredWebcamCodec(device, policy);
  const codecs = getSendVideoCodecs(device);
  const currentMimeType = currentCodec?.mimeType.toLowerCase() ?? null;
  const fallbackOrder =
    currentMimeType === "video/h264"
      ? (["video/VP8", "video/H264"] as const)
      : currentMimeType === "video/vp8"
      ? (["video/H264", "video/VP8"] as const)
      : getPreferredVideoCodecMimeTypes();

  for (const mimeType of fallbackOrder) {
    if (mimeType.toLowerCase() === currentMimeType) continue;
    const codec = codecs.find((candidate) =>
      isPreferredVideoCodec(candidate, mimeType),
    );
    if (codec) {
      return codec;
    }
  }

  return undefined;
};

export const getPreferredScreenShareCodec = (
  device: CodecCapabilityDevice | null | undefined,
): RtpCodecCapability | undefined => {
  const codecs = getSendVideoCodecs(device);

  for (const mimeType of SCREEN_SHARE_CODEC_MIME_TYPES) {
    const codec = codecs.find((candidate) =>
      isPreferredVideoCodec(candidate, mimeType),
    );
    if (codec) {
      return codec;
    }
  }

  return undefined;
};

type ProduceWebcamTrackOptions = {
  transport: Transport;
  track: MediaStreamTrack;
  quality: VideoQuality;
  networkProfile?: WebcamProducerNetworkProfile;
  paused: boolean;
  preferredCodec?: RtpCodecCapability;
  forceSingleLayer?: boolean;
  forceSimulcast?: boolean;
  receiverCapacityTransition?: WebcamReceiverCapacityTransition;
  codecPolicy?: WebcamCodecPolicy | null;
};

export type WebcamReceiverCapacityTransition = {
  fromProducerId: string;
  nonce: string;
};

type ProduceScreenShareTrackOptions = {
  transport: Transport;
  track: MediaStreamTrack;
  networkProfile: WebcamProducerNetworkProfile;
  preferredCodec?: RtpCodecCapability;
};

export type WebcamProducerNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";

type ScreenProducerAppData = {
  type: ProducerType;
  networkProfile: WebcamProducerNetworkProfile;
};

type WebcamEncodingCap = {
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy?: number;
};

type CaptureSize = {
  width: number | null;
  height: number | null;
};

type SenderParameterPreferences = {
  degradationPreference?: RTCDegradationPreference;
  priority?: RTCPriorityType;
};

const WEBCAM_DEGRADATION_PREFERENCE: RTCDegradationPreference =
  "maintain-framerate";
const VP9_WEBCAM_DEGRADATION_PREFERENCE: RTCDegradationPreference =
  "maintain-resolution";
const SCREEN_SHARE_DEGRADATION_PREFERENCE: RTCDegradationPreference =
  "maintain-resolution";
const AUDIO_RTP_PRIORITY: RTCPriorityType = "high";
const SCREEN_SHARE_RTP_PRIORITY: RTCPriorityType = "high";
const WEBRTC_ENCODING_ORDER = ["q", "h", "f"] as const;
const MIN_CRISP_BASE_LAYER_WIDTH = 300;
const MIN_CRISP_BASE_LAYER_HEIGHT = 160;
const FAIR_BANDWIDTH_LAYER_TARGETS = [
  { width: 320, height: 180 },
  { width: 640, height: 360 },
] as const;
const SURVIVAL_BANDWIDTH_CAPTURE_TARGETS = {
  poor: { width: 426, height: 240 },
  emergency: { width: 320, height: 180 },
} as const;
const STANDARD_GOOD_START_BITRATE_KBPS = 1_800;
const LOW_GOOD_START_BITRATE_KBPS = 300;
const FAIR_START_BITRATE_KBPS = 350;
const POOR_START_BITRATE_KBPS = 90;
const EMERGENCY_START_BITRATE_KBPS = 65;
// Keep a fixed 360p/720p spatial ladder at full cadence. L2T1's inter-layer
// prediction lets an SFU keep forwarding the continuously decodable base while
// the enhancement layer returns; changing encoder geometry or toggling L1/L2
// forced every receiver to wait roughly 500ms for a replacement keyframe.
const VP9_SVC_SCALABILITY_MODE = "L2T1" as const;
// The two-layer VP9 profile-0 ladder avoids the former 180p duplicate and
// reserves the 1.65 Mbps cap for the useful 360p/720p layers. A measured 1.5
// Mbps cap retained still-frame fidelity but caused 720p cadence and latency
// misses under deterministic motion, so preserve this headroom for full 30fps.
// It remains below the pristine budget and the VP8 simulcast ceiling.
const VP9_SVC_STANDARD_MAX_BITRATE = 1_650_000;
// Chromium's VP8 encoder emits frequent synchronized keyframes and starves the
// full stream when q/h are changed to `active: false` on a live simulcast
// sender. Keep those unused layers as low-rate standbys instead: that preserves
// the encoder's efficient inter-frame cadence, keeps instant fail-safe layer
// recovery, and leaves almost the entire 1.8 Mbps pristine budget for 720p.
const VP8_SINGLE_RECEIVER_STANDBY_CAPS = [
  { maxBitrate: 35_000, maxFramerate: 12 },
  { maxBitrate: 90_000, maxFramerate: 20 },
  { maxBitrate: 1_750_000, maxFramerate: 30 },
] as const;
// A live simulcast encoder is a topology, not a quality switch. Chromium can
// stall every RID when setMaxSpatialLayer(), `active`, frame cadence, or RTP
// priority changes force it to rebuild that topology. Keep every independent
// encoder alive at its canonical raster/cadence and turn unused layers into
// low-bitrate standbys. Initial constrained publishes still use the full caps;
// live transitions only need to change bitrate.
const VP8_STABLE_SIMULCAST_PROFILE_CAPS = {
  fair: [
    { maxBitrate: 80_000, maxFramerate: 12 },
    { maxBitrate: 220_000, maxFramerate: 20 },
    { maxBitrate: 35_000, maxFramerate: 5 },
  ],
  poor: [
    { maxBitrate: 80_000, maxFramerate: 12 },
    { maxBitrate: 25_000, maxFramerate: 5 },
    { maxBitrate: 15_000, maxFramerate: 3 },
  ],
  emergency: [
    { maxBitrate: 65_000, maxFramerate: 8 },
    { maxBitrate: 12_000, maxFramerate: 4 },
    { maxBitrate: 8_000, maxFramerate: 2 },
  ],
} as const;

export const buildWebcamCodecOptions = (
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): ProducerCodecOptions => ({
  // mediasoup maps this libwebrtc hint to x-google-start-bitrate. Starting a
  // healthy 720p sender above Chrome's conservative default lets the requested
  // full simulcast layer become usable promptly, while constrained profiles
  // keep a start point inside their active encoding budget.
  videoGoogleStartBitrate:
    profile === "emergency"
      ? EMERGENCY_START_BITRATE_KBPS
      : profile === "poor"
        ? POOR_START_BITRATE_KBPS
        : profile === "fair"
          ? FAIR_START_BITRATE_KBPS
          : quality === "standard"
            ? STANDARD_GOOD_START_BITRATE_KBPS
            : LOW_GOOD_START_BITRATE_KBPS,
});

const getTrackCaptureSize = (
  track: MediaStreamTrack | null | undefined,
): CaptureSize => {
  if (!track) return { width: null, height: null };
  try {
    const settings = track.getSettings();
    return {
      width:
        typeof settings.width === "number" && Number.isFinite(settings.width)
          ? settings.width
          : null,
      height:
        typeof settings.height === "number" && Number.isFinite(settings.height)
          ? settings.height
          : null,
    };
  } catch {
    return { width: null, height: null };
  }
};

const getEncodingRid = (encoding: unknown): unknown => {
  if (!encoding || typeof encoding !== "object" || !("rid" in encoding)) {
    return undefined;
  }
  return (encoding as { rid?: unknown }).rid;
};

const getEncodingRanks = (
  encodings: readonly unknown[],
): number[] => {
  const presentKnownRids = WEBRTC_ENCODING_ORDER.filter((rid) =>
    encodings.some((encoding) => getEncodingRid(encoding) === rid),
  );
  const rankByRid = new Map(
    presentKnownRids.map((rid, index) => [rid, index] as const),
  );
  return encodings.map((encoding, index) => {
    const rid = getEncodingRid(encoding);
    if (typeof rid !== "string") return index;
    return rankByRid.get(
      rid as (typeof WEBRTC_ENCODING_ORDER)[number],
    ) ?? index;
  });
};

const getBaseEncodingCaps = (
  quality: VideoQuality,
  encodingCount: number,
): WebcamEncodingCap[] => {
  const baseEncodings =
    encodingCount > 1
      ? buildWebcamSimulcastEncodings(quality)
      : [buildWebcamSingleLayerEncoding(quality)];

  return baseEncodings.map((encoding) => ({
    maxBitrate: encoding.maxBitrate,
    maxFramerate: encoding.maxFramerate,
    ...("scaleResolutionDownBy" in encoding &&
    typeof encoding.scaleResolutionDownBy === "number"
      ? { scaleResolutionDownBy: encoding.scaleResolutionDownBy }
      : {}),
  }));
};

const capAt = (values: readonly number[], index: number): number =>
  values[index] ?? values[values.length - 1] ?? 0;

const getProfileAdjustedCap = (
  base: WebcamEncodingCap,
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
): WebcamEncodingCap => {
  if (profile === "good") {
    return base;
  }

  if (profile === "fair") {
    const fairBitrateCaps =
      quality === "standard"
        ? [120000, 420000, 900000]
        : [80000, 220000];
    const fairFramerateCaps = [15, 24, 30];
    return {
      maxBitrate: Math.min(
        base.maxBitrate,
        capAt(fairBitrateCaps, layerRank),
      ),
      maxFramerate: Math.min(
        base.maxFramerate,
        capAt(fairFramerateCaps, layerRank),
      ),
    };
  }

  if (profile === "poor") {
    return {
      maxBitrate: Math.min(base.maxBitrate, layerRank === 0 ? 120000 : 160000),
      maxFramerate: Math.min(base.maxFramerate, 12),
    };
  }

  return {
    maxBitrate: Math.min(base.maxBitrate, layerRank === 0 ? 65000 : 90000),
    maxFramerate: Math.min(base.maxFramerate, 8),
  };
};

const getStableSimulcastProfileCap = (
  base: WebcamEncodingCap,
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
): WebcamEncodingCap => {
  if (profile === "good") return base;
  const profileCaps = VP8_STABLE_SIMULCAST_PROFILE_CAPS[profile];
  const cap = profileCaps[layerRank] ?? profileCaps[profileCaps.length - 1];
  return {
    maxBitrate: Math.min(base.maxBitrate, cap.maxBitrate),
    maxFramerate: Math.min(base.maxFramerate, cap.maxFramerate),
    scaleResolutionDownBy: base.scaleResolutionDownBy,
  };
};

const getCaptureScaleForTarget = (
  captureSize: CaptureSize,
  target: { width: number; height: number },
): number | null => {
  const widthScale =
    captureSize.width !== null && captureSize.width > 0
      ? captureSize.width / target.width
      : null;
  const heightScale =
    captureSize.height !== null && captureSize.height > 0
      ? captureSize.height / target.height
      : null;
  const targetScale = Math.min(
    ...(widthScale !== null ? [widthScale] : []),
    ...(heightScale !== null ? [heightScale] : []),
  );
  if (!Number.isFinite(targetScale) || targetScale <= 1) return null;
  return Number(targetScale.toFixed(1));
};

const getCaptureAdjustedScaleResolutionDownBy = (
  current: number | undefined,
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
  captureSize: CaptureSize,
): number | undefined => {
  if (layerRank === 0 && (profile === "poor" || profile === "emergency")) {
    const target = SURVIVAL_BANDWIDTH_CAPTURE_TARGETS[profile];
    // The RTP cap is intentionally applied before capture constraints are
    // reopened. Scale a still-large track to the survival raster immediately,
    // then settle at 1:1 once capture reaches that same raster.
    return getCaptureScaleForTarget(captureSize, target) ?? 1;
  }
  if (profile === "fair" && typeof current === "number") {
    const target = FAIR_BANDWIDTH_LAYER_TARGETS[layerRank];
    if (!target) return current;
    const targetScale = getCaptureScaleForTarget(
      captureSize,
      target,
    );
    // Fair links capture at 640x360. Keep its active q/h ladder at 320x180 and
    // 640x360 instead of scaling the capture a second time to 160x90/320x180.
    return Math.min(current, targetScale ?? 1);
  }
  if (layerRank !== 0 || typeof current !== "number") return current;

  const widthScale =
    captureSize.width !== null && captureSize.width >= MIN_CRISP_BASE_LAYER_WIDTH
      ? captureSize.width / MIN_CRISP_BASE_LAYER_WIDTH
      : null;
  const heightScale =
    captureSize.height !== null &&
    captureSize.height >= MIN_CRISP_BASE_LAYER_HEIGHT
      ? captureSize.height / MIN_CRISP_BASE_LAYER_HEIGHT
      : null;
  const maxCrispScale = Math.min(
    ...(widthScale !== null ? [widthScale] : []),
    ...(heightScale !== null ? [heightScale] : []),
  );
  if (!Number.isFinite(maxCrispScale) || maxCrispScale <= 0) {
    return current;
  }

  return Math.min(current, Math.max(1, Number(maxCrispScale.toFixed(1))));
};

const getWebcamRtpPriority = (
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
): RTCPriorityType => {
  if (profile === "emergency") return "very-low";
  if (profile === "poor") return layerRank === 0 ? "low" : "very-low";
  if (profile === "fair") return layerRank === 0 ? "medium" : "low";
  return layerRank === 0 ? "medium" : "low";
};

export const getWebcamSenderRtpPriority = (
  profile: WebcamProducerNetworkProfile,
  _optimizeForSingleReceiver: boolean,
): RTCPriorityType => {
  return getWebcamRtpPriority(profile, 0);
};

type WebcamProduceEncoding =
  | ReturnType<typeof buildWebcamSimulcastEncodings>[number]
  | ReturnType<typeof buildWebcamSingleLayerEncoding>;

const applyNetworkProfileToInitialWebcamEncodings = <
  T extends WebcamProduceEncoding,
>(
  encodings: readonly T[],
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
  captureSize: CaptureSize,
): T[] => {
  const layerRanks = getEncodingRanks(encodings);
  return encodings.map((encoding, index) => {
    const layerRank = layerRanks[index] ?? index;
    const base = {
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
      ...("scaleResolutionDownBy" in encoding &&
      typeof encoding.scaleResolutionDownBy === "number"
        ? { scaleResolutionDownBy: encoding.scaleResolutionDownBy }
        : {}),
    };
    const adjusted =
      encodings.length > 1
        ? getStableSimulcastProfileCap(base, profile, layerRank)
        : getProfileAdjustedCap(base, quality, profile, layerRank);
    return {
      ...encoding,
      active: true,
      ...("scaleResolutionDownBy" in encoding
        ? {
            scaleResolutionDownBy:
              encodings.length > 1
                ? encoding.scaleResolutionDownBy
                : getCaptureAdjustedScaleResolutionDownBy(
                    encoding.scaleResolutionDownBy,
                    profile,
                    layerRank,
                    captureSize,
                  ),
          }
        : {}),
      maxBitrate: adjusted.maxBitrate,
      maxFramerate: adjusted.maxFramerate,
    };
  });
};

const mergeEncodingCaps = (
  current: RTCRtpEncodingParameters,
  desired: RTCRtpEncodingParameters | undefined,
  priority?: RTCPriorityType,
  canSetPerSenderPriority = false,
): RTCRtpEncodingParameters => {
  const merged: RTCRtpEncodingParameters = { ...current };
  if (!desired) return merged;
  if (typeof desired.active === "boolean") {
    merged.active = desired.active;
  }
  if (typeof desired.maxBitrate === "number") {
    merged.maxBitrate = desired.maxBitrate;
  }
  if (typeof desired.maxFramerate === "number") {
    merged.maxFramerate = desired.maxFramerate;
  }
  if (typeof desired.scaleResolutionDownBy === "number") {
    merged.scaleResolutionDownBy = desired.scaleResolutionDownBy;
  }
  if (
    "scalabilityMode" in desired &&
    typeof desired.scalabilityMode === "string"
  ) {
    (
      merged as RTCRtpEncodingParameters & { scalabilityMode?: string }
    ).scalabilityMode = desired.scalabilityMode;
  }
  if (priority && canSetPerSenderPriority) {
    merged.priority = priority;
    merged.networkPriority = priority;
  }
  return merged;
};

const buildFreshSenderParameters = (
  sender: RTCRtpSender,
  desired: RTCRtpSendParameters,
  preferences: SenderParameterPreferences,
  options: {
    includeEncodingPriority: boolean;
    includeDegradationPreference: boolean;
  },
): RTCRtpSendParameters => {
  const fresh = sender.getParameters();
  const desiredEncodings = desired.encodings ?? [];
  return {
    ...fresh,
    ...(options.includeDegradationPreference &&
    preferences.degradationPreference
      ? { degradationPreference: preferences.degradationPreference }
      : {}),
    encodings: (fresh.encodings ?? []).map((encoding, index) =>
      mergeEncodingCaps(
        encoding,
        desiredEncodings[index],
        options.includeEncodingPriority ? preferences.priority : undefined,
        index === 0,
      ),
    ),
  };
};

const setSenderParametersWithPreferences = async (
  sender: RTCRtpSender,
  parameters: RTCRtpSendParameters,
  preferences: SenderParameterPreferences = {},
): Promise<void> => {
  const preferredParameters: RTCRtpSendParameters = {
    ...parameters,
    ...(preferences.degradationPreference
      ? { degradationPreference: preferences.degradationPreference }
      : {}),
    encodings: preferences.priority
      ? parameters.encodings.map((encoding, index) => ({
          ...encoding,
          ...(index === 0
            ? {
                priority: preferences.priority,
                networkPriority: preferences.priority,
              }
            : {}),
        }))
      : parameters.encodings,
  };

  try {
    await sender.setParameters(preferredParameters);
  } catch (error) {
    try {
      await sender.setParameters(
        buildFreshSenderParameters(sender, preferredParameters, preferences, {
          includeEncodingPriority: false,
          includeDegradationPreference: true,
        }),
      );
    } catch {
      await sender.setParameters(
        buildFreshSenderParameters(sender, parameters, preferences, {
          includeEncodingPriority: false,
          includeDegradationPreference: false,
        }),
      );
    }
    console.debug("[Meets] RTP sender preferences were not fully applied:", error);
  }
};

type KeyFrameRequestingRtpSender = RTCRtpSender & {
  setParameters: (
    parameters: RTCRtpSendParameters,
    options?: {
      encodingOptions?: Array<{ keyFrame?: boolean }>;
    },
  ) => Promise<void>;
};

/**
 * Ask the active encoder for an immediate key frame after a capture or
 * resolution transition. Browsers without the WebRTC extension either ignore
 * the optional argument or reject it; quality switching must remain usable in
 * both cases.
 */
export async function requestVideoSenderKeyFrame(
  sender: RTCRtpSender | null | undefined,
): Promise<boolean> {
  if (!sender) return false;
  try {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    if (encodings.length === 0) return false;
    await (sender as KeyFrameRequestingRtpSender).setParameters(parameters, {
      encodingOptions: encodings.map(() => ({ keyFrame: true })),
    });
    return true;
  } catch {
    return false;
  }
}

export const isVp9SvcWebcamProducer = (producer: Producer): boolean =>
  (producer.rtpParameters.codecs ?? []).some(
    (codec) => codec.mimeType.toLowerCase() === "video/vp9",
  ) &&
  (producer.rtpParameters.encodings ?? []).some(
    (encoding) =>
      encoding.scalabilityMode?.toUpperCase() === VP9_SVC_SCALABILITY_MODE,
  );

const isVp8SimulcastProducer = (producer: Producer): boolean =>
  (producer.rtpParameters.codecs ?? []).some(
    (codec) => codec.mimeType.toLowerCase() === "video/vp8",
  ) && (producer.rtpParameters.encodings ?? []).length > 1;

export const getWebcamProducerTopology = (
  producer: Producer | null | undefined,
): WebcamProducerTopology => {
  if (!producer || producer.closed || producer.kind !== "video") return "other";
  const isVp8 = (producer.rtpParameters.codecs ?? []).some(
    (codec) => codec.mimeType.toLowerCase() === "video/vp8",
  );
  if (!isVp8) return "other";
  const encodingCount = producer.rtpParameters.encodings?.length ?? 0;
  if (encodingCount > 1) return "vp8-simulcast";
  if (encodingCount === 1) return "vp8-single-layer";
  return "other";
};

const getVp9SvcEncodingCap = (
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): { maxBitrate: number; maxFramerate: number } => {
  const base = buildWebcamSingleLayerEncoding(quality);
  if (profile === "fair") {
    return {
      maxBitrate: Math.min(base.maxBitrate, 900000),
      maxFramerate: Math.min(base.maxFramerate, 24),
    };
  }
  if (profile === "poor") {
    return {
      maxBitrate: Math.min(base.maxBitrate, 160000),
      maxFramerate: Math.min(base.maxFramerate, 12),
    };
  }
  if (profile === "emergency") {
    return {
      maxBitrate: Math.min(base.maxBitrate, 90000),
      maxFramerate: Math.min(base.maxFramerate, 8),
    };
  }
  return {
    maxBitrate:
      quality === "standard"
        ? VP9_SVC_STANDARD_MAX_BITRATE
        : base.maxBitrate,
    maxFramerate: base.maxFramerate,
  };
};

const getVp9SvcScaleResolutionDownBy = (): number => 1;

const applyWebcamEncodingCaps = async (
  producer: Producer,
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
  optimizeForSingleReceiver: boolean,
): Promise<void> => {
  const sender = producer.rtpSender;
  const vp9Svc = isVp9SvcWebcamProducer(producer);
  const singleReceiverVp8 =
    optimizeForSingleReceiver &&
    quality === "standard" &&
    profile === "good" &&
    isVp8SimulcastProducer(producer);
  if (sender) {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    if (encodings.length > 0) {
      if (vp9Svc) {
        const cap = getVp9SvcEncodingCap(quality, profile);
        const scaleResolutionDownBy = getVp9SvcScaleResolutionDownBy();
        await setSenderParametersWithPreferences(
          sender,
          {
            ...parameters,
            encodings: encodings.map((encoding) => ({
              ...encoding,
              active: true,
              maxBitrate: cap.maxBitrate,
              maxFramerate: cap.maxFramerate,
              scaleResolutionDownBy,
              scalabilityMode: VP9_SVC_SCALABILITY_MODE,
            })),
          },
          { degradationPreference: VP9_WEBCAM_DEGRADATION_PREFERENCE },
        );
        return;
      }
      const expectedEncodingCount = getWebcamEncodingCountForQuality(
        quality,
        encodings.length > 1,
      );
      if (encodings.length !== expectedEncodingCount) {
        const topologyError = new Error(
          `Cannot apply ${quality} webcam caps to ${encodings.length} encodings; expected ${expectedEncodingCount}. Producer recreation is required.`,
        );
        console.warn(
          "[Meets] Skipping webcam caps for an incompatible encoding topology; producer recreation is required:",
          {
            quality,
            currentEncodingCount: encodings.length,
            expectedEncodingCount,
          },
        );
        throw topologyError;
      }
      const captureSize = getTrackCaptureSize(producer.track);
      const baseCaps = getBaseEncodingCaps(quality, encodings.length);
      const layerRanks = getEncodingRanks(encodings);
      const highestLayerRank = Math.max(...layerRanks);
      const canMutateSenderPriorityWithoutRebuildingTopology =
        encodings.length === 1;
      const senderPriority = canMutateSenderPriorityWithoutRebuildingTopology
        ? getWebcamSenderRtpPriority(profile, singleReceiverVp8)
        : undefined;
      const nextEncodings = encodings.map((encoding, index) => {
        const layerRank = layerRanks[index] ?? index;
        const base = baseCaps[layerRank] ?? baseCaps[index] ?? baseCaps[0];
        const adjusted =
          encodings.length > 1
            ? getStableSimulcastProfileCap(base, profile, layerRank)
            : getProfileAdjustedCap(base, quality, profile, layerRank);
        const standbyCap = singleReceiverVp8
          ? (VP8_SINGLE_RECEIVER_STANDBY_CAPS[layerRank] ??
            VP8_SINGLE_RECEIVER_STANDBY_CAPS[highestLayerRank])
          : null;
        return {
          ...encoding,
          active: true,
          maxBitrate: standbyCap?.maxBitrate ?? adjusted.maxBitrate,
          // Preserve the cadence of an existing simulcast topology. A sender
          // created under a constrained profile already carries that cadence;
          // a normal good-start sender therefore changes bitrate only.
          maxFramerate:
            encodings.length > 1 &&
            typeof encoding.maxFramerate === "number"
              ? encoding.maxFramerate
              : standbyCap?.maxFramerate ?? adjusted.maxFramerate,
          scaleResolutionDownBy:
            encodings.length > 1
              ? base.scaleResolutionDownBy
              : getCaptureAdjustedScaleResolutionDownBy(
                  base.scaleResolutionDownBy,
                  profile,
                  layerRank,
                  captureSize,
                ),
          // Chromium currently treats simulcast RTP priority as a sender-wide
          // preference and rejects attempts to mutate it on every RID. Put the
          // one-to-one boost on the supported first encoding slot.
          ...(index === 0 && senderPriority
            ? {
                priority: senderPriority,
                networkPriority: senderPriority,
              }
            : {}),
        };
      });
      await setSenderParametersWithPreferences(
        sender,
        { ...parameters, encodings: nextEncodings },
        {
          degradationPreference: WEBCAM_DEGRADATION_PREFERENCE,
          ...(senderPriority ? { priority: senderPriority } : {}),
        },
      );
      return;
    }
  }

  const [base] = getBaseEncodingCaps(quality, 1);
  const adjusted = vp9Svc
    ? getVp9SvcEncodingCap(quality, profile)
    : getProfileAdjustedCap(base, quality, profile, 0);
  const captureSize = getTrackCaptureSize(producer.track);
  const fallbackScaleResolutionDownBy = getCaptureAdjustedScaleResolutionDownBy(
    base.scaleResolutionDownBy,
    profile,
    0,
    captureSize,
  );
  const appliedScaleResolutionDownBy = vp9Svc
    ? getVp9SvcScaleResolutionDownBy()
    : fallbackScaleResolutionDownBy;
  await producer.setRtpEncodingParameters({
    maxBitrate: adjusted.maxBitrate,
    maxFramerate: adjusted.maxFramerate,
    ...(typeof appliedScaleResolutionDownBy === "number"
      ? { scaleResolutionDownBy: appliedScaleResolutionDownBy }
      : {}),
  });
};

type ScreenShareEncoding = ReturnType<typeof buildScreenShareEncoding> & {
  scaleResolutionDownBy?: number;
};

type FallbackScreenShareEncoding = Omit<ScreenShareEncoding, "scalabilityMode">;

type ScreenShareCap = WebcamEncodingCap & {
  idealWidth: number;
  idealHeight: number;
  maxWidth: number;
  maxHeight: number;
};

const SCREEN_SHARE_CAPS: Record<WebcamProducerNetworkProfile, ScreenShareCap> = {
  good: {
    maxBitrate: SCREEN_SHARE_MAX_BITRATE,
    maxFramerate: SCREEN_SHARE_MAX_FRAMERATE,
    idealWidth: 1920,
    idealHeight: 1080,
    maxWidth: 3840,
    maxHeight: 2160,
  },
  fair: {
    maxBitrate: 1200000,
    maxFramerate: 12,
    idealWidth: 1920,
    idealHeight: 1080,
    maxWidth: 2560,
    maxHeight: 1440,
  },
  poor: {
    maxBitrate: 450000,
    maxFramerate: 5,
    idealWidth: 1600,
    idealHeight: 900,
    maxWidth: 1920,
    maxHeight: 1080,
  },
  emergency: {
    maxBitrate: 220000,
    maxFramerate: 3,
    idealWidth: 1280,
    idealHeight: 720,
    maxWidth: 1280,
    maxHeight: 720,
  },
};

const getCaptureScaleToFit = (
  captureSize: CaptureSize,
  target: { width: number; height: number },
): number | null => {
  const widthScale =
    captureSize.width !== null && captureSize.width > target.width
      ? captureSize.width / target.width
      : 1;
  const heightScale =
    captureSize.height !== null && captureSize.height > target.height
      ? captureSize.height / target.height
      : 1;
  const targetScale = Math.max(widthScale, heightScale);
  if (!Number.isFinite(targetScale) || targetScale <= 1) return null;
  return Number((Math.ceil(targetScale * 10) / 10).toFixed(1));
};

const getScreenShareScaleResolutionDownBy = (
  profile: WebcamProducerNetworkProfile,
  captureSize: CaptureSize,
): number => {
  if (profile === "good") return 1;
  const cap = SCREEN_SHARE_CAPS[profile];
  return (
    getCaptureScaleToFit(captureSize, {
      width: cap.maxWidth,
      height: cap.maxHeight,
    }) ?? 1
  );
};

export function buildScreenShareVideoConstraintsForNetworkProfile(
  profile: WebcamProducerNetworkProfile,
): MediaTrackConstraints & { cursor?: "always" | "motion" | "never" } {
  const cap = SCREEN_SHARE_CAPS[profile];
  return {
    frameRate: { ideal: cap.maxFramerate, max: cap.maxFramerate },
    width: { ideal: cap.idealWidth, max: cap.maxWidth },
    height: { ideal: cap.idealHeight, max: cap.maxHeight },
    cursor: "always",
  };
}

const AUDIO_CAPS: Record<
  ProducerType,
  Record<WebcamProducerNetworkProfile, number>
> = {
  webcam: MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE,
  screen: SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE,
};

export async function applyAudioProducerNetworkProfile(
  producer: Producer,
  producerType: ProducerType,
  profile: WebcamProducerNetworkProfile,
): Promise<void> {
  if (producer.kind !== "audio" || producer.closed) return;

  const maxBitrate = AUDIO_CAPS[producerType][profile];
  const sender = producer.rtpSender;
  if (sender) {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    if (encodings.length > 0) {
      await setSenderParametersWithPreferences(
        sender,
        {
          ...parameters,
          encodings: encodings.map((encoding) => ({
            ...encoding,
            maxBitrate,
          })),
        },
        { priority: AUDIO_RTP_PRIORITY },
      );
      return;
    }
  }

  await producer.setRtpEncodingParameters({
    maxBitrate,
  });
}

export async function applyScreenShareProducerNetworkProfile(
  producer: Producer,
  profile: WebcamProducerNetworkProfile,
): Promise<void> {
  if (producer.kind !== "video" || producer.closed) return;

  const cap = SCREEN_SHARE_CAPS[profile];
  let trackProfileError: Error | null = null;
  try {
    await applyScreenShareTrackNetworkProfile(producer.track, profile);
  } catch (error) {
    // RTP caps can still protect the connection when a browser rejects one of
    // the capture constraints, but the caller must not cache this profile as
    // fully applied. Retain the error and throw it after the RTP mutation.
    trackProfileError = toError(error);
  }
  const scaleResolutionDownBy = getScreenShareScaleResolutionDownBy(
    profile,
    getTrackCaptureSize(producer.track),
  );
  const sender = producer.rtpSender;
  if (sender) {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    if (encodings.length > 0) {
      await setSenderParametersWithPreferences(
        sender,
        {
          ...parameters,
          encodings: encodings.map((encoding) => ({
            ...encoding,
            maxBitrate: cap.maxBitrate,
            maxFramerate: cap.maxFramerate,
            scaleResolutionDownBy,
          })),
        },
        {
          degradationPreference: SCREEN_SHARE_DEGRADATION_PREFERENCE,
          priority: SCREEN_SHARE_RTP_PRIORITY,
        },
      );
      if (trackProfileError) throw trackProfileError;
      return;
    }
  }

  await producer.setRtpEncodingParameters({
    maxBitrate: cap.maxBitrate,
    maxFramerate: cap.maxFramerate,
    scaleResolutionDownBy,
  });
  if (trackProfileError) throw trackProfileError;
}

export async function applyScreenShareTrackNetworkProfile(
  track: MediaStreamTrack | null | undefined,
  profile: WebcamProducerNetworkProfile,
): Promise<void> {
  if (!track || track.readyState !== "live") return;

  const constraints = buildScreenShareVideoConstraintsForNetworkProfile(
    profile,
  );
  let constraintError: Error | null = null;

  try {
    await track.applyConstraints({
      frameRate: constraints.frameRate,
    });
  } catch (error) {
    constraintError = toError(error);
    if (profile !== "good") {
      console.debug(
        "[Meets] Screen-share capture frame-rate cap was not applied:",
        error,
      );
    }
  }

  if (track.readyState !== "live") {
    throw (
      constraintError ??
      new Error("Screen-share track ended while applying capture constraints")
    );
  }

  const dimensionConstraints: MediaTrackConstraints = {
    frameRate: constraints.frameRate,
    width: constraints.width,
    height: constraints.height,
  };

  try {
    await track.applyConstraints(dimensionConstraints);
    // This full constraint set includes frameRate, so it supersedes a failed
    // frame-rate-only attempt when the browser accepts the combined request.
    constraintError = null;
  } catch (error) {
    constraintError ??= toError(error);
    console.debug(
      "[Meets] Screen-share capture dimension cap was not applied:",
      error,
    );
  }
  if (constraintError) throw constraintError;
}

function buildScreenShareEncodingForNetworkProfile(
  profile: WebcamProducerNetworkProfile,
  track?: MediaStreamTrack | null,
): ScreenShareEncoding {
  const base = buildScreenShareEncoding();
  const cap = SCREEN_SHARE_CAPS[profile];
  const scaleResolutionDownBy = getScreenShareScaleResolutionDownBy(
    profile,
    getTrackCaptureSize(track),
  );
  return {
    ...base,
    maxBitrate: Math.min(base.maxBitrate, cap.maxBitrate),
    maxFramerate: Math.min(base.maxFramerate, cap.maxFramerate),
    scaleResolutionDownBy,
  };
}

const withoutScreenShareScalabilityMode = (
  encoding: ScreenShareEncoding,
): FallbackScreenShareEncoding => {
  const { scalabilityMode: _scalabilityMode, ...fallbackEncoding } = encoding;
  return fallbackEncoding;
};

export async function produceScreenShareTrack({
  transport,
  track,
  networkProfile,
  preferredCodec,
}: ProduceScreenShareTrackOptions): Promise<Producer> {
  const encoding = buildScreenShareEncodingForNetworkProfile(
    networkProfile,
    track,
  );
  const buildOptions = (
    nextEncoding: ScreenShareEncoding | FallbackScreenShareEncoding,
    codec: RtpCodecCapability | undefined,
  ) => ({
    track,
    encodings: [nextEncoding],
    stopTracks: false,
    ...(codec ? { codec } : {}),
    appData: {
      type: "screen" as ProducerType,
      networkProfile,
    } satisfies ScreenProducerAppData,
  });

  try {
    return await transport.produce(buildOptions(encoding, preferredCodec));
  } catch (primaryError) {
    if (!preferredCodec) {
      console.warn(
        "[Meets] Screen-share temporal scalability produce failed, retrying without scalability mode:",
        primaryError,
      );
      return transport.produce(
        buildOptions(withoutScreenShareScalabilityMode(encoding), undefined),
      );
    }

    console.warn(
      "[Meets] Preferred screen-share codec with temporal scalability failed, retrying the same codec without scalability mode:",
      primaryError,
    );
  }

  try {
    return await transport.produce(
      buildOptions(
        withoutScreenShareScalabilityMode(encoding),
        preferredCodec,
      ),
    );
  } catch (preferredCodecError) {
    console.warn(
      "[Meets] Preferred screen-share codec failed without temporal scalability, retrying router default codec:",
      preferredCodecError,
    );
  }

  try {
    return await transport.produce(buildOptions(encoding, undefined));
  } catch (defaultCodecError) {
    console.warn(
      "[Meets] Screen-share temporal scalability produce failed on router default codec, retrying without scalability mode:",
      defaultCodecError,
    );
  }

  return transport.produce(
    buildOptions(withoutScreenShareScalabilityMode(encoding), undefined),
  );
}

/**
 * Publishes a processed webcam track and, for ordinary publications, retries
 * the raw camera when the processed track is rejected. Receiver-capacity
 * transitions carry a one-use server nonce: once their first produce attempt
 * starts, no track fallback may reuse that authority, even when the first
 * acknowledgement is ambiguous.
 */
export async function produceWebcamTrackWithRawTrackFallback<T>({
  publishTrack,
  rawTrack,
  receiverCapacityTransition,
  produce,
  onProcessedTrackFailure,
  onTerminalFailure,
}: {
  publishTrack: MediaStreamTrack;
  rawTrack: MediaStreamTrack;
  receiverCapacityTransition?: WebcamReceiverCapacityTransition;
  produce: (track: MediaStreamTrack) => Promise<T>;
  onProcessedTrackFailure?: (error: unknown) => void;
  onTerminalFailure?: (error: unknown) => unknown | Promise<unknown>;
}): Promise<T> {
  const reportTerminalFailure = async (error: unknown) => {
    try {
      await onTerminalFailure?.(error);
    } catch {}
  };

  try {
    return await produce(publishTrack);
  } catch (primaryError) {
    const canRetryRawTrack =
      !receiverCapacityTransition &&
      publishTrack.id !== rawTrack.id &&
      rawTrack.readyState === "live";
    if (!canRetryRawTrack) {
      await reportTerminalFailure(primaryError);
      throw primaryError;
    }

    onProcessedTrackFailure?.(primaryError);
    try {
      return await produce(rawTrack);
    } catch (fallbackError) {
      await reportTerminalFailure(fallbackError);
      throw fallbackError;
    }
  }
}

export async function produceWebcamTrack({
  transport,
  track,
  quality,
  networkProfile = "good",
  paused,
  preferredCodec,
  forceSingleLayer = false,
  forceSimulcast = false,
  receiverCapacityTransition,
  codecPolicy = null,
}: ProduceWebcamTrackOptions): Promise<Producer> {
  const captureSize = getTrackCaptureSize(track);
  const buildOptions = (
    encodings: ReturnType<typeof buildWebcamSimulcastEncodings> | [
      ReturnType<typeof buildWebcamSingleLayerEncoding>,
    ],
    codec: RtpCodecCapability | null = preferredCodec ?? null,
  ) => ({
    track,
    encodings: applyNetworkProfileToInitialWebcamEncodings(
      encodings,
      quality,
      networkProfile,
      captureSize,
    ),
    codecOptions: buildWebcamCodecOptions(quality, networkProfile),
    // The effects pipeline may replace the producer track with a processed
    // canvas track while continuing to read from the raw camera. mediasoup's
    // default stopTracks=true stops the previous track during replaceTrack().
    stopTracks: false,
    ...(codec ? { codec } : {}),
    appData: {
      type: "webcam" as ProducerType,
      paused,
      ...(receiverCapacityTransition
        ? {
            webcamReceiverCapacityTransition: {
              fromProducerId: receiverCapacityTransition.fromProducerId,
              nonce: receiverCapacityTransition.nonce,
            },
          }
        : {}),
    },
  });

  const finishProducer = async (producer: Producer): Promise<Producer> =>
    producer;

  if (codecPolicy?.codec === "vp9") {
    if (!preferredCodec) {
      throw new Error("Room requires VP9 profile 0, but the sender codec is unavailable");
    }
    const cap = getVp9SvcEncodingCap(quality, networkProfile);
    return finishProducer(
      await transport.produce({
        track,
        encodings: [
          {
            active: true,
            scalabilityMode: VP9_SVC_SCALABILITY_MODE,
            maxBitrate: cap.maxBitrate,
            maxFramerate: cap.maxFramerate,
          },
        ],
        codecOptions: buildWebcamCodecOptions(quality, networkProfile),
        stopTracks: false,
        codec: preferredCodec,
        appData: { type: "webcam" as ProducerType, paused },
      }),
    );
  }

  if (
    !forceSingleLayer &&
    (forceSimulcast || shouldUseWebcamSimulcast(preferredCodec))
  ) {
    try {
      return await finishProducer(
        await transport.produce(
          buildOptions(buildWebcamSimulcastEncodings(quality)),
        ),
      );
    } catch (simulcastError) {
      if (receiverCapacityTransition) throw simulcastError;
      console.warn(
        "[Meets] Webcam simulcast produce failed, retrying single-layer:",
        simulcastError,
      );
    }
  }

  try {
    return await finishProducer(
      await transport.produce(
        buildOptions([buildWebcamSingleLayerEncoding(quality)]),
      ),
    );
  } catch (codecError) {
    if (receiverCapacityTransition || !preferredCodec) {
      throw codecError;
    }

    console.warn(
      "[Meets] Preferred webcam codec failed, retrying router default codec:",
      codecError,
    );
  }

  return finishProducer(
    await transport.produce(
      buildOptions([buildWebcamSingleLayerEncoding(quality)], null),
    ),
  );
}

export async function applyWebcamProducerNetworkProfile(
  producer: Producer,
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
  options: { optimizeForSingleReceiver?: boolean } = {},
): Promise<void> {
  if (producer.kind !== "video" || producer.closed) return;

  // Never call producer.setMaxSpatialLayer() here. mediasoup-client implements
  // it by flipping RTCRtpEncodingParameters.active, which rebuilds Chromium's
  // encoder topology and creates the very freeze this live path must avoid.
  // Receiver preferences choose the forwarded RID; sender parameters below
  // only change bitrate/frame-rate caps on the fixed set of encoders.
  await applyWebcamEncodingCaps(
    producer,
    quality,
    profile,
    options.optimizeForSingleReceiver === true,
  );
}
