import { statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Consumer, PlainTransport, Router } from "mediasoup/types";
import { Logger } from "../../utilities/loggers.js";
import type {
  RecordingTrackArtifact,
  RecordingTrackKind,
  RecordingTrackStatus,
} from "../../types.js";
import {
  buildFfmpegArgs,
  spawnFfmpegRecorder,
  writeSdpFile,
  type FfmpegProcessHandle,
} from "./ffmpegBridge.js";
import { codecToOutputFormat, buildSdpFromConsumer } from "./sdp.js";
import type { RecordingPortAllocator } from "./ports.js";

export type ProducerRecorderOptions = {
  router: Router;
  producerId: string;
  producerUserId: string;
  displayName: string | null;
  trackKind: RecordingTrackKind;
  rawKind: "audio" | "video";
  storageDir: string;
  ports: RecordingPortAllocator;
  audioBitrateKbps: number;
  videoBitrateKbps: number;
  preferredVideoCodec: "h264" | "vp8";
  listenIp: string;
  onFailure?: (error: Error) => void;
};

export type ProducerRecorder = {
  start: () => Promise<RecordingTrackArtifact>;
  stop: () => Promise<RecordingTrackArtifact>;
  artifact: () => RecordingTrackArtifact;
};

const sanitizeForFilename = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 96) || "anon";

const ffmpegKind = (
  trackKind: RecordingTrackKind,
  rawKind: "audio" | "video",
): "audio" | "video" => (rawKind === "audio" ? "audio" : "video");

export const createProducerRecorder = (
  options: ProducerRecorderOptions,
): ProducerRecorder => {
  const recorderId = randomUUID();
  const startedAt = Date.now();
  let transport: PlainTransport | null = null;
  let consumer: Consumer | null = null;
  let ffmpeg: FfmpegProcessHandle | null = null;
  let allocatedPort: number | null = null;
  let status: RecordingTrackStatus = "active";
  let endedAt: number | null = null;
  let errorMessage: string | null = null;
  let outputContainer: "webm" | "mp4" | "m4a" = "webm";
  let outputCodec = "";
  let outputFilename = "";
  let outputRelative = "";

  const ensureSafe = (label: string, error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`[recorder] ${label} failed for ${options.producerId}: ${message}`);
    return new Error(message);
  };

  const cleanupOnFailure = (message: string): void => {
    status = "failed";
    errorMessage = message;
    endedAt = endedAt ?? Date.now();
    void teardownTransports();
  };

  const teardownTransports = async (): Promise<void> => {
    try {
      if (consumer && !consumer.closed) {
        consumer.close();
      }
    } catch {
      // ignore
    }
    consumer = null;
    try {
      if (transport && !transport.closed) {
        transport.close();
      }
    } catch {
      // ignore
    }
    transport = null;
    if (allocatedPort != null) {
      options.ports.release(allocatedPort);
      allocatedPort = null;
    }
  };

  const artifact = (): RecordingTrackArtifact => {
    let byteSize = 0;
    try {
      if (outputFilename) {
        byteSize = statSync(join(options.storageDir, outputFilename)).size;
      }
    } catch {
      byteSize = 0;
    }
    return {
      id: recorderId,
      trackKind: options.trackKind,
      producerId: options.producerId,
      producerUserId: options.producerUserId,
      displayName: options.displayName,
      codec: outputCodec,
      container: outputContainer,
      filename: outputFilename,
      relativePath: outputRelative,
      startedAt,
      endedAt,
      durationMs: Math.max(0, (endedAt ?? Date.now()) - startedAt),
      byteSize,
      status,
      errorMessage,
    };
  };

  const start = async (): Promise<RecordingTrackArtifact> => {
    try {
      transport = await options.router.createPlainTransport({
        listenIp: { ip: options.listenIp, announcedIp: undefined },
        rtcpMux: true,
        comedia: false,
      });

      consumer = await transport.consume({
        producerId: options.producerId,
        rtpCapabilities: options.router.rtpCapabilities,
        paused: true,
      });

      const portInfo = options.ports.acquire();
      allocatedPort = portInfo;

      const format = codecToOutputFormat(options.rawKind, consumer.rtpParameters);
      outputCodec = format.codec;
      outputContainer = format.container;
      const safeUser = sanitizeForFilename(options.producerUserId);
      const trackLabel =
        options.trackKind === "screen"
          ? "screen"
          : options.rawKind === "audio"
            ? "audio"
            : "video";
      outputFilename = `${trackLabel}-${safeUser}-${recorderId.slice(0, 8)}.${format.extension}`;
      outputRelative = outputFilename;

      const sdp = buildSdpFromConsumer({
        kind: options.rawKind,
        rtpParameters: consumer.rtpParameters,
        listenIp: "127.0.0.1",
        port: portInfo,
        ssrc: consumer.rtpParameters.encodings?.[0]?.ssrc,
      });
      const sdpPath = join(options.storageDir, `${recorderId}.sdp`);
      writeSdpFile(sdpPath, sdp);

      const outputPath = join(options.storageDir, outputFilename);
      const args = buildFfmpegArgs({
        sdpPath,
        outputPath,
        kind: ffmpegKind(options.trackKind, options.rawKind),
        codec: format.codec,
        bitrateKbps:
          options.rawKind === "audio"
            ? options.audioBitrateKbps
            : options.videoBitrateKbps,
        preferredVideoCodec: options.preferredVideoCodec,
      });

      ffmpeg = spawnFfmpegRecorder({
        label: `${trackLabel}-${safeUser}`,
        sdpPath,
        args,
        outputPath,
        onExit: ({ code, signal }) => {
          if (status === "active") {
            if (code === 0 || code === 255) {
              status = "ended";
            } else {
              status = "failed";
              errorMessage = `ffmpeg exited with code ${code} (signal=${signal ?? "n/a"})`;
              options.onFailure?.(new Error(errorMessage ?? ""));
            }
          }
          endedAt = endedAt ?? Date.now();
          void teardownTransports();
        },
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 400));

      await transport.connect({
        ip: "127.0.0.1",
        port: portInfo,
      });

      await consumer.resume();

      Logger.info(
        `[recorder] started ${trackLabel}-${safeUser} (producer=${options.producerId}, port=${portInfo})`,
      );

      return artifact();
    } catch (error) {
      const wrapped = ensureSafe("start", error);
      cleanupOnFailure(wrapped.message);
      options.onFailure?.(wrapped);
      throw wrapped;
    }
  };

  const stop = async (): Promise<RecordingTrackArtifact> => {
    if (status === "active") {
      endedAt = Date.now();
    }
    try {
      if (ffmpeg) {
        await ffmpeg.stop(true);
        ffmpeg = null;
      }
    } catch (error) {
      Logger.warn(
        `[recorder] failed to stop ffmpeg for ${options.producerId}`,
        error,
      );
    }
    await teardownTransports();
    if (status === "active") {
      status = "ended";
    }
    return artifact();
  };

  return {
    start,
    stop,
    artifact,
  };
};
