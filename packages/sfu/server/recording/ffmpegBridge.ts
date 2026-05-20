import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Logger } from "../../utilities/loggers.js";

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

let ffmpegAvailability: { checked: boolean; available: boolean } = {
  checked: false,
  available: false,
};

export const isFfmpegAvailable = async (): Promise<boolean> => {
  if (ffmpegAvailability.checked) return ffmpegAvailability.available;
  const result = await new Promise<boolean>((resolve) => {
    const probe = spawn(FFMPEG_BIN, ["-version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
  ffmpegAvailability = { checked: true, available: result };
  if (!result) {
    Logger.warn(
      `Recording: ffmpeg binary not found at "${FFMPEG_BIN}" — recording will be disabled.`,
    );
  } else {
    Logger.info(`Recording: ffmpeg available at "${FFMPEG_BIN}"`);
  }
  return result;
};

export type FfmpegProcessOptions = {
  label: string;
  sdpPath: string;
  args: string[];
  outputPath: string;
  onExit: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

export type FfmpegProcessHandle = {
  process: ChildProcess;
  stop: (graceful?: boolean) => Promise<void>;
  pid: number | undefined;
};

const ensureParentDir = (path: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
};

export const writeSdpFile = (path: string, sdp: string): void => {
  ensureParentDir(path);
  writeFileSync(path, sdp, "utf8");
};

export const spawnFfmpegRecorder = (
  options: FfmpegProcessOptions,
): FfmpegProcessHandle => {
  ensureParentDir(options.outputPath);
  const spawnOptions: SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = spawn(FFMPEG_BIN, options.args, spawnOptions);

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (process.env.RECORDING_VERBOSE === "1") {
      Logger.debug(`[ffmpeg:${options.label}] ${text.trim()}`);
    }
  });

  let exited = false;
  child.on("exit", (code, signal) => {
    exited = true;
    options.onExit({ code, signal });
  });
  child.on("error", (error) => {
    Logger.error(`[ffmpeg:${options.label}] spawn error`, error);
    if (!exited) {
      exited = true;
      options.onExit({ code: -1, signal: null });
    }
  });

  const stop = async (graceful = true): Promise<void> => {
    if (exited) return;
    if (graceful && child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.end("q");
      } catch {
        // ignore
      }
    }
    if (!child.killed) {
      try {
        child.kill(graceful ? "SIGINT" : "SIGKILL");
      } catch (error) {
        Logger.warn(
          `[ffmpeg:${options.label}] failed to send signal`,
          error,
        );
      }
    }
    if (graceful) {
      await new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 4_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };

  return {
    process: child,
    stop,
    pid: child.pid,
  };
};

export const buildFfmpegArgs = (params: {
  sdpPath: string;
  outputPath: string;
  kind: "audio" | "video";
  codec: string;
  bitrateKbps: number;
  preferredVideoCodec: "h264" | "vp8";
}): string[] => {
  const { sdpPath, outputPath, kind, codec, bitrateKbps } = params;

  const baseArgs = [
    "-loglevel",
    "error",
    "-protocol_whitelist",
    "file,udp,rtp",
    "-reorder_queue_size",
    "32",
    "-fflags",
    "+genpts",
    "-i",
    sdpPath,
    "-y",
  ];

  if (kind === "audio") {
    return [
      ...baseArgs,
      "-c:a",
      codec === "opus" ? "copy" : "aac",
      ...(codec === "opus" ? [] : ["-b:a", `${bitrateKbps}k`]),
      "-f",
      codec === "opus" ? "webm" : "ipod",
      outputPath,
    ];
  }

  if (codec === "h264") {
    return [
      ...baseArgs,
      "-c:v",
      "copy",
      "-movflags",
      "+faststart+empty_moov+default_base_moof",
      "-f",
      "mp4",
      outputPath,
    ];
  }

  return [
    ...baseArgs,
    "-c:v",
    "copy",
    "-f",
    "webm",
    outputPath,
  ];
};
