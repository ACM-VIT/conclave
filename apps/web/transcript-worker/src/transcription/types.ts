import type { TranscriptTranscriptionProvider } from "@conclave/meeting-core/transcript-models";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { Env } from "../types";
import type { VoiceReading } from "./voice-activity";

/** An utterance a provider took on, as it reports it. */
export type AcceptedUtterance = {
  /** Our voice check heard speech for it. */
  heard: boolean;
  /** The speaker of the audio that started it. */
  speaker: TranscriptSpeaker | null;
  /** When its audio began, so its line takes that speaker's audio from there on. */
  since: number;
  /** The room's turn its audio is in; its line takes audio from that turn only. */
  turn?: number;
  /** Its turn is still going, so that speaker's audio from now on is its too. */
  ownsNewAudio: boolean;
  /** When it was heard in a line's replayed audio, that line. */
  lineId?: string;
};

/** Speech our voice check heard for an utterance after it was accepted, so its line takes that audio. */
export type HeardSpeech = Pick<AcceptedUtterance, "speaker" | "since" | "turn" | "ownsNewAudio" | "lineId">;

/** What the room knows about a chunk it sends: our voice check's reading, and the line it belongs to on a replay. */
export type AudioContext = { voice: VoiceReading; turn: number; lineId?: string };

export type LiveTranscriptionCallbacks = {
  /** The provider took an utterance it owes a final for. */
  onAccepted?: (itemId: string, utterance: AcceptedUtterance) => void;
  /** Our voice check heard speech for an accepted utterance after it was accepted. */
  onHeard?: (itemId: string, heard: HeardSpeech) => void;
  onCommitted: (itemId: string) => void;
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void | Promise<void>;
  /** One item could not be transcribed; the connection itself is fine. */
  onItemFailed?: (itemId: string, message: string) => void | Promise<void>;
  onFailure: (message: string) => void | Promise<void>;
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
  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker, context?: AudioContext): void;
  commitAudio(): void;
  clearAudio(): void;
  /** Asks a streaming provider to finalize the audio it has already received. */
  finishAudio(): void;
  /** Forgets an utterance whose line ended, so it never takes a later utterance's final. */
  retire?(itemId: string): void;
  close(): void;
}
