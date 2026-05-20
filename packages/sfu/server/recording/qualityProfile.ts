import { cpus, totalmem } from "node:os";
import { Logger } from "../../utilities/loggers.js";

export type RecordingProfile = {
  name: "low" | "standard" | "high" | "max";
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  maxConcurrentSessions: number;
};

const PROFILES: Record<RecordingProfile["name"], RecordingProfile> = {
  low: {
    name: "low",
    width: 1280,
    height: 720,
    fps: 24,
    videoBitrateKbps: 2_000,
    audioBitrateKbps: 96,
    maxConcurrentSessions: 1,
  },
  standard: {
    name: "standard",
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrateKbps: 3_500,
    audioBitrateKbps: 128,
    maxConcurrentSessions: 1,
  },
  high: {
    name: "high",
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrateKbps: 5_000,
    audioBitrateKbps: 128,
    maxConcurrentSessions: 2,
  },
  max: {
    name: "max",
    width: 1920,
    height: 1080,
    fps: 60,
    videoBitrateKbps: 9_000,
    audioBitrateKbps: 192,
    maxConcurrentSessions: 2,
  },
};

const clampInt = (
  raw: string | undefined,
  min: number,
  max: number,
): number | null => {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
};

const pickAutoProfile = (): RecordingProfile["name"] => {
  const vCpu = cpus()?.length ?? 1;
  const totalGiB = totalmem() / (1024 * 1024 * 1024);
  if (vCpu >= 4 && totalGiB >= 14) return "high";
  if (vCpu >= 2 && totalGiB >= 6) return "standard";
  return "low";
};

let cachedProfile: RecordingProfile | null = null;

export const resolveRecordingProfile = (): RecordingProfile => {
  if (cachedProfile) return cachedProfile;

  const requested = (process.env.RECORDER_PROFILE || "auto")
    .trim()
    .toLowerCase();
  const base =
    requested === "auto" || !(requested in PROFILES)
      ? PROFILES[pickAutoProfile()]
      : PROFILES[requested as RecordingProfile["name"]];

  const overridden: RecordingProfile = {
    ...base,
    width:
      clampInt(process.env.RECORDER_DEFAULT_WIDTH, 320, 3_840) ?? base.width,
    height:
      clampInt(process.env.RECORDER_DEFAULT_HEIGHT, 240, 2_160) ?? base.height,
    fps: clampInt(process.env.RECORDER_DEFAULT_FPS, 5, 60) ?? base.fps,
    videoBitrateKbps:
      clampInt(
        process.env.RECORDER_DEFAULT_VIDEO_BITRATE_KBPS,
        300,
        25_000,
      ) ?? base.videoBitrateKbps,
    audioBitrateKbps:
      clampInt(
        process.env.RECORDER_DEFAULT_AUDIO_BITRATE_KBPS,
        32,
        320,
      ) ?? base.audioBitrateKbps,
    maxConcurrentSessions:
      clampInt(process.env.RECORDER_MAX_CONCURRENT_SESSIONS, 1, 8) ??
      base.maxConcurrentSessions,
  };

  const vCpu = cpus()?.length ?? 0;
  const totalGiB = (totalmem() / (1024 * 1024 * 1024)).toFixed(1);
  Logger.info(
    `[recording] profile=${overridden.name} (req=${requested}) ${overridden.width}x${overridden.height}@${overridden.fps} v${overridden.videoBitrateKbps}k a${overridden.audioBitrateKbps}k max=${overridden.maxConcurrentSessions} (host: ${vCpu} vCPU, ${totalGiB} GiB)`,
  );

  cachedProfile = overridden;
  return overridden;
};
