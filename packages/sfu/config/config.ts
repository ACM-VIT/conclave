import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined): boolean => {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
};

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
    allowHostJoin: true,
    useWaitingRoom: true,
    allowDisplayNameUpdate: false,
  },
  public: {
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
    const parsed = JSON.parse(value) as Record<string, Partial<ClientPolicy>>;
    const next: Record<string, ClientPolicy> = { ...defaultClientPolicies };
    for (const [key, policy] of Object.entries(parsed ?? {})) {
      if (!policy || typeof policy !== "object") continue;
      next[key] = { ...defaultClientPolicies.default, ...policy };
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

export const config = {
  port: toNumber(process.env.SFU_PORT || process.env.PORT, 3031),
  instanceId: process.env.SFU_INSTANCE_ID || `sfu-${process.pid}`,
  version: process.env.SFU_VERSION || "dev",
  draining: toBoolean(process.env.SFU_DRAINING),
  sfuSecret: process.env.SFU_SECRET || "development-secret",
  clientPolicies,
  workerSettings: {
    rtcMinPort: toNumber(process.env.RTC_MIN_PORT, 40000),
    rtcMaxPort: toNumber(process.env.RTC_MAX_PORT, 41000),
    logLevel: "warn" as WorkerLogLevel,
    logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as WorkerLogTag[],
  },
  videoQuality: {
    lowThreshold: Number(process.env.VIDEO_QUALITY_LOW_THRESHOLD) || 10,
    standardThreshold:
      Number(process.env.VIDEO_QUALITY_STANDARD_THRESHOLD) || 8,
  },
  adminCleanupTimeout: Number(process.env.ADMIN_CLEANUP_TIMEOUT) || 120000,
  socket: {
    pingIntervalMs: toNumber(
      process.env.SFU_SOCKET_PING_INTERVAL_MS,
      25000,
    ),
    pingTimeoutMs: toNumber(process.env.SFU_SOCKET_PING_TIMEOUT_MS, 60000),
    disconnectGraceMs: toNumber(
      process.env.SFU_SOCKET_DISCONNECT_GRACE_MS,
      15000,
    ),
    recoveryMaxDisconnectionMs: toNumber(
      process.env.SFU_SOCKET_RECOVERY_MAX_MS,
      30000,
    ),
  },
  routerMediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
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
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
      parameters: {},
    },
  ],
  webRtcTransport: {
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp,
      },
    ],
    maxIncomingBitrate: 1500000,
    initialAvailableOutgoingBitrate: 1000000,
  },
  plainTransport: {
    listenIp: process.env.PLAIN_TRANSPORT_LISTEN_IP || "0.0.0.0",
    announcedIp: plainTransportAnnouncedIp,
  },
};

export default config;
