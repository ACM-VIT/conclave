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
    if (this.consumers.has(producer.id) || this.stopped) return;
    this.producerId = producer.id;

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
      "ffmpeg",
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
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    this.sttSocket = new WebSocket(opts.sttUrl, { headers: opts.sttHeaders });

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (this.sttSocket?.readyState === WebSocket.OPEN) {
        this.sttSocket.send(chunk);
      }
    });

    this.sttSocket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.text) {
          const speaker = msg.speaker || msg.channel || "unknown";
          const startMs = Number(msg.start) || Date.now();
          const endMs = Number(msg.end) || startMs;
          this.transcript.push({
            startMs,
            endMs,
            text: msg.text,
            speaker,
          });
        }
      } catch (err) {
        Logger.warn("STT parse error", err);
      }
    });

    const stop = () => this.stop();
    consumer.on("producerclose", stop);
    consumer.on("transportclose", stop);
    transport.on("routerclose", stop);
  }

  getTranscript(): TranscriptChunk[] {
    return this.transcript;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
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
