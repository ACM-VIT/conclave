import type { TranscriptSpeaker } from "../../types.js";
import { pcm16LeToBase64 } from "./pcm.js";

const TRANSCRIPT_AUDIO_BATCH_TARGET_SAMPLES = 6000;
export const TRANSCRIPT_AUDIO_COMMIT_INTERVAL_MS = 1200;

const PCM16_BYTES_PER_SAMPLE = 2;
const SPEECH_RMS_THRESHOLD = 0.0005;
const SPEECH_HANGOVER_MS = 450;

export type TranscriptAudioBatchSink = {
  sendAudioChunk: (audio: string, speaker: TranscriptSpeaker) => boolean;
  commitAudio: (speaker: TranscriptSpeaker) => boolean;
  clearAudio: (speaker: TranscriptSpeaker) => boolean;
};

export class TranscriptAudioBatcher {
  private pendingChunks: Buffer[] = [];
  private pendingSampleCount = 0;
  private lastChunkAt = 0;
  private lastCommitAt = 0;
  private speechUntil = 0;
  private turnOpen = false;

  constructor(
    private readonly options: {
      speaker: TranscriptSpeaker;
      sink: TranscriptAudioBatchSink;
      now?: () => number;
      batchTargetSamples?: number;
      speechRmsThreshold?: number;
      speechHangoverMs?: number;
    },
  ) {}

  pushPcm(pcm: Buffer): boolean {
    if (pcm.length === 0 || !this.isSpeechPcm(pcm)) return false;
    this.turnOpen = true;
    this.pendingChunks.push(pcm);
    this.pendingSampleCount += Math.floor(pcm.length / PCM16_BYTES_PER_SAMPLE);
    if (this.pendingSampleCount >= this.batchTargetSamples) {
      this.flushQueuedAudio();
    }
    return true;
  }

  commitIfNeeded(): boolean {
    this.flushQueuedAudio();
    if (this.lastChunkAt <= this.lastCommitAt) return false;
    this.lastCommitAt = this.now();
    return this.options.sink.commitAudio(this.options.speaker);
  }

  flushAndCommit(): boolean {
    const committed = this.commitIfNeeded();
    if (committed || this.turnOpen) {
      this.options.sink.clearAudio(this.options.speaker);
      this.turnOpen = false;
    }
    return committed;
  }

  clearEndedTurn(): boolean {
    if (
      !this.turnOpen ||
      this.speechUntil === 0 ||
      this.now() <= this.speechUntil
    ) {
      return false;
    }
    this.commitIfNeeded();
    this.options.sink.clearAudio(this.options.speaker);
    this.turnOpen = false;
    return true;
  }

  private flushQueuedAudio(): void {
    if (this.pendingSampleCount === 0) return;
    const merged = Buffer.concat(this.pendingChunks);
    this.pendingChunks = [];
    this.pendingSampleCount = 0;
    this.lastChunkAt = this.now();
    this.options.sink.sendAudioChunk(
      pcm16LeToBase64(merged),
      this.options.speaker,
    );
  }

  private isSpeechPcm(pcm: Buffer): boolean {
    let sumSquares = 0;
    let samples = 0;
    for (
      let offset = 0;
      offset + PCM16_BYTES_PER_SAMPLE <= pcm.length;
      offset += PCM16_BYTES_PER_SAMPLE
    ) {
      const normalized = pcm.readInt16LE(offset) / 32768;
      sumSquares += normalized * normalized;
      samples += 1;
    }
    const rms = samples === 0 ? 0 : Math.sqrt(sumSquares / samples);
    const now = this.now();
    if (rms >= this.speechRmsThreshold) {
      this.speechUntil = now + this.speechHangoverMs;
      return true;
    }
    return now <= this.speechUntil;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get batchTargetSamples(): number {
    return (
      this.options.batchTargetSamples ?? TRANSCRIPT_AUDIO_BATCH_TARGET_SAMPLES
    );
  }

  private get speechRmsThreshold(): number {
    return this.options.speechRmsThreshold ?? SPEECH_RMS_THRESHOLD;
  }

  private get speechHangoverMs(): number {
    return this.options.speechHangoverMs ?? SPEECH_HANGOVER_MS;
  }
}
