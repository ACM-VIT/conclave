export type TranscriptReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type TranscriptTextVerbosity = "low" | "medium" | "high";

export type TranscriptTranscriptionProvider = "openai" | "sarvam";

export type AiTextProvider = "openai" | "anthropic";
export type AiProvider =
  TranscriptTranscriptionProvider | AiTextProvider | "elevenlabs";

export type TranscriptProviderKeyAvailability = Partial<
  Record<TranscriptTranscriptionProvider | AiTextProvider, boolean>
>;

export interface TranscriptTranscriptionModelConfig {
  id: string;
  label: string;
  provider: TranscriptTranscriptionProvider;
  description: string;
  supportsPrompt: boolean;
  supportsLanguageHint: boolean;
  supportsDelay: boolean;
  supportsRealtime: boolean;
}

export interface TranscriptResponseModelConfig {
  provider: AiTextProvider;
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
    id: "gpt-live-transcribe",
    label: "GPT Live Transcribe",
    provider: "openai",
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
    provider: "openai",
    description: "Higher-accuracy request-response transcription model.",
    supportsPrompt: true,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  },
  {
    id: "gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    provider: "openai",
    description: "Lower-cost request-response transcription model.",
    supportsPrompt: true,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  },
  {
    id: "saaras:v3",
    label: "Sarvam Saaras v3",
    provider: "sarvam",
    description:
      "Indian language and code-mixed live transcription through Sarvam.",
    supportsPrompt: false,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: true,
  },
] as const satisfies readonly TranscriptTranscriptionModelConfig[];

export const LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS =
  TRANSCRIPT_TRANSCRIPTION_MODELS.filter((model) => model.supportsRealtime);

export const TRANSCRIPT_QA_MODELS = [
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
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
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    description: "Fast for general meeting use cases.",
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
    id: "gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    description: "Highest quality frontier intelligence model.",
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
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    description: "Balanced speed and quality for meeting summaries and tools.",
    supportsReasoning: true,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: true,
    minutesMaxOutputTokens: 4096,
    qaMaxOutputTokens: 4096,
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    description: "Fast, efficient summaries and everyday questions.",
    supportsReasoning: true,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: true,
    minutesMaxOutputTokens: 4096,
    qaMaxOutputTokens: 4096,
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    description: "Complex synthesis and multi-step tool use.",
    supportsReasoning: true,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: true,
    minutesMaxOutputTokens: 8192,
    qaMaxOutputTokens: 8192,
  },
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    label: "Claude Fable 5.1",
    description: "Most demanding reasoning and long-running work.",
    supportsReasoning: true,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: true,
    minutesMaxOutputTokens: 8192,
    qaMaxOutputTokens: 8192,
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
    provider: "openai",
    description: "Custom transcription model",
    supportsPrompt: false,
    supportsLanguageHint: true,
    supportsDelay: false,
    supportsRealtime: false,
  };

export const getTranscriptTranscriptionProvider = (
  modelId: string,
): TranscriptTranscriptionProvider =>
  getTranscriptTranscriptionModelConfig(modelId).provider;

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
    provider: "openai",
    description: "Custom OpenAI-compatible response model",
    supportsReasoning: false,
    supportsTextVerbosity: false,
    supportsStructuredOutputs: false,
    minutesMaxOutputTokens: 1800,
    qaMaxOutputTokens: 900,
  };

export const AI_RESPONSE_MODELS = TRANSCRIPT_QA_MODELS;
export const AI_DEFAULT_MODELS = {
  assistant: DEFAULT_TRANSCRIPT_QA_MODEL,
  transcript: DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
  games: "gpt-5.6-luna",
  voice: "gpt-realtime-1.5",
  moderation: "omni-moderation-latest",
  tts: "eleven_multilingual_v2",
} as const;

export const AI_ENDPOINTS = {
  openai: {
    realtime: "https://api.openai.com/v1/realtime",
    realtimeClientSecrets: "https://api.openai.com/v1/realtime/client_secrets",
    realtimeCalls: "https://api.openai.com/v1/realtime/calls",
  },
  sarvam: { transcription: "wss://api.sarvam.ai/speech-to-text/ws" },
  elevenlabs: { apiBase: "https://api.elevenlabs.io/v1" },
} as const;

export const AI_PROVIDERS = {
  openai: {
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keysUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  elevenlabs: {
    label: "ElevenLabs",
    keyEnv: "ELEVENLABS_API_KEY",
    keysUrl: "https://elevenlabs.io/docs/api-reference/authentication",
  },
  sarvam: {
    label: "Sarvam",
    keyEnv: "SARVAM_API_KEY",
    keysUrl: "https://dashboard.sarvam.ai",
  },
} as const;

export type AiEnvironment = Partial<
  Record<
    | "OPENAI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "SARVAM_API_KEY"
    | "ELEVENLABS_API_KEY"
    | "OPENAI_BASE_URL"
    | "CLOUDFLARE_AI_GATEWAY_OPENAI_URL"
    | "ANTHROPIC_BASE_URL"
    | "CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL"
    | "CONCLAVE_ASSISTANT_MODEL"
    | "SFU_GAME_AI_MODEL",
    string
  >
>;

export const getProviderApiKey = (
  env: AiEnvironment,
  provider: AiProvider,
): string => env[AI_PROVIDERS[provider].keyEnv]?.trim() || "";

export const getResponseProvider = (model: string): AiTextProvider =>
  getTranscriptResponseModelConfig(model).provider;

export const isResponseModel = (model: string): boolean =>
  AI_RESPONSE_MODELS.some((entry) => entry.id === model);

export const resolveConfiguredResponseModel = (
  value: string | undefined,
  fallback: string,
): string => {
  const model = value?.trim() || fallback;
  if (!isResponseModel(model))
    throw new Error(`Unsupported AI response model: ${model}`);
  return model;
};

export const readAiEnvironment = (
  source: Record<string, string | undefined>,
): AiEnvironment => ({
  OPENAI_API_KEY: source.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
  SARVAM_API_KEY: source.SARVAM_API_KEY,
  ELEVENLABS_API_KEY: source.ELEVENLABS_API_KEY,
  OPENAI_BASE_URL: source.OPENAI_BASE_URL,
  CLOUDFLARE_AI_GATEWAY_OPENAI_URL: source.CLOUDFLARE_AI_GATEWAY_OPENAI_URL,
  ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL,
  CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL:
    source.CLOUDFLARE_AI_GATEWAY_ANTHROPIC_URL,
  CONCLAVE_ASSISTANT_MODEL: source.CONCLAVE_ASSISTANT_MODEL,
  SFU_GAME_AI_MODEL: source.SFU_GAME_AI_MODEL,
});

export const isProviderApiKey = (
  provider: AiProvider,
  key: string,
): boolean => {
  if (provider === "anthropic") return key.startsWith("sk-ant-");
  if (provider === "openai")
    return key.startsWith("sk-") && !key.startsWith("sk-ant-");
  return Boolean(key.trim());
};
