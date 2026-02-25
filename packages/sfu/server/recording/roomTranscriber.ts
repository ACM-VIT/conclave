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

export type TranscriptChunk = {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
};

class RoomTranscriber {
  private router: Router;
  private consumers: Set<string> = new Set();
  private ffmpeg?: ReturnType<typeof spawn>;
  private sttSocket?: WebSocket;
  private transport?: PlainTransport;
  private consumer?: Consumer;
  private producerId?: string;
  private transcript: TranscriptChunk[] = [];
  private lastPartialText = "";
  private sessionStartedAtMs = Date.now();
  private stopped = false;

  constructor(router: Router) {
    this.router = router;
  }

  async start(
    producer: Producer,
    opts: { sttUrl: string; sttHeaders?: Record<string, string> },
  ): Promise<void> {
    if (!opts.sttUrl) {
      Logger.warn("STT_WS_URL not set; transcriber not started");
      return;
    }
    if (this.stopped) return;
    if (this.transport || this.consumer || this.ffmpeg || this.sttSocket) {
      Logger.info("Transcriber already active for this room; skipping");
      return;
    }
    if (this.consumers.has(producer.id)) return;
    this.producerId = producer.id;
    this.sessionStartedAtMs = Date.now();

    const transport = await this.router.createPlainTransport({
      listenIp: { ip: "127.0.0.1", announcedIp: undefined },
      rtcpMux: true,
      comedia: false,
    });
    this.transport = transport;

    const rtpPort = transport.tuple.localPort;

    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.router.rtpCapabilities as RtpCapabilities,
      paused: false,
    });
    this.consumer = consumer;

    this.consumers.add(producer.id);

    this.ffmpeg = spawn(
      FFMPEG_BIN,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,udp,rtp",
        "-f",
        "rtp",
        "-i",
        `rtp://127.0.0.1:${rtpPort}`,
        "-ac",
        "1",
        "-ar",
        `${DEFAULT_STT_SAMPLE_RATE}`,
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    this.ffmpeg.on("error", (err) => {
      Logger.warn("Failed to start ffmpeg for STT pipeline", {
        ffmpeg: FFMPEG_BIN,
        err,
      });
    });
    this.ffmpeg.on("exit", (code, signal) => {
      if (!this.stopped && code !== 0) {
        Logger.warn("ffmpeg exited unexpectedly in STT pipeline", {
          ffmpeg: FFMPEG_BIN,
          code,
          signal,
        });
      }
    });

    this.sttSocket = new WebSocket(opts.sttUrl, { headers: opts.sttHeaders });
    this.sttSocket.on("open", () => {
      this.sttSocket?.send(
        JSON.stringify({ config: { sample_rate: DEFAULT_STT_SAMPLE_RATE } }),
      );
    });

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (this.sttSocket?.readyState === WebSocket.OPEN) {
        this.sttSocket.send(chunk);
      }
    });

    this.sttSocket.on("error", (err) => {
      Logger.warn("STT websocket error", err);
    });

    this.sttSocket.on("message", (data) => {
      this.handleSttMessage(data.toString(), producer.id);
    });

    const stop = () => this.stop();
    consumer.on("producerclose", stop);
    consumer.on("transportclose", stop);
    transport.on("routerclose", stop);
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
          speaker: msg.speaker || msg.channel || producerId,
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
        speaker: this.producerId || "unknown",
      });
      this.lastPartialText = "";
    }
    if (this.sttSocket?.readyState === WebSocket.OPEN) {
      try {
        this.sttSocket.send(JSON.stringify({ eof: 1 }));
      } catch {
        // noop
      }
    }
    this.sttSocket?.close();
    this.ffmpeg?.kill("SIGTERM");
    try {
      this.consumer?.close();
    } catch {}
    try {
      this.transport?.close();
    } catch {}
    this.consumer = undefined;
    this.transport = undefined;
    if (this.producerId) {
      this.consumers.delete(this.producerId);
      this.producerId = undefined;
    }
    this.sttSocket = undefined;
    this.ffmpeg = undefined;
  }
}

const transcribers = new Map<string, RoomTranscriber>();

export const ensureRoomTranscriber = (channelId: string, router: Router): RoomTranscriber => {
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
