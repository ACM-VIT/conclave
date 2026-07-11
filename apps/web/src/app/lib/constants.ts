import type { ProducerCodecOptions } from "mediasoup-client/types";
import type { VideoQuality } from "./types";

export const RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_ATTEMPTS = 8;
export const SOCKET_TIMEOUT_MS = 15000;
export const SOCKET_CONNECT_TIMEOUT_MS = 15000;
export const TRANSPORT_DISCONNECT_GRACE_MS = 7000;
export const BACKGROUND_TRANSPORT_DISCONNECT_GRACE_MS = 18000;
export const PRODUCER_SYNC_INTERVAL_MS = 15000;
export const SPEAKER_CHECK_INTERVAL_MS = 250;
export const SPEAKER_THRESHOLD = 0.03;
// How long the last active speaker stays highlighted after they go quiet, so a
// natural pause doesn't drop + re-light the 2px orange border every check tick.
// Must be comfortably larger than SPEAKER_CHECK_INTERVAL_MS (250ms) or the
// highlight flickers between speakers (the old value of 50ms never lingered).
export const ACTIVE_SPEAKER_HOLD_MS = 1500;
export const REACTION_LIFETIME_MS = 3800;
export const MAX_REACTIONS = 30;
export const EMOJI_REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"] as const;

const STANDARD_QUALITY_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
};

const LOW_QUALITY_CONSTRAINTS = {
  width: { ideal: 640, max: 640 },
  height: { ideal: 360, max: 360 },
  frameRate: { ideal: 20, max: 20 },
};

const POOR_QUALITY_CONSTRAINTS = {
  width: { ideal: 426, max: 426 },
  height: { ideal: 240, max: 240 },
  frameRate: { ideal: 15, max: 15 },
};

const EMERGENCY_QUALITY_CONSTRAINTS = {
  width: { ideal: 320, max: 320 },
  height: { ideal: 180, max: 180 },
  frameRate: { ideal: 12, max: 12 },
};

export type CameraCaptureNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";

export const buildCameraVideoConstraints = (
  quality: VideoQuality,
  profile: CameraCaptureNetworkProfile = "good",
  deviceId?: string,
): MediaTrackConstraints => {
  const base =
    profile === "emergency"
      ? EMERGENCY_QUALITY_CONSTRAINTS
      : profile === "poor"
      ? POOR_QUALITY_CONSTRAINTS
      : quality === "low" || profile === "fair"
      ? LOW_QUALITY_CONSTRAINTS
      : STANDARD_QUALITY_CONSTRAINTS;

  return {
    ...base,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
};

export const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 },
};

export const STANDARD_VIDEO_MAX_BITRATE = 1500000;
export const LOW_VIDEO_MAX_BITRATE = 260000;
export const SCREEN_SHARE_MAX_BITRATE = 2500000;
export const SCREEN_SHARE_MAX_FRAMERATE = 24;
const OPUS_MAX_AVERAGE_BITRATE = 96000;
const SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE = 96000;
export type AudioProducerNetworkProfile =
  | "good"
  | "fair"
  | "poor"
  | "emergency";
export const MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE: Record<
  AudioProducerNetworkProfile,
  number
> = {
  good: OPUS_MAX_AVERAGE_BITRATE,
  fair: 48000,
  poor: 32000,
  emergency: 24000,
};
export const SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE: Record<
  AudioProducerNetworkProfile,
  number
> = {
  good: SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE,
  // Keep bundled audio m-lines codec-identical per profile. Chrome treats the
  // same Opus payload type with different fmtp parameters as a BUNDLE collision.
  fair: MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE.fair,
  poor: MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE.poor,
  emergency: MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE.emergency,
};
const OPUS_PACKET_TIME_MS = 20;
export const buildMicrophoneOpusCodecOptions = (
  profile: AudioProducerNetworkProfile = "good",
): ProducerCodecOptions => ({
  opusStereo: false,
  opusFec: true,
  opusDtx: true,
  opusNack: true,
  opusMaxAverageBitrate:
    MICROPHONE_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE[profile],
  opusPtime: OPUS_PACKET_TIME_MS,
});
export const buildScreenShareAudioOpusCodecOptions = (
  profile: AudioProducerNetworkProfile = "good",
): ProducerCodecOptions => ({
  opusStereo: false,
  opusFec: true,
  opusDtx: true,
  opusNack: true,
  opusMaxAverageBitrate:
    SCREEN_AUDIO_OPUS_MAX_AVERAGE_BITRATE_BY_PROFILE[profile],
  opusPtime: OPUS_PACKET_TIME_MS,
});
const DEFAULT_PUBLIC_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
];

const splitIceUrls = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const MEETS_STUN_ICE_SERVERS: RTCIceServer[] = (() => {
  const configuredStunUrls = splitIceUrls(
    process.env.NEXT_PUBLIC_STUN_URLS ?? process.env.NEXT_PUBLIC_STUN_URL ?? "",
  );
  const urls =
    configuredStunUrls.length > 0 ? configuredStunUrls : DEFAULT_PUBLIC_STUN_URLS;

  return [
    {
      urls: urls.length === 1 ? urls[0] : urls,
    },
  ];
})();

export const MEETS_ICE_SERVERS = MEETS_STUN_ICE_SERVERS;

export type ReactionEmoji = (typeof EMOJI_REACTIONS)[number];
