import type { TranscriptTranscriptionProvider } from "@conclave/meeting-core/transcript-models";
import type { Env } from "../types";

export type LiveTranscriptionCallbacks = {
  onCommitted: (itemId: string) => void;
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void | Promise<void>;
  onFailure: (message: string) => void | Promise<void>;
};

export type LiveTranscriptionConnectOptions = {
  env: Env;
  apiKey: string;
  transcriptModel: string;
  language: string;
  delay: string;
  locale: string;
  localizationPrompt?: string;
  signal?: AbortSignal;
  callbacks: LiveTranscriptionCallbacks;
};

export interface LiveTranscriptionSession {
  readonly provider: TranscriptTranscriptionProvider;
  appendAudio(audioBase64: string): void;
  commitAudio(): void;
  clearAudio(): void;
  close(): void;
}
