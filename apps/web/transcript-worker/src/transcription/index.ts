import type { TranscriptTranscriptionProvider } from "@conclave/ai/models";
import {
  getTranscriptTranscriptionModelConfig,
  normalizeRealtimeTranscriptModel,
} from "@conclave/meeting-core/transcript-models";
import { DEFAULT_TRANSCRIPT_MODEL } from "../constants";
import { connectOpenAiRealtimeTranscription } from "./openai-realtime";
import {
  connectSarvamTranscription,
  sarvamCanTranscribe,
  sarvamReportedLanguage,
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

/** The language a session reports: what the provider really transcribes. */
export const reportedTranscriptionLanguage = (
  provider: TranscriptTranscriptionProvider,
  language: string,
  languageChosen: boolean,
  env: LiveTranscriptionConnectOptions["env"],
): string | undefined =>
  provider === "sarvam"
    ? sarvamReportedLanguage(language, languageChosen, env)
    : language;

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
