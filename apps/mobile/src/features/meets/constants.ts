export const RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_ATTEMPTS = 8;
export const SOCKET_TIMEOUT_MS = 15000;
export const SOCKET_CONNECT_TIMEOUT_MS = 15000;
export const TRANSPORT_DISCONNECT_GRACE_MS = 5000;
export const PRODUCER_SYNC_INTERVAL_MS = 15000;
export const SPEAKER_CHECK_INTERVAL_MS = 250;
export const SPEAKER_THRESHOLD = 0.03;
export const ACTIVE_SPEAKER_HOLD_MS = 900;
export const REACTION_LIFETIME_MS = 3800;
export const MAX_REACTIONS = 30;
export const EMOJI_REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"] as const;

export const STANDARD_QUALITY_CONSTRAINTS = {
  width: { ideal: 1280, max: 1280 },
  height: { ideal: 720, max: 720 },
  frameRate: { ideal: 30, max: 30 },
};

export const LOW_QUALITY_CONSTRAINTS = {
  width: { ideal: 640, max: 640 },
  height: { ideal: 360, max: 360 },
  frameRate: { ideal: 20, max: 24 },
};

export const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 2 },
  sampleRate: { ideal: 48000 },
  sampleSize: { ideal: 16 },
};

export const STANDARD_VIDEO_MAX_BITRATE = 1200000;
export const LOW_VIDEO_MAX_BITRATE = 350000;
export const OPUS_MAX_AVERAGE_BITRATE = 64000;

const turnUrlsRaw =
  process.env.EXPO_PUBLIC_TURN_URLS ||
  process.env.EXPO_PUBLIC_TURN_URL ||
  process.env.NEXT_PUBLIC_TURN_URLS ||
  process.env.NEXT_PUBLIC_TURN_URL ||
  "";

export const MEETS_ICE_SERVERS: RTCIceServer[] = (() => {
  const urls = turnUrlsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!urls.length) return [];

  const iceServer: RTCIceServer = {
    urls: urls.length === 1 ? urls[0] : urls,
  };
  const username =
    process.env.EXPO_PUBLIC_TURN_USERNAME || process.env.NEXT_PUBLIC_TURN_USERNAME;
  const credential =
    process.env.EXPO_PUBLIC_TURN_PASSWORD || process.env.NEXT_PUBLIC_TURN_PASSWORD;

  if (username && credential) {
    iceServer.username = username;
    iceServer.credential = credential;
  }

  return [iceServer];
})();

export type ReactionEmoji = (typeof EMOJI_REACTIONS)[number];
