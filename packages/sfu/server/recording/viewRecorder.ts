import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../../config/config.js";
import { Logger } from "../../utilities/loggers.js";
import type { Room } from "../../config/classes/Room.js";
import { resolveRecordingProfile } from "./qualityProfile.js";

const DEFAULT_CHUNK_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

// Counter for allocating unique Xvfb display numbers across concurrent
// recordings. Start at :99 (a common convention) and walk up.
let nextXvfbDisplayNumber = 99;
const allocateXvfbDisplay = (): number => {
  const display = nextXvfbDisplayNumber;
  nextXvfbDisplayNumber += 1;
  if (nextXvfbDisplayNumber > 199) nextXvfbDisplayNumber = 99;
  return display;
};

const spawnXvfb = (
  displayNumber: number,
  width: number,
  height: number,
): { proc: ChildProcess; displayString: string } => {
  const displayString = `:${displayNumber}`;
  const proc = spawn(
    "Xvfb",
    [
      displayString,
      "-screen",
      "0",
      `${width}x${height}x24`,
      "-nolisten",
      "tcp",
      "-noreset",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text && process.env.RECORDING_VERBOSE === "1") {
      Logger.debug(`[xvfb ${displayString}] ${text}`);
    }
  });
  proc.on("error", (error) => {
    Logger.warn(
      `[xvfb ${displayString}] spawn error: ${error.message}`,
    );
  });
  return { proc, displayString };
};

const isXvfbAvailable = (): boolean => {
  if (process.env.RECORDER_USE_XVFB === "0") return false;
  // We only force-disable on macOS dev where Xvfb isn't installed.
  if (process.platform === "darwin") return false;
  return true;
};

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

export type ViewRecorderOptions = {
  room: Room;
  sessionId: string;
  storageDir: string;
  recorderUrlBase: string;
  scheduledWebinarId?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  audioBitrateKbps?: number;
  videoBitrateKbps?: number;
  onFatal?: (error: Error) => void;
};

export type ViewRecorderHandle = {
  sessionId: string;
  start: () => Promise<void>;
  stop: () => Promise<{
    outputPath: string;
    outputFilename: string;
    byteSize: number;
    durationMs: number;
  }>;
  appendChunk: (
    chunk: Buffer,
    sequence: number,
  ) => Promise<{ accepted: boolean; reason?: string }>;
  finalizeFromBrowser: (durationMs: number) => Promise<void>;
  isActive: () => boolean;
  outputFilename: string;
};

type LaunchedBrowser = {
  close: () => Promise<void>;
};

const buildRecorderUrl = (params: {
  recorderUrlBase: string;
  roomId: string;
  sessionId: string;
  token: string;
  captureSourceTag: string;
  width: number;
  height: number;
  fps: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}): string => {
  const base = params.recorderUrlBase.replace(/\/$/, "");
  const search = new URLSearchParams({
    roomId: params.roomId,
    token: params.token,
    title: params.captureSourceTag,
    w: String(params.width),
    h: String(params.height),
    fps: String(params.fps),
    vb: String(params.videoBitrateKbps),
    ab: String(params.audioBitrateKbps),
  });
  return `${base}/recorder/${encodeURIComponent(params.sessionId)}?${search.toString()}`;
};

const resolveChromiumExecutable = (): string => {
  const explicit = process.env.RECORDER_CHROMIUM_PATH?.trim();
  if (explicit) return explicit;
  const platformDefaults: Record<NodeJS.Platform, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    win32: [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    ],
    aix: [],
    android: [],
    freebsd: [],
    haiku: [],
    openbsd: [],
    sunos: [],
    cygwin: [],
    netbsd: [],
  };
  for (const candidate of platformDefaults[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return "google-chrome";
};

export const createViewRecorder = (
  options: ViewRecorderOptions,
): ViewRecorderHandle => {
  const sessionId = options.sessionId || randomUUID();
  const profile = resolveRecordingProfile();
  const width = options.width ?? profile.width;
  const height = options.height ?? profile.height;
  const fps = options.fps ?? profile.fps;
  const outputFilename = "view.webm";
  const outputPath = join(options.storageDir, outputFilename);
  const transcodedFilename = "view.mp4";
  const transcodedPath = join(options.storageDir, transcodedFilename);

  let browser: LaunchedBrowser | null = null;
  let xvfbProc: ChildProcess | null = null;
  let xvfbDisplayString: string | null = null;
  let writeStream: WriteStream | null = null;
  let nextExpectedSequence = 0;
  const pendingChunks = new Map<number, Buffer>();
  let pendingBufferedBytes = 0;
  let active = false;
  let stopped = false;
  let startedAt = 0;
  let endedAt: number | null = null;
  let browserDurationMs = 0;

  const drainPendingChunks = async (): Promise<void> => {
    if (!writeStream) return;
    while (pendingChunks.has(nextExpectedSequence)) {
      const buffer = pendingChunks.get(nextExpectedSequence)!;
      pendingChunks.delete(nextExpectedSequence);
      pendingBufferedBytes -= buffer.length;
      await new Promise<void>((resolve, reject) => {
        writeStream!.write(buffer, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      nextExpectedSequence += 1;
    }
  };

  const appendChunk: ViewRecorderHandle["appendChunk"] = async (
    chunk,
    sequence,
  ) => {
    if (!active || stopped) {
      return { accepted: false, reason: "recorder inactive" };
    }
    if (!writeStream) {
      return { accepted: false, reason: "write stream not ready" };
    }
    if (
      pendingBufferedBytes + chunk.length >
      DEFAULT_CHUNK_BUFFER_MAX_BYTES
    ) {
      Logger.warn(
        `[viewRecorder] dropping chunk for session ${sessionId}: backpressure exceeded`,
      );
      return { accepted: false, reason: "backpressure" };
    }
    if (sequence < nextExpectedSequence) {
      return { accepted: false, reason: "duplicate/late chunk" };
    }
    pendingChunks.set(sequence, chunk);
    pendingBufferedBytes += chunk.length;
    try {
      await drainPendingChunks();
    } catch (error) {
      Logger.error(
        `[viewRecorder] write failed for session ${sessionId}`,
        error,
      );
      return { accepted: false, reason: "write failed" };
    }
    return { accepted: true };
  };

  const mintRecorderToken = (): string => {
    const payload = {
      kind: "view-recorder",
      sessionId,
      roomId: options.room.id,
      clientId: options.room.clientId,
      scheduledWebinarId: options.scheduledWebinarId ?? null,
      width,
      height,
      fps,
      audioBitrateKbps: options.audioBitrateKbps ?? 128,
      videoBitrateKbps: options.videoBitrateKbps ?? 6_000,
      issuedAt: Date.now(),
    };
    return jwt.sign(payload, config.sfuSecret, {
      expiresIn: "12h",
    });
  };

  const start: ViewRecorderHandle["start"] = async () => {
    if (active) return;
    type PuppeteerLaunch = (typeof import("puppeteer-core"))["launch"];
    let puppeteerLaunch: PuppeteerLaunch;
    try {
      const mod = await import("puppeteer-core");
      puppeteerLaunch = (mod.default?.launch ?? mod.launch) as PuppeteerLaunch;
    } catch (error) {
      throw new Error(
        `View recorder requires puppeteer-core (${(error as Error).message})`,
      );
    }
    const executablePath = resolveChromiumExecutable();
    if (!existsSync(executablePath)) {
      throw new Error(
        `View recorder cannot find Chromium at "${executablePath}". Set RECORDER_CHROMIUM_PATH.`,
      );
    }

    writeStream = createWriteStream(outputPath, { flags: "w" });
    writeStream.on("error", (error) => {
      Logger.error(
        `[viewRecorder] write stream error for ${sessionId}: ${error.message}`,
      );
    });

    // Unique identifier we plant in both:
    //   1. Chrome's `--auto-select-desktop-capture-source=...` flag, and
    //   2. The recorder bot page's `document.title`
    // so the headless tab gets auto-selected when getDisplayMedia is called.
    const captureSourceTag = `conclave-rec-${sessionId.slice(0, 8)}`;

    const token = mintRecorderToken();
    const url = buildRecorderUrl({
      recorderUrlBase: options.recorderUrlBase,
      roomId: options.room.id,
      sessionId,
      token,
      captureSourceTag,
      width,
      height,
      fps,
      videoBitrateKbps: options.videoBitrateKbps ?? profile.videoBitrateKbps,
      audioBitrateKbps: options.audioBitrateKbps ?? profile.audioBitrateKbps,
    });

    const userDataDir = join(options.storageDir, ".chromium-profile");
    // Chrome 148 flag set for the headless recorder bot. Verified against
    // production Chromium — `--auto-accept-camera-and-microphone-capture` was
    // REMOVED because it's a phantom flag that crashes Chrome at startup when
    // combined with `--use-fake-ui-for-media-stream` (which already auto-grants
    // every media permission dialog). `--mute-audio=false` is also dropped: the
    // default is already unmuted and the `=false` form is fragile.
    const flags = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      // GPU is fine on Xvfb if we let it fall through to swiftshader.
      // Keep it disabled though — software-only is plenty for screen capture.
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--start-fullscreen",
      "--kiosk",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--allow-running-insecure-content",
      "--disable-blink-features=AutomationControlled",
      "--enable-features=GetDisplayMediaSet",
      // Match by *tab* title — the tab title is set by the bot page to
      // `captureSourceTag` via document.title. Without this flag, the source
      // picker on Xvfb (no window manager → no window title) returns no
      // candidates and getDisplayMedia errors with "Could not start video
      // source". `--auto-select-desktop-capture-source` is kept as a
      // belt-and-suspenders fallback in case the window title is set.
      `--auto-select-tab-capture-source-by-title=${captureSourceTag}`,
      `--auto-select-desktop-capture-source=${captureSourceTag}`,
      `--window-size=${width},${height}`,
      `--user-data-dir=${userDataDir}`,
    ];

    // Headless Chrome (both "shell" and "new") cannot enumerate window/tab
    // sources for getDisplayMedia inside a container — every attempt failed
    // with "Could not start video source". The fix is to run Chromium
    // non-headless against an Xvfb virtual framebuffer, which is what every
    // production browser-recording stack does.
    const useXvfb = isXvfbAvailable();
    const launchEnv: NodeJS.ProcessEnv = { ...process.env };
    if (useXvfb) {
      const displayNumber = allocateXvfbDisplay();
      const xvfb = spawnXvfb(displayNumber, width, height);
      xvfbProc = xvfb.proc;
      xvfbDisplayString = xvfb.displayString;
      launchEnv.DISPLAY = xvfb.displayString;
      // Give Xvfb a moment to set up the display.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      Logger.info(
        `[viewRecorder] Xvfb up on ${xvfb.displayString} for ${sessionId}`,
      );
    }

    const launched = await puppeteerLaunch({
      headless: useXvfb ? false : true,
      executablePath,
      args: flags,
      env: launchEnv,
      defaultViewport: {
        width,
        height,
        deviceScaleFactor: 1,
      },
      ignoreDefaultArgs: ["--enable-automation"],
    });
    browser = {
      close: async () => {
        try {
          await launched.close();
        } catch (error) {
          Logger.warn(
            `[viewRecorder] browser close error: ${(error as Error).message}`,
          );
        }
        if (xvfbProc && !xvfbProc.killed) {
          try {
            xvfbProc.kill("SIGTERM");
          } catch (error) {
            Logger.warn(
              `[viewRecorder] xvfb kill error: ${(error as Error).message}`,
            );
          }
          await new Promise<void>((resolve) => {
            if (!xvfbProc) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              try {
                xvfbProc?.kill("SIGKILL");
              } catch {
                // ignore
              }
              resolve();
            }, 2_000);
            xvfbProc.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          xvfbProc = null;
          if (xvfbDisplayString) {
            Logger.info(
              `[viewRecorder] Xvfb stopped on ${xvfbDisplayString} for ${sessionId}`,
            );
            xvfbDisplayString = null;
          }
        }
      },
    };

    const page = (await launched.pages())[0] ?? (await launched.newPage());
    page.on("pageerror", (error) => {
      Logger.warn(`[viewRecorder] page error: ${error.message}`);
    });
    // Forward browser-side console.log/error/warn unconditionally so we can
    // see what the recorder bot is doing without needing RECORDING_VERBOSE.
    // Filter the noisy info-level logs.
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warn") {
        Logger.warn(`[recorder-bot/${type}] ${msg.text()}`);
      } else if (process.env.RECORDING_VERBOSE === "1") {
        Logger.debug(`[recorder-bot/${type}] ${msg.text()}`);
      }
    });
    page.on("requestfailed", (req) => {
      const url = req.url();
      // Page-asset failures are noise; only log API request failures.
      if (url.includes("/api/")) {
        Logger.warn(
          `[recorder-bot request failed] ${url} ${req.failure()?.errorText}`,
        );
      }
    });

    active = true;
    startedAt = Date.now();

    void (async () => {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        Logger.info(
          `[viewRecorder] launched session ${sessionId} → ${url}`,
        );
      } catch (error) {
        active = false;
        Logger.error(
          `[viewRecorder] failed to load recorder page: ${(error as Error).message}`,
        );
        options.onFatal?.(error as Error);
        if (browser) {
          await browser.close().catch(() => undefined);
          browser = null;
        }
        writeStream?.end();
      }
    })();
  };

  const finalizeFromBrowser: ViewRecorderHandle["finalizeFromBrowser"] = async (
    duration,
  ) => {
    browserDurationMs = duration;
    Logger.info(
      `[viewRecorder] browser-side finalize signal for ${sessionId} (${duration} ms)`,
    );
  };

  const transcodeToMp4 = async (): Promise<void> => {
    if (!existsSync(outputPath)) return;
    try {
      const size = statSync(outputPath).size;
      if (size < 1024) return;
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn(
        FFMPEG_BIN,
        [
          "-y",
          "-loglevel",
          "error",
          "-fflags",
          "+genpts",
          "-i",
          outputPath,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          `${options.audioBitrateKbps ?? 128}k`,
          "-movflags",
          "+faststart",
          transcodedPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("exit", (code) => {
        if (code !== 0) {
          Logger.warn(
            `[viewRecorder] transcode to mp4 failed (code ${code}): ${stderr.slice(-300)}`,
          );
        }
        resolve();
      });
      child.on("error", (error) => {
        Logger.warn(
          `[viewRecorder] transcode spawn error: ${error.message}`,
        );
        resolve();
      });
    });
  };

  const stop: ViewRecorderHandle["stop"] = async () => {
    if (stopped) {
      const size = existsSync(outputPath) ? statSync(outputPath).size : 0;
      return {
        outputPath,
        outputFilename,
        byteSize: size,
        durationMs: endedAt ? endedAt - startedAt : 0,
      };
    }
    stopped = true;
    active = false;

    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        Logger.warn(
          `[viewRecorder] browser close error: ${(error as Error).message}`,
        );
      }
      browser = null;
    }

    if (writeStream) {
      await new Promise<void>((resolve) => {
        writeStream!.end(() => resolve());
      });
      writeStream = null;
    }

    pendingChunks.clear();
    pendingBufferedBytes = 0;

    await transcodeToMp4();

    endedAt = Date.now();
    const byteSize = existsSync(transcodedPath)
      ? statSync(transcodedPath).size
      : existsSync(outputPath)
        ? statSync(outputPath).size
        : 0;

    const finalFilename = existsSync(transcodedPath)
      ? transcodedFilename
      : outputFilename;
    const finalPath = existsSync(transcodedPath) ? transcodedPath : outputPath;

    return {
      outputPath: finalPath,
      outputFilename: finalFilename,
      byteSize,
      durationMs: browserDurationMs || endedAt - startedAt,
    };
  };

  return {
    sessionId,
    start,
    stop,
    appendChunk,
    finalizeFromBrowser,
    isActive: () => active && !stopped,
    outputFilename,
  };
};

export const verifyRecorderToken = (token: string): {
  ok: true;
  payload: {
    sessionId: string;
    roomId: string;
    clientId: string;
    scheduledWebinarId: string | null;
    width: number;
    height: number;
    fps: number;
    audioBitrateKbps: number;
    videoBitrateKbps: number;
  };
} | { ok: false; error: string } => {
  try {
    const decoded = jwt.verify(token, config.sfuSecret) as Record<
      string,
      unknown
    >;
    if (decoded.kind !== "view-recorder") {
      return { ok: false, error: "not a recorder token" };
    }
    const profileForVerify = resolveRecordingProfile();
    return {
      ok: true,
      payload: {
        sessionId: String(decoded.sessionId),
        roomId: String(decoded.roomId),
        clientId: String(decoded.clientId),
        scheduledWebinarId:
          decoded.scheduledWebinarId == null
            ? null
            : String(decoded.scheduledWebinarId),
        width: Number(decoded.width) || profileForVerify.width,
        height: Number(decoded.height) || profileForVerify.height,
        fps: Number(decoded.fps) || profileForVerify.fps,
        audioBitrateKbps:
          Number(decoded.audioBitrateKbps) || profileForVerify.audioBitrateKbps,
        videoBitrateKbps:
          Number(decoded.videoBitrateKbps) || profileForVerify.videoBitrateKbps,
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};
