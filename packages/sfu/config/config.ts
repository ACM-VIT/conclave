import dotenv from "dotenv";
import path from "path";
import { existsSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import type { RouterRtpCodecCapability } from "mediasoup/types";
import { resolveConfiguredSfuRegion } from "../server/regions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sfuPackageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(sfuPackageRoot, "..", "..");
const webAppRoot = path.resolve(repoRoot, "apps", "web");

// First match wins (dotenv default does not override existing process.env vars).
// Order: most-specific (sfu package) -> shared web app (matches Next.js) -> repo root.
// This keeps local dev in sync without forcing the user to maintain duplicate secrets.
const envCandidates = [
  path.join(sfuPackageRoot, ".env.local"),
  path.join(sfuPackageRoot, ".env"),
  path.join(webAppRoot, ".env.local"),
  path.join(webAppRoot, ".env"),
  path.join(repoRoot, ".env.local"),
  path.join(repoRoot, ".env"),
];

const initialSecretFromProcess = process.env.SFU_SECRET;
const loadedEnvFiles: string[] = [];
let secretSource: string = initialSecretFromProcess
  ? "process.env (set before SFU bootstrap)"
  : "fallback literal";

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    const beforeSecret = process.env.SFU_SECRET;
    dotenv.config({ path: envPath });
    loadedEnvFiles.push(envPath);
    if (!beforeSecret && process.env.SFU_SECRET) {
      secretSource = envPath;
    }
  }
}

const sfuSecret = resolveSfuSecret();
const sfuSecretFingerprint = (() => {
  const value = sfuSecret;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
})();
// Hidden/mobile browsers can suspend socket timers while WebRTC media is still
// viable. Keep producers warm long enough for low-bandwidth recovery by default.
const BACKGROUND_SOCKET_RECOVERY_WINDOW_MS = 120000;

// The current maximum publish profile is 4.642 Mbps before transport overhead:
// 1.95 Mbps webcam simulcast + 2.5 Mbps screen + two 96 kbps Opus tracks.
// 6 Mbps leaves roughly 29% for RTP/RTCP/UDP/DTLS overhead and estimator
// variance without silently clipping a healthy camera + screen-share session.
export const DEFAULT_PRODUCER_MAX_INCOMING_BITRATE_BPS = 6_000_000;
const MIN_CONFIGURED_WEBRTC_BITRATE_BPS = 128_000;
const MAX_CONFIGURED_WEBRTC_BITRATE_BPS = 100_000_000;

if (process.env.SFU_DEBUG_SECRET !== "0") {
  console.log(
    `[SFU env] loaded ${loadedEnvFiles.length} file(s); SFU_SECRET source: ${secretSource}; fingerprint: ${sfuSecretFingerprint}`,
  );
}

type NumberOptions = {
  integer?: boolean;
  min?: number;
  max?: number;
};

const toNumber = (
  value: string | undefined,
  fallback: number,
  options: NumberOptions = {},
): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (options.integer && !Number.isInteger(parsed)) ||
    (typeof options.min === "number" && parsed < options.min) ||
    (typeof options.max === "number" && parsed > options.max)
  ) {
    return fallback;
  }
  return parsed;
};

const toBoolean = (value: string | undefined): boolean => {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
};

export const resolveWebRtcTransportProtocolPolicy = (
  environment: {
    SFU_WEBRTC_ENABLE_UDP?: string;
    SFU_WEBRTC_ENABLE_TCP?: string;
    SFU_WEBRTC_PREFER_UDP?: string;
  } = process.env,
) => {
  const withDefault = (value: string | undefined, fallback: boolean) =>
    value == null || value.trim() === "" ? fallback : toBoolean(value);
  const enableUdp = withDefault(environment.SFU_WEBRTC_ENABLE_UDP, true);
  const enableTcp = withDefault(environment.SFU_WEBRTC_ENABLE_TCP, true);
  if (!enableUdp && !enableTcp) {
    throw new Error(
      "At least one of SFU_WEBRTC_ENABLE_UDP or SFU_WEBRTC_ENABLE_TCP must be enabled.",
    );
  }
  return Object.freeze({
    enableUdp,
    enableTcp,
    preferUdp:
      enableUdp &&
      withDefault(environment.SFU_WEBRTC_PREFER_UDP, true),
  });
};

function resolveSfuSecret(): string {
  const configured = process.env.SFU_SECRET?.trim();
  if (configured && configured !== "development-secret") {
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SFU_SECRET must be set to a non-default value when NODE_ENV=production.",
    );
  }

  return configured || "development-secret";
}

type WorkerLogLevel = "debug" | "warn" | "error" | "none";

type WorkerLogTag =
  | "info"
  | "ice"
  | "dtls"
  | "rtp"
  | "srtp"
  | "rtcp"
  | "rtx"
  | "bwe"
  | "score"
  | "simulcast"
  | "svc"
  | "sctp"
  | "message";

type ClientPolicy = {
  allowNonHostRoomCreation: boolean;
  allowHostJoin: boolean;
  useWaitingRoom: boolean;
  allowDisplayNameUpdate: boolean;
};

const defaultClientPolicies: Record<string, ClientPolicy> = {
  default: {
    allowNonHostRoomCreation: false,
    // Public/default/conclave share the same policy; a bare `isHost` claim
    // still must not grant admin of an existing room.
    allowHostJoin: false,
    useWaitingRoom: false,
    allowDisplayNameUpdate: true,
  },
  public: {
    allowNonHostRoomCreation: false,
    allowHostJoin: false,
    useWaitingRoom: false,
    allowDisplayNameUpdate: true,
  },
  conclave: {
    allowNonHostRoomCreation: false,
    allowHostJoin: false,
    useWaitingRoom: false,
    allowDisplayNameUpdate: true,
  },
  internal: {
    allowNonHostRoomCreation: false,
    allowHostJoin: true,
    useWaitingRoom: true,
    allowDisplayNameUpdate: false,
  },
};

const normalizeClientPolicies = (
  value: string | undefined,
): Record<string, ClientPolicy> => {
  if (!value) return defaultClientPolicies;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultClientPolicies;
    }

    const next: Record<string, ClientPolicy> = { ...defaultClientPolicies };
    for (const [key, policy] of Object.entries(parsed)) {
      if (!policy || typeof policy !== "object") continue;
      const policyInput = policy as Record<string, unknown>;
      const base = next[key] ?? defaultClientPolicies.default;
      next[key] = {
        allowNonHostRoomCreation:
          typeof policyInput.allowNonHostRoomCreation === "boolean"
            ? policyInput.allowNonHostRoomCreation
            : base.allowNonHostRoomCreation,
        allowHostJoin:
          typeof policyInput.allowHostJoin === "boolean"
            ? policyInput.allowHostJoin
            : base.allowHostJoin,
        useWaitingRoom:
          typeof policyInput.useWaitingRoom === "boolean"
            ? policyInput.useWaitingRoom
            : base.useWaitingRoom,
        allowDisplayNameUpdate:
          typeof policyInput.allowDisplayNameUpdate === "boolean"
            ? policyInput.allowDisplayNameUpdate
            : base.allowDisplayNameUpdate,
      };
    }
    return next;
  } catch (_error) {
    return defaultClientPolicies;
  }
};

const clientPolicies = normalizeClientPolicies(
  process.env.SFU_CLIENT_POLICIES,
);

const resolveAnnouncedIp = (): string => {
  const announcedIp = process.env.ANNOUNCED_IP?.trim();
  if (announcedIp) return announcedIp;

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[SFU] ANNOUNCED_IP is not set. Falling back to 127.0.0.1, which is not reachable for remote clients.",
    );
  }

  return "127.0.0.1";
};

const announcedIp = resolveAnnouncedIp();
const plainTransportAnnouncedIp =
  process.env.PLAIN_TRANSPORT_ANNOUNCED_IP?.trim() || announcedIp;
const socketRedisUrl =
  process.env.SFU_REDIS_URL?.trim() || process.env.REDIS_URL?.trim() || "";
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() || "";
const requireRedisAdapter = toBoolean(process.env.SFU_REQUIRE_REDIS_ADAPTER);
if (requireRedisAdapter && !socketRedisUrl) {
  throw new Error(
    "SFU_REQUIRE_REDIS_ADAPTER=1 requires SFU_REDIS_URL or REDIS_URL.",
  );
}
const gameAiDisabled =
  process.env.SFU_GAME_AI_ENABLED === "0" ||
  process.env.SFU_GAME_AI_ENABLED?.toLowerCase() === "false";
const gameAiWebSearchDisabled =
  process.env.SFU_GAME_AI_WEB_SEARCH_ENABLED === "0" ||
  process.env.SFU_GAME_AI_WEB_SEARCH_ENABLED?.toLowerCase() === "false";
const gameAiWebSearchContextSize = ((): "low" | "medium" | "high" => {
  const configured = process.env.SFU_GAME_AI_WEB_SEARCH_CONTEXT_SIZE?.trim();
  return configured === "medium" || configured === "high" ? configured : "low";
})();
const transcriptRelayDisabled =
  process.env.SFU_TRANSCRIPT_RELAY_ENABLED === "0" ||
  process.env.SFU_TRANSCRIPT_RELAY_ENABLED?.toLowerCase() === "false";
// Product analytics (PostHog). Strictly opt-in: with no project key set, the
// block is `enabled: false`, no client is ever constructed, and nothing is
// sent (zero overhead). Never hardcode a key — it comes from the environment.
const posthogProjectApiKey =
  process.env.SFU_POSTHOG_KEY?.trim() ||
  process.env.SFU_POSTHOG_PROJECT_API_KEY?.trim() ||
  "";
const posthogDisabled =
  process.env.SFU_POSTHOG_ENABLED === "0" ||
  process.env.SFU_POSTHOG_ENABLED?.toLowerCase() === "false";
// Default to the PostHog EU cloud ingestion host (region-correct for this
// deployment). Override with SFU_POSTHOG_HOST for self-hosted / US cloud.
const posthogHost =
  process.env.SFU_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com";
const instancePublicUrl =
  process.env.SFU_PUBLIC_URL?.trim() ||
  process.env.SFU_INSTANCE_URL?.trim() ||
  process.env.SFU_URL?.trim() ||
  "";
const rtcMinPort = toNumber(process.env.RTC_MIN_PORT, 40000, {
  integer: true,
  min: 1,
  max: 65535,
});
const parsedRtcMaxPort = toNumber(process.env.RTC_MAX_PORT, 49999, {
  integer: true,
  min: 1,
  max: 65535,
});
const rtcMaxPort = parsedRtcMaxPort >= rtcMinPort ? parsedRtcMaxPort : rtcMinPort;
if (parsedRtcMaxPort < rtcMinPort) {
  console.warn("[SFU] RTC_MAX_PORT is lower than RTC_MIN_PORT; using a single-port range.");
}
const webRtcTransportProtocolPolicy =
  resolveWebRtcTransportProtocolPolicy();

const routerMediaCodecs: RouterRtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    rtcpFeedback: [{ type: "nack" }, { type: "transport-cc" }],
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {},
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: { "profile-id": 0 },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
      { type: "transport-cc" },
    ],
  },
];

export const config = {
  port: toNumber(process.env.SFU_PORT || process.env.PORT, 3031, {
    integer: true,
    min: 1,
    max: 65535,
  }),
  instanceId: process.env.SFU_INSTANCE_ID || `sfu-${process.pid}`,
  instancePublicUrl,
  region: resolveConfiguredSfuRegion(process.env.SFU_REGION),
  version: process.env.SFU_VERSION || "dev",
  draining: toBoolean(process.env.SFU_DRAINING),
  sfuSecret,
  clientPolicies,
  openAi: {
    apiKey: openAiApiKey,
    maxRetries: 2,
  },
  chatImageModeration: {
    timeoutMs: toNumber(process.env.SFU_IMAGE_MODERATION_TIMEOUT_MS, 8000, {
      integer: true,
      min: 1000,
      max: 30000,
    }),
  },
  gameAi: {
    enabled: !gameAiDisabled && Boolean(openAiApiKey),
    model: "gpt-5.6-luna",
    reasoningEffort: "low" as const,
    storeResponses: false,
    timeoutMs: toNumber(process.env.SFU_GAME_AI_TIMEOUT_MS, 25000, {
      integer: true,
      min: 500,
      max: 120000,
    }),
    maxOutputTokens: toNumber(process.env.SFU_GAME_AI_MAX_OUTPUT_TOKENS, 2200, {
      integer: true,
      min: 128,
      max: 4096,
    }),
    topicMaxLength: toNumber(process.env.SFU_GAME_AI_TOPIC_MAX_LENGTH, 120, {
      integer: true,
      min: 1,
      max: 500,
    }),
    webSearchEnabled: !gameAiWebSearchDisabled,
    webSearchContextSize: gameAiWebSearchContextSize,
  },
  analytics: {
    // Enabled ONLY when a project key is present (and not explicitly disabled).
    // When false, the analytics module constructs nothing and sends nothing.
    enabled: !posthogDisabled && Boolean(posthogProjectApiKey),
    projectApiKey: posthogProjectApiKey,
    host: posthogHost,
    // Batch tuning. A game meeting is long-lived and low-volume, so flush on a
    // small batch or a short interval to keep events fresh without chattiness.
    flushAt: toNumber(process.env.SFU_POSTHOG_FLUSH_AT, 20, {
      integer: true,
      min: 1,
      max: 1000,
    }),
    flushIntervalMs: toNumber(process.env.SFU_POSTHOG_FLUSH_INTERVAL_MS, 10000, {
      integer: true,
      min: 0,
      max: 300000,
    }),
    // Bounded time to flush buffered events on graceful shutdown.
    shutdownTimeoutMs: toNumber(
      process.env.SFU_POSTHOG_SHUTDOWN_TIMEOUT_MS,
      5000,
      { integer: true, min: 0, max: 60000 },
    ),
  },
  transcriptRelay: {
    enabled: !transcriptRelayDisabled,
  },
  workerSettings: {
    workerCount: toNumber(process.env.SFU_WORKER_COUNT, 0, {
      integer: true,
      min: 0,
    }),
    rtcMinPort,
    rtcMaxPort,
    logLevel: "warn" as WorkerLogLevel,
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as WorkerLogTag[],
  },
  videoQuality: {
    lowThreshold: toNumber(process.env.VIDEO_QUALITY_LOW_THRESHOLD, 1000, {
      min: 1,
    }),
    standardThreshold: toNumber(
      process.env.VIDEO_QUALITY_STANDARD_THRESHOLD,
      900,
      { min: 1 },
    ),
  },
  adminCleanupTimeout: toNumber(process.env.ADMIN_CLEANUP_TIMEOUT, 120000, {
    min: 1000,
  }),
  socket: {
    pingIntervalMs: toNumber(
      process.env.SFU_SOCKET_PING_INTERVAL_MS,
      25000,
      { min: 1000 },
    ),
    pingTimeoutMs: toNumber(process.env.SFU_SOCKET_PING_TIMEOUT_MS, 60000, {
      min: 1000,
    }),
    disconnectGraceMs: toNumber(
      process.env.SFU_SOCKET_DISCONNECT_GRACE_MS,
      BACKGROUND_SOCKET_RECOVERY_WINDOW_MS,
      { min: 0 },
    ),
    recoveryMaxDisconnectionMs: toNumber(
      process.env.SFU_SOCKET_RECOVERY_MAX_MS,
      BACKGROUND_SOCKET_RECOVERY_WINDOW_MS,
      { min: 0 },
    ),
    redisUrl: socketRedisUrl,
    redisConnectTimeoutMs: toNumber(
      process.env.SFU_REDIS_CONNECT_TIMEOUT_MS,
      5000,
      { min: 100 },
    ),
    requireRedisAdapter,
  },
  roomRegistry: {
    ttlMs: toNumber(process.env.SFU_ROOM_REGISTRY_TTL_MS, 45000, {
      integer: true,
      min: 5000,
    }),
    renewIntervalMs: toNumber(
      process.env.SFU_ROOM_REGISTRY_RENEW_INTERVAL_MS,
      15000,
      { integer: true, min: 1000 },
    ),
    keyPrefix:
      process.env.SFU_ROOM_REGISTRY_KEY_PREFIX?.trim() ||
      "conclave:sfu:rooms",
  },
  routerMediaCodecs,
  webRtcTransport: {
    ...webRtcTransportProtocolPolicy,
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp,
      },
    ],
    producerMaxIncomingBitrate: toNumber(
      process.env.SFU_WEBRTC_MAX_INCOMING_BITRATE,
      DEFAULT_PRODUCER_MAX_INCOMING_BITRATE_BPS,
      {
        integer: true,
        min: MIN_CONFIGURED_WEBRTC_BITRATE_BPS,
        max: MAX_CONFIGURED_WEBRTC_BITRATE_BPS,
      },
    ),
    initialAvailableOutgoingBitrate: toNumber(
      process.env.SFU_WEBRTC_INITIAL_OUTGOING_BITRATE,
      4_000_000,
      {
        integer: true,
        min: MIN_CONFIGURED_WEBRTC_BITRATE_BPS,
        max: MAX_CONFIGURED_WEBRTC_BITRATE_BPS,
      },
    ),
  },
  plainTransport: {
    listenIp: process.env.PLAIN_TRANSPORT_LISTEN_IP || "0.0.0.0",
    announcedIp: plainTransportAnnouncedIp,
  },
};
