import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../../utilities/loggers.js";
import type {
  RecordingCompositeArtifact,
  RecordingTrackArtifact,
} from "../../types.js";

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

export type RunCompositorOptions = {
  sessionId: string;
  storageDir: string;
  storageRelative: string;
  tracks: RecordingTrackArtifact[];
  onProgress: (state: RecordingCompositeArtifact) => void;
};

const isPlayable = (track: RecordingTrackArtifact, storageDir: string): boolean => {
  if (track.status === "failed") return false;
  if (!track.filename) return false;
  const path = join(storageDir, track.filename);
  if (!existsSync(path)) return false;
  try {
    const size = statSync(path).size;
    return size > 2048;
  } catch {
    return false;
  }
};

const pickPrimaryAudio = (
  tracks: RecordingTrackArtifact[],
): RecordingTrackArtifact | null => {
  const audio = tracks
    .filter((track) => track.trackKind === "audio")
    .sort((a, b) => b.durationMs - a.durationMs);
  return audio[0] ?? null;
};

const pickPrimaryVideo = (
  tracks: RecordingTrackArtifact[],
): RecordingTrackArtifact | null => {
  const screen = tracks.find((track) => track.trackKind === "screen");
  if (screen) return screen;
  const videoSorted = tracks
    .filter((track) => track.trackKind === "video")
    .sort((a, b) => b.durationMs - a.durationMs);
  return videoSorted[0] ?? null;
};

export const runCompositor = (options: RunCompositorOptions): void => {
  const { tracks, storageDir } = options;
  const playableTracks = tracks.filter((track) =>
    isPlayable(track, storageDir),
  );
  const audio = pickPrimaryAudio(playableTracks);
  const video = pickPrimaryVideo(playableTracks);

  if (!audio && !video) {
    options.onProgress({
      status: "failed",
      filename: null,
      relativePath: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      byteSize: 0,
      errorMessage: "No playable tracks for composite",
    });
    return;
  }

  const audioMixCandidates = playableTracks.filter(
    (track) => track.trackKind === "audio",
  );

  const outputFilename = "composite.mp4";
  const outputPath = join(storageDir, outputFilename);

  const inputs: string[] = [];
  const filterParts: string[] = [];
  let audioInputCount = 0;
  let videoInputIndex: number | null = null;

  audioMixCandidates.forEach((track) => {
    inputs.push("-i", join(storageDir, track.filename));
    audioInputCount += 1;
  });

  if (video) {
    inputs.push("-i", join(storageDir, video.filename));
    videoInputIndex = audioInputCount;
  }

  if (audioInputCount > 1) {
    const inputLabels = audioMixCandidates
      .map((_, idx) => `[${idx}:a]`)
      .join("");
    filterParts.push(
      `${inputLabels}amix=inputs=${audioInputCount}:duration=longest:dropout_transition=0:normalize=0[aout]`,
    );
  } else if (audioInputCount === 1) {
    filterParts.push("[0:a]anull[aout]");
  }

  const args: string[] = [
    "-y",
    "-loglevel",
    "error",
    ...inputs,
  ];

  if (filterParts.length > 0) {
    args.push("-filter_complex", filterParts.join(";"));
  }

  if (videoInputIndex !== null) {
    args.push("-map", `${videoInputIndex}:v`);
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p");
  }
  if (audioInputCount > 0) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  }
  args.push("-movflags", "+faststart");
  args.push(outputPath);

  const startedAt = Date.now();
  options.onProgress({
    status: "running",
    filename: null,
    relativePath: null,
    startedAt,
    completedAt: null,
    byteSize: 0,
    errorMessage: null,
  });

  const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    options.onProgress({
      status: "failed",
      filename: null,
      relativePath: null,
      startedAt,
      completedAt: Date.now(),
      byteSize: 0,
      errorMessage: error.message,
    });
  });
  child.on("exit", (code) => {
    if (code === 0 && existsSync(outputPath)) {
      let byteSize = 0;
      try {
        byteSize = statSync(outputPath).size;
      } catch {
        byteSize = 0;
      }
      options.onProgress({
        status: "completed",
        filename: outputFilename,
        relativePath: `${options.storageRelative}/${outputFilename}`,
        startedAt,
        completedAt: Date.now(),
        byteSize,
        errorMessage: null,
      });
      Logger.info(
        `[recording] composite ready for session ${options.sessionId} (${byteSize} bytes)`,
      );
    } else {
      Logger.warn(
        `[recording] composite ffmpeg failed (code ${code}): ${stderrBuffer.slice(-512)}`,
      );
      options.onProgress({
        status: "failed",
        filename: null,
        relativePath: null,
        startedAt,
        completedAt: Date.now(),
        byteSize: 0,
        errorMessage: `composite ffmpeg failed (code ${code})`,
      });
    }
  });
};
