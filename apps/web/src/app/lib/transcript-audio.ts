import type { TranscriptSpeaker } from "./types";
import {
  TRANSCRIPT_PCM_WORKLET_NAME,
  TRANSCRIPT_PCM_WORKLET_URL,
} from "./transcript-audio-worklet";

export interface TranscriptRelaySource {
  id: string;
  stream: MediaStream;
}

export interface TranscriptAudioRelayOptions {
  getSpeaker: () => TranscriptSpeaker;
  onAudioChunk: (audioBase64: string, speaker: TranscriptSpeaker) => void;
  onCommit: (speaker: TranscriptSpeaker) => void;
}

type ConnectedSource = {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

const TARGET_SAMPLE_RATE = 24000;
const COMMIT_INTERVAL_MS = 1200;
const FALLBACK_PROCESSOR_SIZE = 4096;

const hasLiveAudioTrack = (stream: MediaStream): boolean =>
  stream
    .getAudioTracks()
    .some((track) => track.enabled && track.readyState === "live");

const arrayBufferToPcm16Base64 = (buffer: ArrayBuffer): string => {
  const samples = new Int16Array(buffer);
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const floatToPcm16Base64 = (
  input: Float32Array,
  inputSampleRate: number,
): string => {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const samples = new Int16Array(length);

  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      sum += input[sampleIndex] ?? 0;
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, count ? sum / count : 0));
    samples[index] = Math.max(
      -32768,
      Math.min(32767, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff)),
    );
  }

  return arrayBufferToPcm16Base64(samples.buffer);
};

export class TranscriptAudioRelay {
  private readonly options: TranscriptAudioRelayOptions;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private fallbackProcessor: ScriptProcessorNode | null = null;
  private outputGain: GainNode | null = null;
  private connectedSources = new Map<string, ConnectedSource>();
  private commitTimer: number | null = null;
  private lastChunkAt = 0;
  private lastCommitAt = 0;

  constructor(options: TranscriptAudioRelayOptions) {
    this.options = options;
  }

  async start(sources: TranscriptRelaySource[]): Promise<void> {
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("This browser does not support meeting transcription audio.");
    }
    if (!this.context) {
      this.context = new AudioContextConstructor();
      this.outputGain = this.context.createGain();
      this.outputGain.gain.value = 0;
      this.outputGain.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    if (!this.workletNode && !this.fallbackProcessor) {
      if (this.context.audioWorklet) {
        await this.initializeWorklet(this.context);
      } else {
        this.initializeFallbackProcessor(this.context);
      }
    }
    this.updateSources(sources);
    this.startCommitTimer();
  }

  updateSources(sources: TranscriptRelaySource[]): void {
    const targetNode = this.workletNode ?? this.fallbackProcessor;
    if (!this.context || !targetNode) return;
    const liveSources = sources.filter((source) => hasLiveAudioTrack(source.stream));
    const liveIds = new Set(liveSources.map((source) => source.id));

    for (const [id, connected] of this.connectedSources) {
      if (liveIds.has(id)) continue;
      connected.source.disconnect();
      connected.gain.disconnect();
      this.connectedSources.delete(id);
    }

    for (const source of liveSources) {
      if (this.connectedSources.has(source.id)) continue;
      const audioSource = this.context.createMediaStreamSource(source.stream);
      const gain = this.context.createGain();
      gain.gain.value = 1;
      audioSource.connect(gain);
      gain.connect(targetNode);
      this.connectedSources.set(source.id, { source: audioSource, gain });
    }
  }

  stop(): void {
    if (this.commitTimer !== null) {
      window.clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
    this.workletNode?.port.postMessage({ type: "flush" });
    for (const connected of this.connectedSources.values()) {
      connected.source.disconnect();
      connected.gain.disconnect();
    }
    this.connectedSources.clear();
    this.workletNode?.disconnect();
    this.workletNode = null;
    if (this.fallbackProcessor) {
      this.fallbackProcessor.disconnect();
      this.fallbackProcessor.onaudioprocess = null;
      this.fallbackProcessor = null;
    }
    this.outputGain?.disconnect();
    this.outputGain = null;
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.lastChunkAt = 0;
    this.lastCommitAt = 0;
  }

  private async initializeWorklet(context: AudioContext): Promise<void> {
    try {
      await context.audioWorklet.addModule(TRANSCRIPT_PCM_WORKLET_URL);
      this.workletNode = new AudioWorkletNode(context, TRANSCRIPT_PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; buffer?: ArrayBuffer };
        if (data.type !== "pcm" || !data.buffer) return;
        this.lastChunkAt = Date.now();
        this.options.onAudioChunk(
          arrayBufferToPcm16Base64(data.buffer),
          this.options.getSpeaker(),
        );
      };
      this.workletNode.connect(this.outputGain!);
    } catch (error) {
      console.warn(
        "[Transcript] AudioWorklet unavailable, using fallback processor.",
        error,
      );
      this.workletNode = null;
      this.initializeFallbackProcessor(context);
    }
  }

  private initializeFallbackProcessor(context: AudioContext): void {
    this.fallbackProcessor = context.createScriptProcessor(
      FALLBACK_PROCESSOR_SIZE,
      1,
      1,
    );
    this.fallbackProcessor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      this.lastChunkAt = Date.now();
      this.options.onAudioChunk(
        floatToPcm16Base64(channel, context.sampleRate),
        this.options.getSpeaker(),
      );
    };
    this.fallbackProcessor.connect(this.outputGain!);
  }

  private startCommitTimer(): void {
    if (this.commitTimer !== null) return;
    this.commitTimer = window.setInterval(() => {
      if (this.lastChunkAt <= this.lastCommitAt) return;
      this.lastCommitAt = Date.now();
      this.options.onCommit(this.options.getSpeaker());
    }, COMMIT_INTERVAL_MS);
  }
}
