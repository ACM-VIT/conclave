export type TranscriptReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type TranscriptTextVerbosity = "low" | "medium" | "high";

export interface TranscriptTranscriptionModelConfig {
  id: string;
  label: string;
  description: string;
  supportsPrompt: boolean;
  supportsLanguageHint: boolean;
  supportsDelay: boolean;
  supportsRealtime: boolean;
}

export interface TranscriptResponseModelConfig {
  id: string;
  label: string;
  description: string;
  supportsReasoning: boolean;
  supportsTextVerbosity: boolean;
  supportsStructuredOutputs: boolean;
  minutesReasoningEffort?: TranscriptReasoningEffort;
  qaReasoningEffort?: TranscriptReasoningEffort;
  minutesVerbosity?: TranscriptTextVerbosity;
  qaVerbosity?: TranscriptTextVerbosity;
  minutesMaxOutputTokens: number;
  qaMaxOutputTokens: number;
}

export const TRANSCRIPT_TRANSCRIPTION_MODELS = [
  {
    id: "gpt-realtime-whisper",
    label: "Realtime Whisper",
    description:
      "Best live transcription latency and word error rate for Realtime audio.",
    supportsPrompt: false,
    supportsLanguageHint: true,
    supportsDelay: true,
    supportsRealtime: true,
  },
  {
    id: "gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    description: "Higher-accuracy request-response transcription model.",
    supportsPrompt: true,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  },
  {
    id: "gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    description: "Lower-cost request-response transcription model.",
    supportsPrompt: true,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  },
] as const satisfies readonly TranscriptTranscriptionModelConfig[];

export const LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS =
  TRANSCRIPT_TRANSCRIPTION_MODELS.filter((model) => model.supportsRealtime);

export const TRANSCRIPT_QA_MODELS = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Best meeting reasoning, synthesis, and Q&A quality.",
    supportsReasoning: true,
    supportsTextVerbosity: true,
    supportsStructuredOutputs: true,
    minutesReasoningEffort: "high",
    qaReasoningEffort: "medium",
    minutesVerbosity: "medium",
    qaVerbosity: "low",
    minutesMaxOutputTokens: 2400,
    qaMaxOutputTokens: 1200,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "High-quality fallback when GPT-5.5 is unavailable.",
    supportsReasoning: true,
    supportsTextVerbosity: true,
    supportsStructuredOutputs: true,
    minutesReasoningEffort: "medium",
    qaReasoningEffort: "medium",
    minutesVerbosity: "medium",
    qaVerbosity: "low",
    minutesMaxOutputTokens: 2200,
    qaMaxOutputTokens: 1100,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Faster, lower-cost meeting assistant and minutes model.",
    supportsReasoning: true,
    supportsTextVerbosity: true,
    supportsStructuredOutputs: true,
    minutesReasoningEffort: "low",
    qaReasoningEffort: "low",
    minutesVerbosity: "low",
    qaVerbosity: "low",
    minutesMaxOutputTokens: 1800,
    qaMaxOutputTokens: 900,
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    description: "Lowest-cost option for lightweight transcript questions.",
    supportsReasoning: true,
    supportsTextVerbosity: true,
    supportsStructuredOutputs: true,
    minutesReasoningEffort: "minimal",
    qaReasoningEffort: "minimal",
    minutesVerbosity: "low",
    qaVerbosity: "low",
    minutesMaxOutputTokens: 1400,
    qaMaxOutputTokens: 700,
  },
] as const satisfies readonly TranscriptResponseModelConfig[];

export const DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL =
  TRANSCRIPT_TRANSCRIPTION_MODELS[0].id;
export const DEFAULT_TRANSCRIPT_QA_MODEL = TRANSCRIPT_QA_MODELS[0].id;

export const getTranscriptTranscriptionModelConfig = (
  modelId: string,
): TranscriptTranscriptionModelConfig =>
  TRANSCRIPT_TRANSCRIPTION_MODELS.find((model) => model.id === modelId) ?? {
    id: modelId,
    label: modelId,
    description: "Custom transcription model",
    supportsPrompt: false,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  };

export const normalizeRealtimeTranscriptModel = (
  modelId: string,
  fallback: string = DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
): string => {
  const config = getTranscriptTranscriptionModelConfig(modelId);
  return config.supportsRealtime ? config.id : fallback;
};

export const getTranscriptResponseModelConfig = (
  modelId: string,
): TranscriptResponseModelConfig =>
  TRANSCRIPT_QA_MODELS.find((model) => model.id === modelId) ?? {
    id: modelId,
    label: modelId,
    description: "Custom OpenAI-compatible response model",
    supportsReasoning: false,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: false,
    minutesMaxOutputTokens: 1800,
    qaMaxOutputTokens: 900,
  };
