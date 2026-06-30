import {
  getTranscriptTranscriptionModelConfig,
  normalizeRealtimeTranscriptModel,
} from "@conclave/meeting-core/transcript-models";
import { DEFAULT_TRANSCRIPT_MODEL } from "../constants";
import { connectOpenAiRealtimeTranscription } from "./openai-realtime";
import { connectSarvamTranscription } from "./sarvam";
import type {
  LiveTranscriptionConnectOptions,
  LiveTranscriptionSession,
} from "./types";

export type { LiveTranscriptionSession } from "./types";

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
