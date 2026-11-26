import type { TranscriptTranscriptionProvider } from "@conclave/meeting-core/transcript-models";
import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";
import type { Env } from "../types";
import type { VoiceReading } from "./voice-activity";
import type { SocketBudget } from "./socket-budget";

export type SpeechPlace = { order: number; startMs: number };

export class AudioNotSent extends Error {
  constructor() {
    super("The provider connection for this speaker is not taking audio.");
  }
}

export type HeardSpeech = {
  speaker: TranscriptSpeaker | null;
  fromSequence: number;
  untilSequence?: number;
  turn?: number;
  place?: SpeechPlace;
  fromItem?: string;
};

export type AcceptedUtterance = HeardSpeech & { heard: boolean; lineId?: string };

export type AudioContext = {
  voice: VoiceReading;
  turn: number;
  at: number;
  sequence: number;
  order: number;
  createdAt: number;
  lineId?: string;
};

export type LiveTranscriptionCallbacks = {
  onAccepted?: (itemId: string, utterance: AcceptedUtterance) => void;
  onHeard?: (itemId: string, heard: HeardSpeech) => void;
  onCommitted: (itemId: string) => void;
  onDelta: (itemId: string, delta: string) => void;
  onFinal: (itemId: string, transcript: string) => void | Promise<void>;
  onItemFailed?: (itemId: string, message: string) => void | Promise<void>;
  onItemLost?: (itemId: string) => void | Promise<void>;
  onReady?: () => void;
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
  socketBudget?: SocketBudget;
  callbacks: LiveTranscriptionCallbacks;
};

export interface LiveTranscriptionSession {
  readonly provider: TranscriptTranscriptionProvider;
  ready?(speaker: TranscriptSpeaker): boolean;
  appendAudio(audioBase64: string, speaker?: TranscriptSpeaker, context?: AudioContext): string | null;
  commitAudio(): void;
  clearAudio(speaker?: TranscriptSpeaker): void;
  fence?(providerItemId: string): void;
  withholds?(speaker: TranscriptSpeaker, voice: VoiceReading, at: number): boolean;
  owes?(): boolean;
  settle?(): void;
  finishAudio(): void;
  close(): void;
}
