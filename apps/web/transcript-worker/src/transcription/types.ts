import type { TranscriptTranscriptionProvider } from "@conclave/meeting-core/transcript-models";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { Env } from "../types";
import type { VoiceReading } from "./voice-activity";

export type AcceptedUtterance = {
  heard: boolean;
  speaker: TranscriptSpeaker | null;
  fromSequence: number;
  turn?: number;
  ownsNewAudio: boolean;
  untilSequence?: number;
  lineId?: string;
};

export type HeardSpeech = Pick<AcceptedUtterance, "speaker" | "fromSequence" | "turn" | "ownsNewAudio" | "untilSequence">;

export type AudioContext = { voice: VoiceReading; turn: number; at: number; sequence: number; lineId?: string };

export type LiveTranscriptionCallbacks = {
  onAccepted?: (itemId: string, utterance: AcceptedUtterance) => void;
  onHeard?: (itemId: string, heard: HeardSpeech) => void;
  onCommitted: (itemId: string) => void;
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void | Promise<void>;
  onItemFailed?: (itemId: string, message: string) => void | Promise<void>;
  onFailure: (message: string) => void | Promise<void>;
};

export type LiveTranscriptionConnectOptions = {
  env: Env;
  apiKey: string;
  transcriptModel: string;
  language: string;
  languageChosen?: boolean;
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
  finishAudio(): void;
  retire?(itemId: string, heard?: boolean): void;
  close(): void;
}
