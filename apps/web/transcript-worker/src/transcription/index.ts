import type { TranscriptTranscriptionProvider } from "@conclave/ai/models";
import { captionLanguageCode } from "@conclave/meeting-core/caption-languages";
import {
  getTranscriptTranscriptionModelConfig,
  normalizeRealtimeTranscriptModel,
} from "@conclave/meeting-core/transcript-models";
import { DEFAULT_TRANSCRIPT_MODEL } from "../constants";
import { connectOpenAiRealtimeTranscription } from "./openai-realtime";
import {
  connectSarvamTranscription,
  sarvamCanTranscribe,
  sarvamProviderLanguage,
} from "./sarvam";
import type {
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "./types";

export type { LiveTranscriptionSession } from "./types";

export const canTranscribeLanguage = (
  provider: TranscriptTranscriptionProvider,
  language: string,
  languageChosen: boolean,
  env: LiveTranscriptionConnectOptions["env"],
): boolean =>
  provider !== "sarvam" || sarvamCanTranscribe(language, languageChosen, env);

/** The exact language code a provider connection is sent. */
export const transcriptionProviderLanguage = (
  provider: TranscriptTranscriptionProvider,
  options: {
    language: string;
    languageChosen?: boolean;
    locale: string;
    env: LiveTranscriptionConnectOptions["env"];
  },
): string => (provider === "sarvam" ? sarvamProviderLanguage(options) : options.language);

/**
 * The language a session shows, derived only from the code its provider is
 * sent, through the shared caption language table.
 */
export const shownTranscriptionLanguage = (
  providerLanguage: string,
): string | undefined => captionLanguageCode(providerLanguage);

export const connectLiveTranscriptionProvider = async (
  options: LiveTranscriptionConnectOptions,
): Promise<LiveTranscriptionSession> => {
  const transcriptModel = normalizeRealtimeTranscriptModel(
    options.transcriptModel,
    DEFAULT_TRANSCRIPT_MODEL,
  );
  const config = getTranscriptTranscriptionModelConfig(transcriptModel);
  const connectOptions = {
    ...options,
    transcriptModel,
  };

  if (config.provider === "sarvam") {
    return connectSarvamTranscription(connectOptions);
  }

  return connectOpenAiRealtimeTranscription(connectOptions);
};
