import dgram from "dgram";
import { spawn } from "child_process";
import WebSocket from "ws";
import type {
  Producer,
  Router,
  RtpCapabilities,
  PlainTransport,
  Consumer,
} from "mediasoup/types";
import { Logger } from "../../utilities/loggers.js";

const DEFAULT_STT_SAMPLE_RATE = Number(process.env.STT_SAMPLE_RATE || 16000);
const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFMPEG_FORCE_KILL_TIMEOUT_MS = Number(
  process.env.FFMPEG_FORCE_KILL_TIMEOUT_MS || 2000,
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeSpeakerLabel = (value?: string): string => {
  const next = (value || "").trim().replace(/\s+/g, " ");
  if (!next) return "";
  if (/^unknown$/i.test(next)) return "";
  if (UUID_PATTERN.test(next)) return "";
  return next.length > 48 ? next.slice(0, 48) : next;
};

type VoskWord = { start?: number; end?: number };
type VoskMessage = {
  text?: string;
  partial?: string;
  speaker?: string;
  channel?: string;
  start?: number;
  end?: number;
  result?: VoskWord[];
  alternatives?: Array<{ text?: string }>;
};

type RtpCodecLike = {
  payloadType: number;
  mimeType: string;
  clockRate: number;
  channels?: number;
  parameters?: Record<string, unknown>;
};

export type TranscriptChunk = {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
};

const allocateUdpPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      try {
        socket.close();
      } catch {}
      reject(err);
    });
    socket.bind(0, "127.0.0.1", () => {
      const addr = socket.address();
      if (typeof addr === "string") {
        try {
          socket.close();
        } catch {}
        reject(new Error("Failed to allocate UDP port"));
        return;
      }
      const port = addr.port;
      try {
        socket.close();
      } catch (err) {
        reject(err);
        return;
      }
      resolve(port);
    });
  });

const encodeFmtp = (parameters?: Record<string, unknown>): string => {
  if (!parameters) return "";
  const entries = Object.entries(parameters).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  return entries
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(";");
};

const buildConsumerSdp = (rtpPort: number, consumer: Consumer): string => {
  const codec = (consumer.rtpParameters.codecs?.[0] || null) as
    | RtpCodecLike
    | null;
  if (!codec) {
    throw new Error("No RTP codec found for room transcriber consumer");
  }
  const codecName = codec.mimeType.split("/")[1] || "opus";
  const channels = codec.channels && codec.channels > 1 ? `/${codec.channels}` : "";
  const fmtp = encodeFmtp(codec.parameters);
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=ConclaveRoomAudio",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${rtpPort} RTP/AVP ${codec.payloadType}`,
    "a=rtcp-mux",
    `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}${channels}`,
  ];
  if (fmtp) {
    lines.push(`a=fmtp:${codec.payloadType} ${fmtp}`);
  }
  for (const ext of consumer.rtpParameters.headerExtensions || []) {
    lines.push(`a=extmap:${ext.id} ${ext.uri}`);
  }
  lines.push("a=recvonly");
  return `${lines.join("\n")}\n`;
};

class RoomTranscriber {
  private router: Router;
  private ffmpeg?: ReturnType<typeof spawn>;
  private sttSocket?: WebSocket;
  private transport?: PlainTransport;
  private consumer?: Consumer;
  private producerId?: string;
  private transcript: TranscriptChunk[] = [];
  private lastPartialText = "";
  private sessionStartedAtMs = Date.now();
  private speakerLabel = "Speaker";
  private stopSubscriptions: Array<() => void> = [];
  private ffmpegForceKillTimer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private forwardedAudioBytes = 0;
  private sttMessageCount = 0;

  private ffmpegOnError?: (err: Error) => void;
  private ffmpegOnExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private ffmpegStdoutOnData?: (chunk: Buffer) => void;
  private ffmpegStderrOnData?: (chunk: Buffer) => void;
  private sttOnOpen?: () => void;
  private sttOnError?: (err: Error) => void;
  private sttOnMessage?: (data: WebSocket.RawData) => void;

  constructor(router: Router) {
    this.router = router;
  }

  async start(
    producer: Producer,
    opts: {
      sttUrl: string;
      sttHeaders?: Record<string, string>;
      speakerLabel?: string;
    },
  ): Promise<void> {
    if (!opts.sttUrl) {
      Logger.warn("STT_WS_URL not set; transcriber not started");
      return;
    }
    if (this.transport || this.consumer || this.ffmpeg || this.sttSocket) {
      Logger.info("Transcriber already active for this room; skipping");
      return;
    }

    this.stopped = false;
    this.producerId = producer.id;
    this.speakerLabel =
      normalizeSpeakerLabel(opts.speakerLabel) ||
      normalizeSpeakerLabel(producer.id) ||
      "Speaker";
    this.sessionStartedAtMs = Date.now();
    this.forwardedAudioBytes = 0;
    this.sttMessageCount = 0;

    try {
      const transport = await this.router.createPlainTransport({
        listenIp: { ip: "127.0.0.1", announcedIp: undefined },
        rtcpMux: true,
        comedia: false,
      });
      this.transport = transport;

      const rtpPort = await allocateUdpPort();
      await transport.connect({ ip: "127.0.0.1", port: rtpPort });

      const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: this.router.rtpCapabilities as RtpCapabilities,
        paused: true,
      });
      this.consumer = consumer;

      const sdp = buildConsumerSdp(rtpPort, consumer);

      this.ffmpeg = spawn(
        FFMPEG_BIN,
        [
          "-hide_banner",
          "-loglevel",
          "warning",
          "-protocol_whitelist",
          "file,pipe,udp,rtp",
          "-f",
          "sdp",
          "-i",
          "pipe:0",
          "-ac",
          "1",
          "-ar",
          `${DEFAULT_STT_SAMPLE_RATE}`,
          "-f",
          "s16le",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );

      Logger.info(
        `Transcriber starting: producer=${producer.id} speaker=${this.speakerLabel} stt=${opts.sttUrl} ffmpeg=${FFMPEG_BIN} rtpPort=${rtpPort}`,
      );

      this.ffmpegOnError = (err) => {
        Logger.warn("Failed to start ffmpeg for STT pipeline", {
          ffmpeg: FFMPEG_BIN,
          err,
        });
        this.stop();
      };
      this.ffmpeg.on("error", this.ffmpegOnError);

      this.ffmpegOnExit = (code, signal) => {
        if (this.ffmpegForceKillTimer) {
          clearTimeout(this.ffmpegForceKillTimer);
          this.ffmpegForceKillTimer = undefined;
        }
        if (!this.stopped && code !== 0) {
          Logger.warn("ffmpeg exited unexpectedly in STT pipeline", {
            ffmpeg: FFMPEG_BIN,
            code,
            signal,
          });
          this.stop();
        }
      };
      this.ffmpeg.on("exit", this.ffmpegOnExit);

      this.ffmpegStderrOnData = (chunk) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          Logger.warn(`ffmpeg/stt stderr: ${line}`);
        }
      };
      this.ffmpeg.stderr?.on("data", this.ffmpegStderrOnData);

      if (this.ffmpeg.stdin?.writable) {
        this.ffmpeg.stdin.write(sdp);
        this.ffmpeg.stdin.end();
      }

      this.sttSocket = new WebSocket(opts.sttUrl, { headers: opts.sttHeaders });

      this.sttOnOpen = () => {
        Logger.info(`STT websocket open for producer=${producer.id}`);
        this.sttSocket?.send(
          JSON.stringify({ config: { sample_rate: DEFAULT_STT_SAMPLE_RATE } }),
        );
      };
      this.sttSocket.on("open", this.sttOnOpen);

      this.sttOnError = (err) => {
        Logger.warn("STT websocket error", err);
      };
      this.sttSocket.on("error", this.sttOnError);

      this.sttOnMessage = (data) => {
        this.sttMessageCount += 1;
        this.handleSttMessage(this.toUtf8(data), producer.id);
      };
      this.sttSocket.on("message", this.sttOnMessage);

      this.ffmpegStdoutOnData = (chunk: Buffer) => {
        this.forwardedAudioBytes += chunk.length;
        if (this.forwardedAudioBytes === chunk.length) {
          Logger.info(`Transcriber audio flow started for producer=${producer.id}`);
        }
        if (this.sttSocket?.readyState === WebSocket.OPEN) {
          this.sttSocket.send(chunk);
        }
      };
      this.ffmpeg.stdout?.on("data", this.ffmpegStdoutOnData);

      const stop = () => this.stop();
      consumer.on("producerclose", stop);
      consumer.on("transportclose", stop);
      transport.on("routerclose", stop);
      this.stopSubscriptions.push(() => consumer.off("producerclose", stop));
      this.stopSubscriptions.push(() => consumer.off("transportclose", stop));
      this.stopSubscriptions.push(() => transport.off("routerclose", stop));

      await consumer.resume();
    } catch (err) {
      Logger.warn("Failed to start room transcriber", err);
      this.stop();
    }
  }

  private toUtf8(data: WebSocket.RawData): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf8");
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString("utf8");
    }
    return data.toString();
  }

  private handleSttMessage(raw: string, producerId: string): void {
    try {
      const msg = JSON.parse(raw) as VoskMessage;
      const finalText = this.extractFinalText(msg);
      if (finalText) {
        const { startMs, endMs } = this.getTimestampRangeMs(msg);
        this.appendTranscript({
          startMs,
          endMs,
          text: finalText,
          speaker: this.resolveSpeakerLabel(msg, producerId),
        });
        this.lastPartialText = "";
        return;
      }

      const partial = typeof msg.partial === "string" ? msg.partial.trim() : "";
      if (partial) {
        this.lastPartialText = partial;
      }
    } catch (err) {
      Logger.warn("STT parse error", err);
    }
  }

  private resolveSpeakerLabel(msg: VoskMessage, producerId: string): string {
    const fromMessage = normalizeSpeakerLabel(msg.speaker || msg.channel);
    if (fromMessage) return fromMessage;
    return (
      this.speakerLabel ||
      normalizeSpeakerLabel(producerId) ||
      "Speaker"
    );
  }

  private extractFinalText(msg: VoskMessage): string {
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (text) return text;
    const altText = Array.isArray(msg.alternatives)
      ? (msg.alternatives[0]?.text || "").trim()
      : "";
    return altText;
  }

  private getTimestampRangeMs(msg: VoskMessage): {
    startMs: number;
    endMs: number;
  } {
    const now = Date.now();
    let startSeconds: number | undefined;
    let endSeconds: number | undefined;

    if (Array.isArray(msg.result) && msg.result.length) {
      const first = msg.result[0];
      const last = msg.result[msg.result.length - 1];
      if (Number.isFinite(Number(first.start))) {
        startSeconds = Number(first.start);
      }
      if (Number.isFinite(Number(last.end))) {
        endSeconds = Number(last.end);
      }
    }

    if (startSeconds === undefined && Number.isFinite(Number(msg.start))) {
      startSeconds = Number(msg.start);
    }
    if (endSeconds === undefined && Number.isFinite(Number(msg.end))) {
      endSeconds = Number(msg.end);
    }

    const startMs =
      startSeconds !== undefined
        ? this.sessionStartedAtMs + Math.round(startSeconds * 1000)
        : now;
    const endMs =
      endSeconds !== undefined
        ? this.sessionStartedAtMs + Math.round(endSeconds * 1000)
        : startMs;

    return { startMs, endMs: Math.max(endMs, startMs) };
  }

  private appendTranscript(chunk: TranscriptChunk): void {
    const text = chunk.text.replace(/\s+/g, " ").trim();
    if (!text) return;
    const last = this.transcript[this.transcript.length - 1];
    if (
      last &&
      last.text === text &&
      Math.abs(last.endMs - chunk.endMs) < 1500 &&
      (last.speaker || "") === (chunk.speaker || "")
    ) {
      return;
    }
    this.transcript.push({ ...chunk, text });
  }

  private removeListeners(): void {
    while (this.stopSubscriptions.length) {
      const unsubscribe = this.stopSubscriptions.pop();
      try {
        unsubscribe?.();
      } catch {}
    }

    if (this.ffmpeg && this.ffmpegOnError) {
      this.ffmpeg.off("error", this.ffmpegOnError);
    }
    if (this.ffmpeg && this.ffmpegOnExit) {
      this.ffmpeg.off("exit", this.ffmpegOnExit);
    }
    if (this.ffmpeg?.stdout && this.ffmpegStdoutOnData) {
      this.ffmpeg.stdout.off("data", this.ffmpegStdoutOnData);
    }
    if (this.ffmpeg?.stderr && this.ffmpegStderrOnData) {
      this.ffmpeg.stderr.off("data", this.ffmpegStderrOnData);
    }

    if (this.sttSocket && this.sttOnOpen) {
      this.sttSocket.off("open", this.sttOnOpen);
    }
    if (this.sttSocket && this.sttOnError) {
      this.sttSocket.off("error", this.sttOnError);
    }
    if (this.sttSocket && this.sttOnMessage) {
      this.sttSocket.off("message", this.sttOnMessage);
    }

    this.ffmpegOnError = undefined;
    this.ffmpegOnExit = undefined;
    this.ffmpegStdoutOnData = undefined;
    this.ffmpegStderrOnData = undefined;
    this.sttOnOpen = undefined;
    this.sttOnError = undefined;
    this.sttOnMessage = undefined;
  }

  getTranscript(): TranscriptChunk[] {
    return this.transcript.filter((chunk) => Boolean(chunk.text.trim()));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.lastPartialText) {
      const now = Date.now();
      this.appendTranscript({
        startMs: now,
        endMs: now,
        text: this.lastPartialText,
        speaker: this.speakerLabel || "Speaker",
      });
      this.lastPartialText = "";
    }

    Logger.info(
      `Stopping transcriber: producer=${this.producerId || "unknown"} chunks=${this.transcript.length} sttMessages=${this.sttMessageCount} audioBytes=${this.forwardedAudioBytes}`,
    );

    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      try {
        this.sttSocket.send(JSON.stringify({ eof: 1 }));
      } catch {}
    }

    this.removeListeners();
    this.sttSocket?.close();

    if (this.ffmpeg) {
      const ffmpegProcess = this.ffmpeg;
      try {
        ffmpegProcess.kill("SIGTERM");
      } catch {}
      this.ffmpegForceKillTimer = setTimeout(() => {
        if (ffmpegProcess.exitCode === null && !ffmpegProcess.killed) {
          try {
            ffmpegProcess.kill("SIGKILL");
          } catch {}
        }
      }, FFMPEG_FORCE_KILL_TIMEOUT_MS);
      ffmpegProcess.once("exit", () => {
        if (this.ffmpegForceKillTimer) {
          clearTimeout(this.ffmpegForceKillTimer);
          this.ffmpegForceKillTimer = undefined;
        }
      });
    }

    try {
      this.consumer?.close();
    } catch {}
    try {
      this.transport?.close();
    } catch {}

    this.consumer = undefined;
    this.transport = undefined;
    this.sttSocket = undefined;
    this.ffmpeg = undefined;
    this.producerId = undefined;
  }
}

const transcribers = new Map<string, RoomTranscriber>();

export const ensureRoomTranscriber = (
  channelId: string,
  router: Router,
): RoomTranscriber => {
  let transcriber = transcribers.get(channelId);
  if (!transcriber) {
    transcriber = new RoomTranscriber(router);
    transcribers.set(channelId, transcriber);
  }
  return transcriber;
};

export const stopRoomTranscriber = (channelId: string): TranscriptChunk[] => {
  const transcriber = transcribers.get(channelId);
  if (!transcriber) return [];
  transcriber.stop();
  transcribers.delete(channelId);
  return transcriber.getTranscript();
};
