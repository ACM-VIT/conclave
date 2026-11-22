import type { TranscriptTranscriptionProvider } from "@conclave/meeting-core/transcript-models";
import type { Env } from "../types";

export type LiveTranscriptionCallbacks = {
  /** The provider took an utterance it owes a final for; its place is fixed now. */
  onAccepted?: (itemId: string) => void;
  /** An accepted place turned out to hold no utterance, so it ends with nothing to show. */
  onReleased?: (itemId: string) => void;
  onCommitted: (itemId: string) => void;
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void | Promise<void>;
  onFailure: (message: string) => void | Promise<void>;
  /** One item could not be transcribed; the connection itself is fine. */
  onItemFailed?: (itemId: string, message: string) => void | Promise<void>;
};

export type LiveTranscriptionConnectOptions = {
  env: Env;
  apiKey: string;
  transcriptModel: string;
  language: string;
  languageChosen?: boolean;
  /** The exact code to send the provider; resolved from the rest when absent. */
  providerLanguage?: string;
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
  /** Asks a streaming provider to finalize the audio it has already received. */
  finishAudio(): void;
  close(): void;
}
