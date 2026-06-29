import type { TranscriptSpeaker } from "./types";
import {
  TRANSCRIPT_PCM_WORKLET_NAME,
  TRANSCRIPT_PCM_WORKLET_URL,
} from "./transcript-audio-worklet";

export interface TranscriptRelaySource {
  id: string;
  stream: MediaStream;
  speaker: TranscriptSpeaker;
}

export interface TranscriptAudioRelayOptions {
  onAudioChunk: (audioBase64: string, speaker: TranscriptSpeaker) => void;
  onCommit: (speaker: TranscriptSpeaker) => void;
}

type ConnectedSource = {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  processor: AudioWorkletNode | ScriptProcessorNode;
  speaker: TranscriptSpeaker;
  speechUntil: number;
  lastChunkAt: number;
  lastCommitAt: number;
};

const TARGET_SAMPLE_RATE = 24000;
const COMMIT_INTERVAL_MS = 1200;
const FALLBACK_PROCESSOR_SIZE = 8192;
const SPEECH_RMS_THRESHOLD = 0.004;
const SPEECH_HANGOVER_MS = 450;

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

const computeRms = (input: Float32Array): number => {
  if (input.length === 0) return 0;
  let sumSquares = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / input.length);
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

const isSpeechFrame = (connected: ConnectedSource, level: number): boolean => {
  const now = Date.now();
  if (level >= SPEECH_RMS_THRESHOLD) {
    connected.speechUntil = now + SPEECH_HANGOVER_MS;
    return true;
  }
  return now <= connected.speechUntil;
};

const isAudioWorkletProcessor = (
  processor: ConnectedSource["processor"],
): processor is AudioWorkletNode =>
  typeof AudioWorkletNode !== "undefined" &&
  processor instanceof AudioWorkletNode;

export class TranscriptAudioRelay {
  private readonly options: TranscriptAudioRelayOptions;
  private context: AudioContext | null = null;
  private outputGain: GainNode | null = null;
  private connectedSources = new Map<string, ConnectedSource>();
  private commitTimer: number | null = null;
  private workletModulePromise: Promise<void> | null = null;
  private workletUnavailable = false;

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
    await this.updateSources(sources);
    this.startCommitTimer();
  }

  async updateSources(sources: TranscriptRelaySource[]): Promise<void> {
    if (!this.context || !this.outputGain) return;
    const liveSources = sources.filter((source) => hasLiveAudioTrack(source.stream));
    const liveIds = new Set(liveSources.map((source) => source.id));

    for (const [id, connected] of this.connectedSources) {
      if (liveIds.has(id)) continue;
      this.commitIfNeeded(connected);
      this.disconnectSource(connected);
      this.connectedSources.delete(id);
    }

    for (const source of liveSources) {
      const existing = this.connectedSources.get(source.id);
      if (existing) {
        existing.speaker = source.speaker;
        continue;
      }
      const connected = await this.connectSource(source);
      this.connectedSources.set(source.id, connected);
    }
  }

  stop(): void {
    if (this.commitTimer !== null) {
      window.clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
    for (const connected of this.connectedSources.values()) {
      this.commitIfNeeded(connected);
      if (isAudioWorkletProcessor(connected.processor)) {
        connected.processor.port.postMessage({ type: "flush" });
      }
      this.disconnectSource(connected);
    }
    this.connectedSources.clear();
    this.outputGain?.disconnect();
    this.outputGain = null;
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
  }

  private async connectSource(
    relaySource: TranscriptRelaySource,
  ): Promise<ConnectedSource> {
    const context = this.context!;
    const source = context.createMediaStreamSource(relaySource.stream);
    const gain = context.createGain();
    gain.gain.value = 1;
    source.connect(gain);

    const connected: ConnectedSource = {
      source,
      gain,
      processor: await this.createProcessor(),
      speaker: relaySource.speaker,
      speechUntil: 0,
      lastChunkAt: 0,
      lastCommitAt: 0,
    };

    this.attachProcessorHandler(connected);
    gain.connect(connected.processor);
    connected.processor.connect(this.outputGain!);
    return connected;
  }

  private async createProcessor(): Promise<
    AudioWorkletNode | ScriptProcessorNode
  > {
    const context = this.context!;
    if (context.audioWorklet && !this.workletUnavailable) {
      try {
        await this.ensureWorkletModule(context);
        return new AudioWorkletNode(context, TRANSCRIPT_PCM_WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
      } catch (error) {
        console.warn(
          "[Transcript] AudioWorklet unavailable, using fallback processor.",
          error,
        );
        this.workletUnavailable = true;
      }
    }

    return context.createScriptProcessor(FALLBACK_PROCESSOR_SIZE, 1, 1);
  }

  private ensureWorkletModule(context: AudioContext): Promise<void> {
    if (!this.workletModulePromise) {
      this.workletModulePromise = context.audioWorklet.addModule(
        TRANSCRIPT_PCM_WORKLET_URL,
      );
    }
    return this.workletModulePromise;
  }

  private attachProcessorHandler(connected: ConnectedSource): void {
    if (isAudioWorkletProcessor(connected.processor)) {
      connected.processor.port.onmessage = (event: MessageEvent) => {
        const data = event.data as {
          type?: string;
          buffer?: ArrayBuffer;
          level?: number;
        };
        if (data.type !== "pcm" || !data.buffer) return;
        if (!isSpeechFrame(connected, data.level ?? 0)) return;
        connected.lastChunkAt = Date.now();
        this.options.onAudioChunk(
          arrayBufferToPcm16Base64(data.buffer),
          connected.speaker,
        );
      };
      return;
    }

    connected.processor.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0);
      const level = computeRms(channel);
      if (!isSpeechFrame(connected, level)) return;
      connected.lastChunkAt = Date.now();
      this.options.onAudioChunk(
        floatToPcm16Base64(channel, this.context!.sampleRate),
        connected.speaker,
      );
    };
  }

  private disconnectSource(connected: ConnectedSource): void {
    try {
      connected.source.disconnect();
      connected.gain.disconnect();
      if (isAudioWorkletProcessor(connected.processor)) {
        connected.processor.port.onmessage = null;
      } else {
        connected.processor.onaudioprocess = null;
      }
      connected.processor.disconnect();
    } catch {}
  }

  private startCommitTimer(): void {
    if (this.commitTimer !== null) return;
    this.commitTimer = window.setInterval(() => {
      for (const connected of this.connectedSources.values()) {
        this.commitIfNeeded(connected);
      }
    }, COMMIT_INTERVAL_MS);
  }

  private commitIfNeeded(connected: ConnectedSource): void {
    if (connected.lastChunkAt <= connected.lastCommitAt) return;
    connected.lastCommitAt = Date.now();
    this.options.onCommit(connected.speaker);
  }
}
