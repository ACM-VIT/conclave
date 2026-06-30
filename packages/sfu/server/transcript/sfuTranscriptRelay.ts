import type { Consumer, DirectTransport } from "mediasoup/types";
import type {
  TranscriptAudioProducerEntry,
  Room,
} from "../../config/classes/Room.js";
import type { TranscriptSpeaker } from "../../types.js";
import { Logger } from "../../utilities/loggers.js";
import {
  TranscriptAudioBatcher,
  TRANSCRIPT_AUDIO_COMMIT_INTERVAL_MS,
  type TranscriptAudioBatchSink,
} from "./audioBatcher.js";
import {
  TranscriptOpusDecoder,
  type TranscriptOpusDecoderLike,
} from "./opusDecoder.js";
import { extractRtpPayload } from "./rtp.js";
import {
  TranscriptWorkerRelayClient,
  type TranscriptWorkerRelayConnection,
} from "./workerClient.js";

type ActiveAudioConsumer = {
  consumer: Consumer;
  decoder: TranscriptOpusDecoderLike;
  batcher: TranscriptAudioBatcher;
  packetsReceived: number;
  decodedFrames: number;
  queuedFrames: number;
  commitsSent: number;
  decodeFailures: number;
  lastDecodeFailureLogAt: number;
  lastDropLogAt: number;
};

const WORKER_SEND_WARN_INTERVAL_MS = 5000;

const toTranscriptSpeaker = (
  entry: TranscriptAudioProducerEntry,
): TranscriptSpeaker => ({
  userId: entry.userId,
  displayName: entry.displayName,
  source: entry.type === "screen" ? "screen" : "remote",
});

export class SfuTranscriptRelay implements TranscriptAudioBatchSink {
  private directTransport: DirectTransport | null = null;
  private workerClient: TranscriptWorkerRelayConnection | null = null;
  private readonly consumers = new Map<string, ActiveAudioConsumer>();
  private readonly pendingProducerIds = new Set<string>();
  private commitTimer: NodeJS.Timeout | null = null;
  private lastWorkerSendWarnAt = 0;
  private started = false;

  constructor(
    private readonly options: {
      room: Room;
      workerUrl: string;
      workerToken: string;
      controllerUserId: string;
      controllerDisplayName: string;
      createWorkerClient?: (options: {
        workerUrl: string;
        roomId: string;
        token: string;
        onError?: (message: string) => void;
        onClose?: (message: string) => void;
      }) => TranscriptWorkerRelayConnection;
      createDecoder?: () => TranscriptOpusDecoderLike;
      onClosed?: (message: string) => void;
    },
  ) {}

  get controllerUserId(): string {
    return this.options.controllerUserId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.options.room.router.closed) {
      throw new Error("Room media router is closed.");
    }
    Logger.info(
      `Transcript SFU relay starting for room ${this.options.room.id} (controller ${this.options.controllerUserId}).`,
    );

    this.workerClient = (
      this.options.createWorkerClient ?? ((clientOptions) =>
        new TranscriptWorkerRelayClient(clientOptions))
    )({
      workerUrl: this.options.workerUrl,
      roomId: this.options.room.id,
      token: this.options.workerToken,
      onError: (message) => {
        Logger.warn(
          `Transcript worker relay error for room ${this.options.room.id}: ${message}`,
        );
      },
      onClose: (message) => {
        this.handleWorkerRelayClose(message);
      },
    });
    await this.workerClient.connect();

    this.directTransport = await this.options.room.router.createDirectTransport({
      appData: {
        kind: "transcript-sfu-relay",
        controllerUserId: this.options.controllerUserId,
        controllerDisplayName: this.options.controllerDisplayName,
      },
    });
    this.started = true;
    await this.syncProducers();
    this.startCommitTimer();
    Logger.info(
      `Transcript SFU relay ready for room ${this.options.room.id} with ${this.consumers.size} audio producer(s).`,
    );
  }

  async syncProducers(): Promise<void> {
    if (!this.started || !this.directTransport) return;
    const entries = this.options.room
      .getTranscriptAudioProducerEntries()
      .filter((entry) => !entry.paused && !entry.producer.closed);
    const activeProducerIds = new Set(entries.map((entry) => entry.producerId));
    if (entries.length === 0) {
      Logger.info(
        `Transcript SFU relay has no active audio producers in room ${this.options.room.id}.`,
      );
    }

    for (const [producerId, active] of this.consumers) {
      if (activeProducerIds.has(producerId)) continue;
      this.flushAndCommit(active);
      this.closeConsumer(producerId, active);
    }

    for (const entry of entries) {
      if (
        this.consumers.has(entry.producerId) ||
        this.pendingProducerIds.has(entry.producerId)
      ) {
        continue;
      }
      this.pendingProducerIds.add(entry.producerId);
      try {
        const active = await this.addConsumer(entry);
        if (!active) continue;
        if (!this.isProducerStillActive(entry.producerId)) {
          this.closeConsumer(entry.producerId, active);
        }
      } catch (error) {
        Logger.warn(
          `Transcript SFU relay could not attach audio producer ${entry.producerId} in room ${this.options.room.id}`,
          error,
        );
      } finally {
        this.pendingProducerIds.delete(entry.producerId);
      }
    }
  }

  close(options: { flushBufferedAudio?: boolean } = {}): void {
    this.started = false;
    if (this.commitTimer) {
      clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
    for (const [producerId, active] of Array.from(this.consumers)) {
      if (options.flushBufferedAudio) {
        this.flushAndCommit(active);
      }
      this.closeConsumer(producerId, active);
    }
    this.consumers.clear();
    this.pendingProducerIds.clear();
    try {
      this.directTransport?.close();
    } catch {}
    this.directTransport = null;
    this.workerClient?.close();
    this.workerClient = null;
  }

  private handleWorkerRelayClose(message: string): void {
    if (!this.started) return;
    Logger.warn(
      `Transcript worker relay closed for room ${this.options.room.id}: ${message}`,
    );
    this.close();
    this.options.onClosed?.(message);
  }

  private async addConsumer(
    entry: TranscriptAudioProducerEntry,
  ): Promise<ActiveAudioConsumer | null> {
    if (!this.directTransport) return null;
    const consumer = await this.directTransport.consume({
      producerId: entry.producerId,
      rtpCapabilities: this.options.room.router.rtpCapabilities,
      paused: false,
      enableRtx: false,
      ignoreDtx: true,
      appData: {
        kind: "transcript-sfu-relay-consumer",
        producerUserId: entry.userId,
        producerType: entry.type,
      },
    });
    if (
      !this.started ||
      !this.directTransport ||
      this.directTransport.closed ||
      this.consumers.has(entry.producerId) ||
      !this.isProducerStillActive(entry.producerId)
    ) {
      try {
        consumer.close();
      } catch {}
      return null;
    }
    const speaker = toTranscriptSpeaker(entry);
    const active: ActiveAudioConsumer = {
      consumer,
      decoder: (this.options.createDecoder ?? (() => new TranscriptOpusDecoder()))(),
      batcher: new TranscriptAudioBatcher({
        speaker,
        sink: this,
      }),
      packetsReceived: 0,
      decodedFrames: 0,
      queuedFrames: 0,
      commitsSent: 0,
      decodeFailures: 0,
      lastDecodeFailureLogAt: 0,
      lastDropLogAt: 0,
    };
    this.consumers.set(entry.producerId, active);
    Logger.info(
      `Transcript SFU relay attached audio producer ${entry.producerId} for ${entry.displayName} (${entry.userId}) in room ${this.options.room.id}.`,
    );

    consumer.on("rtp", (packet) => {
      this.handleRtpPacket(entry.producerId, packet);
    });
    consumer.on("producerpause", () => {
      this.flushAndCommit(active);
      this.closeConsumer(entry.producerId, active);
    });
    consumer.on("producerclose", () => {
      this.flushAndCommit(active);
      this.closeConsumer(entry.producerId, active);
    });
    consumer.observer.on("close", () => {
      this.closeConsumer(entry.producerId, active);
    });
    return active;
  }

  private isProducerStillActive(producerId: string): boolean {
    return this.options.room
      .getTranscriptAudioProducerEntries()
      .some(
        (entry) =>
          entry.producerId === producerId &&
          !entry.paused &&
          !entry.producer.closed,
      );
  }

  private handleRtpPacket(producerId: string, packet: Buffer): void {
    const active = this.consumers.get(producerId);
    if (!active) return;
    active.packetsReceived += 1;
    if (active.packetsReceived === 1) {
      Logger.info(
        `Transcript SFU relay received first RTP packet from producer ${producerId} in room ${this.options.room.id}.`,
      );
    }
    const payload = extractRtpPayload(packet);
    if (!payload) return;

    let pcm: Buffer | null = null;
    try {
      pcm = active.decoder.decodeTo24kMono(payload);
    } catch (error) {
      this.warnDecodeFailure(producerId, active, error);
      return;
    }
    if (!pcm || pcm.length === 0) return;
    active.decodeFailures = 0;
    active.decodedFrames += 1;
    const queued = active.batcher.pushPcm(pcm);
    if (queued) {
      active.queuedFrames += 1;
      if (active.queuedFrames === 1) {
        Logger.info(
          `Transcript SFU relay queued first PCM batch from producer ${producerId} in room ${this.options.room.id}.`,
        );
      }
      return;
    }
    const now = Date.now();
    if (
      active.queuedFrames === 0 &&
      active.decodedFrames >= 250 &&
      now - active.lastDropLogAt >= WORKER_SEND_WARN_INTERVAL_MS
    ) {
      active.lastDropLogAt = now;
      Logger.warn(
        `Transcript SFU relay is receiving and decoding audio from producer ${producerId}, but the speech gate has not queued any audio yet.`,
      );
    }
  }

  private startCommitTimer(): void {
    if (this.commitTimer) return;
    this.commitTimer = setInterval(() => {
      for (const active of this.consumers.values()) {
        this.commitIfNeeded(active);
      }
    }, TRANSCRIPT_AUDIO_COMMIT_INTERVAL_MS);
  }

  private commitIfNeeded(active: ActiveAudioConsumer): void {
    const committed = active.batcher.commitIfNeeded();
    if (!committed) return;
    active.commitsSent += 1;
    if (active.commitsSent === 1) {
      Logger.info(
        `Transcript SFU relay committed first audio batch for producer ${active.consumer.producerId} in room ${this.options.room.id}.`,
      );
    }
  }

  private flushAndCommit(active: ActiveAudioConsumer): void {
    const committed = active.batcher.flushAndCommit();
    if (!committed) return;
    active.commitsSent += 1;
    if (active.commitsSent === 1) {
      Logger.info(
        `Transcript SFU relay committed first audio batch for producer ${active.consumer.producerId} in room ${this.options.room.id}.`,
      );
    }
  }

  sendAudioChunk(audio: string, speaker: TranscriptSpeaker): boolean {
    const sent = this.workerClient?.sendAudioChunk(audio, speaker) ?? false;
    if (!sent) this.warnWorkerSendFailure("audio chunk");
    return sent;
  }

  commitAudio(speaker: TranscriptSpeaker): boolean {
    const sent = this.workerClient?.commitAudio(speaker) ?? false;
    if (!sent) this.warnWorkerSendFailure("audio commit");
    return sent;
  }

  clearAudio(speaker: TranscriptSpeaker): boolean {
    const sent = this.workerClient?.clearAudio(speaker) ?? false;
    if (!sent) this.warnWorkerSendFailure("audio clear");
    return sent;
  }

  async prepareHandoff(): Promise<boolean> {
    return this.workerClient?.prepareHandoff() ?? false;
  }

  private warnWorkerSendFailure(action: string): void {
    const now = Date.now();
    if (now - this.lastWorkerSendWarnAt < WORKER_SEND_WARN_INTERVAL_MS) return;
    this.lastWorkerSendWarnAt = now;
    Logger.warn(
      `Transcript SFU relay could not send ${action} to worker for room ${this.options.room.id}; worker socket is not open.`,
    );
  }

  private warnDecodeFailure(
    producerId: string,
    active: ActiveAudioConsumer,
    error: unknown,
  ): void {
    active.decodeFailures += 1;
    const now = Date.now();
    if (
      active.decodeFailures > 1 &&
      now - active.lastDecodeFailureLogAt < WORKER_SEND_WARN_INTERVAL_MS
    ) {
      return;
    }
    active.lastDecodeFailureLogAt = now;
    Logger.warn(
      `Transcript Opus decode failed for producer ${producerId} in room ${this.options.room.id}; packet dropped and decoder reset.`,
      error,
    );
  }

  private closeConsumer(
    producerId: string,
    active: ActiveAudioConsumer,
  ): void {
    if (this.consumers.get(producerId) !== active) return;
    this.consumers.delete(producerId);
    try {
      active.consumer.close();
    } catch {}
    active.decoder.close();
  }
}
