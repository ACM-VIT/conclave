//dont addd thisss

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
};

const defaultClientPolicies: Record<string, ClientPolicy> = {
  default: {
    allowNonHostRoomCreation: false,
    allowHostJoin: true,
    useWaitingRoom: true,
  },
  public: {
    allowNonHostRoomCreation: false,
    allowHostJoin: false,
    useWaitingRoom: true,
  },
  internal: {
    allowNonHostRoomCreation: false,
    allowHostJoin: true,
    useWaitingRoom: true,
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
        announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1",
      },
    ],
    maxIncomingBitrate: 1500000,
    initialAvailableOutgoingBitrate: 1000000,
  },
  plainTransport: {
    listenIp: process.env.PLAIN_TRANSPORT_LISTEN_IP || "0.0.0.0",
    announcedIp:
      process.env.PLAIN_TRANSPORT_ANNOUNCED_IP ||
      process.env.ANNOUNCED_IP ||
      "127.0.0.1",
  },
};

export default config;
