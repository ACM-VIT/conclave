import type { Device, RtpCodecCapability } from "mediasoup-client/types";
import type { Producer, ProducerType, Transport, VideoQuality } from "./types";
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
  if (!isLikelyHardwareAcceleratedH264Browser()) return true;
  if (!preferredCodec || isPreferredVideoCodec(preferredCodec, "video/H264")) {
    return false;
  }
  return true;
};

export const getPreferredWebcamCodec = (
  device: Pick<Device, "rtpCapabilities"> | null | undefined,
): RtpCodecCapability | undefined => {
  const codecs = device?.rtpCapabilities?.codecs ?? [];

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
  device: Pick<Device, "rtpCapabilities"> | null | undefined,
  currentCodec?: RtpCodecCapability,
): RtpCodecCapability | undefined => {
  const codecs = device?.rtpCapabilities?.codecs ?? [];
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
  device: Pick<Device, "rtpCapabilities"> | null | undefined,
): RtpCodecCapability | undefined => {
  const codecs = device?.rtpCapabilities?.codecs ?? [];

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
const SCREEN_SHARE_DEGRADATION_PREFERENCE: RTCDegradationPreference =
  "maintain-resolution";
const AUDIO_RTP_PRIORITY: RTCPriorityType = "high";
const SCREEN_SHARE_RTP_PRIORITY: RTCPriorityType = "high";
const WEBRTC_ENCODING_ORDER = ["q", "h", "f"] as const;
const MIN_CRISP_BASE_LAYER_WIDTH = 300;
const MIN_CRISP_BASE_LAYER_HEIGHT = 160;
const LOW_BANDWIDTH_BASE_LAYER_TARGETS: Record<
  Extract<WebcamProducerNetworkProfile, "poor" | "emergency">,
  { width: number; height: number }
> = {
  poor: { width: 426, height: 240 },
  emergency: { width: 320, height: 180 },
};
const FAIR_BANDWIDTH_ACTIVE_LAYER_TARGET = { width: 640, height: 360 };

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

const getTargetSpatialLayer = (
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): number => {
  if (profile === "poor" || profile === "emergency") return 0;
  if (profile === "fair") return 1;
  return quality === "low" ? 1 : 2;
};

const getProfileAdjustedScaleResolutionDownBy = (
  current: number | undefined,
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
): number | undefined => {
  if (layerRank !== 0) return current;
  if (profile !== "poor" && profile !== "emergency") return current;

  return current;
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
  const profileAdjusted = getProfileAdjustedScaleResolutionDownBy(
    current,
    profile,
    layerRank,
  );
  if (layerRank !== 0 || typeof profileAdjusted !== "number") {
    if (layerRank === 0 && (profile === "poor" || profile === "emergency")) {
      return (
        getCaptureScaleForTarget(
          captureSize,
          LOW_BANDWIDTH_BASE_LAYER_TARGETS[profile],
        ) ?? profileAdjusted
      );
    }
    return profileAdjusted;
  }
  if (profile === "poor" || profile === "emergency") {
    const targetScale = getCaptureScaleForTarget(
      captureSize,
      LOW_BANDWIDTH_BASE_LAYER_TARGETS[profile],
    );
    return targetScale === null
      ? profileAdjusted
      : Math.max(profileAdjusted, targetScale);
  }
  if (profile === "fair" && layerRank <= 1) {
    const targetScale = getCaptureScaleForTarget(
      captureSize,
      FAIR_BANDWIDTH_ACTIVE_LAYER_TARGET,
    );
    return targetScale === null
      ? profileAdjusted
      : Math.max(profileAdjusted, targetScale);
  }

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
    return profileAdjusted;
  }

  return Math.min(profileAdjusted, Math.max(1, Number(maxCrispScale.toFixed(1))));
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

const shouldSendWebcamEncoding = (
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
  layerRank: number,
): boolean => {
  if (profile === "good") return true;
  return layerRank <= getTargetSpatialLayer(quality, profile);
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
    const adjusted = getProfileAdjustedCap(
      {
        maxBitrate: encoding.maxBitrate,
        maxFramerate: encoding.maxFramerate,
      },
      quality,
      profile,
      layerRank,
    );
    return {
      ...encoding,
      active: shouldSendWebcamEncoding(quality, profile, layerRank),
      ...("scaleResolutionDownBy" in encoding
        ? {
            scaleResolutionDownBy: getCaptureAdjustedScaleResolutionDownBy(
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

const hasMultipleSpatialLayers = (producer: Producer): boolean => {
  const senderEncodings = producer.rtpSender?.getParameters().encodings;
  if (senderEncodings && senderEncodings.length > 1) return true;
  return (producer.rtpParameters.encodings ?? []).length > 1;
};

const applyWebcamEncodingCaps = async (
  producer: Producer,
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): Promise<void> => {
  const sender = producer.rtpSender;
  if (sender) {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    if (encodings.length > 0) {
      const captureSize = getTrackCaptureSize(producer.track);
      const baseCaps = getBaseEncodingCaps(quality, encodings.length);
      const layerRanks = getEncodingRanks(encodings);
      const nextEncodings = encodings.map((encoding, index) => {
        const layerRank = layerRanks[index] ?? index;
        const base = baseCaps[layerRank] ?? baseCaps[index] ?? baseCaps[0];
        const adjusted = getProfileAdjustedCap(
          base,
          quality,
          profile,
          layerRank,
        );
        return {
          ...encoding,
          active: shouldSendWebcamEncoding(quality, profile, layerRank),
          maxBitrate: adjusted.maxBitrate,
          maxFramerate: adjusted.maxFramerate,
          scaleResolutionDownBy: getCaptureAdjustedScaleResolutionDownBy(
            encoding.scaleResolutionDownBy,
            profile,
            layerRank,
            captureSize,
          ),
          ...(index === 0
            ? {
                priority: getWebcamRtpPriority(profile, layerRank),
                networkPriority: getWebcamRtpPriority(profile, layerRank),
              }
            : {}),
        };
      });
      await setSenderParametersWithPreferences(
        sender,
        { ...parameters, encodings: nextEncodings },
        { degradationPreference: WEBCAM_DEGRADATION_PREFERENCE },
      );
      return;
    }
  }

  const [base] = getBaseEncodingCaps(quality, 1);
  const adjusted = getProfileAdjustedCap(base, quality, profile, 0);
  const captureSize = getTrackCaptureSize(producer.track);
  const fallbackScaleResolutionDownBy = getCaptureAdjustedScaleResolutionDownBy(
    undefined,
    profile,
    0,
    captureSize,
  );
  await producer.setRtpEncodingParameters({
    maxBitrate: adjusted.maxBitrate,
    maxFramerate: adjusted.maxFramerate,
    ...(typeof fallbackScaleResolutionDownBy === "number"
      ? { scaleResolutionDownBy: fallbackScaleResolutionDownBy }
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
  await applyScreenShareTrackNetworkProfile(producer.track, profile);
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
      return;
    }
  }

  await producer.setRtpEncodingParameters({
    maxBitrate: cap.maxBitrate,
    maxFramerate: cap.maxFramerate,
    scaleResolutionDownBy,
  });
}

export async function applyScreenShareTrackNetworkProfile(
  track: MediaStreamTrack | null | undefined,
  profile: WebcamProducerNetworkProfile,
): Promise<void> {
  if (!track || track.readyState !== "live") return;

  const constraints = buildScreenShareVideoConstraintsForNetworkProfile(
    profile,
  );

  try {
    await track.applyConstraints({
      frameRate: constraints.frameRate,
    });
  } catch (error) {
    if (profile !== "good") {
      console.debug(
        "[Meets] Screen-share capture frame-rate cap was not applied:",
        error,
      );
    }
  }

  if (track.readyState !== "live") return;

  const dimensionConstraints: MediaTrackConstraints = {
    frameRate: constraints.frameRate,
    width: constraints.width,
    height: constraints.height,
  };

  try {
    await track.applyConstraints(dimensionConstraints);
  } catch (error) {
    console.debug(
      "[Meets] Screen-share capture dimension cap was not applied:",
      error,
    );
  }
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
      "[Meets] Preferred screen-share codec failed, retrying router default codec:",
      primaryError,
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

export async function produceWebcamTrack({
  transport,
  track,
  quality,
  networkProfile = "good",
  paused,
  preferredCodec,
  forceSingleLayer = false,
}: ProduceWebcamTrackOptions): Promise<Producer> {
  const captureSize = getTrackCaptureSize(track);
  const buildOptions = (
    encodings: ReturnType<typeof buildWebcamSimulcastEncodings> | [
      ReturnType<typeof buildWebcamSingleLayerEncoding>,
    ],
    codec = preferredCodec,
  ) => ({
    track,
    encodings: applyNetworkProfileToInitialWebcamEncodings(
      encodings,
      quality,
      networkProfile,
      captureSize,
    ),
    // The effects pipeline may replace the producer track with a processed
    // canvas track while continuing to read from the raw camera. mediasoup's
    // default stopTracks=true stops the previous track during replaceTrack().
    stopTracks: false,
    ...(codec ? { codec } : {}),
    appData: { type: "webcam" as ProducerType, paused },
  });

  const finishProducer = async (producer: Producer): Promise<Producer> => {
    if (networkProfile !== "good" && hasMultipleSpatialLayers(producer)) {
      try {
        await producer.setMaxSpatialLayer(
          getTargetSpatialLayer(quality, networkProfile),
        );
      } catch {}
    }
    return producer;
  };

  if (!forceSingleLayer && shouldUseWebcamSimulcast(preferredCodec)) {
    try {
      return await finishProducer(
        await transport.produce(
          buildOptions(buildWebcamSimulcastEncodings(quality)),
        ),
      );
    } catch (simulcastError) {
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
    if (!preferredCodec) {
      throw codecError;
    }

    console.warn(
      "[Meets] Preferred webcam codec failed, retrying router default codec:",
      codecError,
    );
  }

  return finishProducer(
    await transport.produce(
      buildOptions([buildWebcamSingleLayerEncoding(quality)], undefined),
    ),
  );
}

export async function applyWebcamProducerNetworkProfile(
  producer: Producer,
  quality: VideoQuality,
  profile: WebcamProducerNetworkProfile,
): Promise<void> {
  if (producer.kind !== "video" || producer.closed) return;

  if (hasMultipleSpatialLayers(producer)) {
    const targetSpatialLayer = getTargetSpatialLayer(quality, profile);
    try {
      await producer.setMaxSpatialLayer(targetSpatialLayer);
    } catch (error) {
      if (profile === "good" && quality === "standard") {
        return;
      }
      try {
        await producer.setMaxSpatialLayer(0);
      } catch {
        console.warn("[Meets] Webcam spatial-layer cap failed:", error);
      }
    }
  }

  try {
    await applyWebcamEncodingCaps(producer, quality, profile);
  } catch (error) {
    console.warn("[Meets] Webcam bitrate cap failed:", error);
  }
}
