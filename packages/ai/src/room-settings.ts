import {
  AI_DEFAULT_MODELS,
  getResponseProvider,
  getTranscriptTranscriptionProvider,
  isResponseModel,
  LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS,
  type AiEnvironment,
  type AiProvider,
  type TranscriptReasoningEffort,
  type TranscriptTextVerbosity,
} from "@conclave/ai/models";

import { AI_GENERATION_LIMITS } from "@conclave/ai/limits";
export { AI_GENERATION_LIMITS } from "@conclave/ai/limits";

export const AI_FEATURES = {
  assistant: {
    label: "Chat assistant",
    kind: "text",
    model: AI_DEFAULT_MODELS.assistant,
  },
  games: { label: "Games", kind: "text", model: AI_DEFAULT_MODELS.games },
  minutes: {
    label: "Meeting notes",
    kind: "text",
    model: AI_DEFAULT_MODELS.assistant,
  },
  questions: {
    label: "Transcript questions",
    kind: "text",
    model: AI_DEFAULT_MODELS.assistant,
  },
  transcription: {
    label: "Transcription",
    kind: "audio",
    model: AI_DEFAULT_MODELS.transcript,
  },
  images: {
    label: "Image safety",
    kind: "image",
    model: AI_DEFAULT_MODELS.moderation,
  },
  voice: {
    label: "Voice assistant",
    kind: "realtime",
    model: AI_DEFAULT_MODELS.voice,
  },
  speech: {
    label: "Cloned speech",
    kind: "speech",
    model: AI_DEFAULT_MODELS.tts,
  },
} as const;
export type AiFeature = keyof typeof AI_FEATURES;
export type AiFeatureSettings = {
  enabled: boolean;
  model: string;
  maxOutputTokens: number;
  researchTokens: number;
  timeoutMs: number;
  searchEnabled: boolean;
  maxSearchUses: number;
  reasoningEffort: TranscriptReasoningEffort | "default";
  verbosity: TranscriptTextVerbosity | "default";
  instructions: string;
};
export type RoomAiFeatureSettings = Partial<
  Record<AiFeature, Partial<AiFeatureSettings>>
>;
export const isAiFeature = (value: unknown): value is AiFeature =>
  typeof value === "string" && Object.hasOwn(AI_FEATURES, value);
export const featureProvider = (
  feature: AiFeature,
  model: string,
): AiProvider =>
  AI_FEATURES[feature].kind === "text"
    ? getResponseProvider(model)
    : feature === "transcription"
      ? getTranscriptTranscriptionProvider(model)
      : feature === "speech"
        ? "elevenlabs"
        : "openai";

export function validateFeaturePatch(
  feature: AiFeature,
  input: unknown,
): Partial<AiFeatureSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Choose valid AI settings.");
  const patch: Partial<AiFeatureSettings> = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === "model") {
      const valid =
        typeof value === "string" &&
        (AI_FEATURES[feature].kind === "text"
          ? isResponseModel(value)
          : feature === "transcription"
            ? LIVE_TRANSCRIPT_TRANSCRIPTION_MODELS.some(
                (model) => model.id === value,
              )
            : feature === "images"
              ? /^omni-moderation-(latest|\d{4}-\d{2}-\d{2})$/.test(value)
              : feature === "voice"
                ? /^gpt-realtime(?:-[\w.-]+)?$/.test(value)
                : /^eleven_[a-z0-9_]+$/.test(value));
      if (!valid) throw new Error("Choose a supported model for this feature.");
      patch.model = value;
    } else if (field === "enabled" || field === "searchEnabled") {
      if (typeof value !== "boolean")
        throw new Error("Choose a valid on/off setting.");
      patch[field] = value;
    } else if (
      field === "maxOutputTokens" ||
      field === "researchTokens" ||
      field === "timeoutMs" ||
      field === "maxSearchUses"
    ) {
      const [min, max] =
        field === "timeoutMs"
          ? [5_000, AI_GENERATION_LIMITS.maxTimeoutMs]
          : field === "maxSearchUses"
            ? [1, 30]
            : [128, AI_GENERATION_LIMITS.maxOutputTokens];
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
      )
        throw new Error(`Choose ${field} between ${min} and ${max}.`);
      patch[field] = value;
    } else if (field === "reasoningEffort") {
      if (
        !["default", "low", "medium", "high", "xhigh", "max"].includes(
          String(value),
        )
      )
        throw new Error("Choose a supported reasoning effort.");
      patch.reasoningEffort = value as AiFeatureSettings["reasoningEffort"];
    } else if (field === "verbosity") {
      if (!["default", "low", "medium", "high"].includes(String(value)))
        throw new Error("Choose a supported answer length.");
      patch.verbosity = value as AiFeatureSettings["verbosity"];
    } else if (field === "instructions") {
      if (typeof value !== "string" || value.length > 32_000)
        throw new Error("Instructions must be under 32,000 characters.");
      patch.instructions = value.trim();
    } else throw new Error("Unknown AI setting.");
  }
  if (!Object.keys(patch).length)
    throw new Error("Choose a setting to change.");
  return patch;
}

export function parseRoomAiFeatureSettings(
  value: unknown,
): RoomAiFeatureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([feature, patch]) => {
      if (!isAiFeature(feature)) throw new Error("Unknown AI feature.");
      return [feature, validateFeaturePatch(feature, patch)];
    }),
  );
}

export function resolveAiFeatureSettings(
  env: AiEnvironment,
  feature: AiFeature,
  settings?: RoomAiFeatureSettings,
): AiFeatureSettings {
  if (!settings) {
    settings = roomAiFeatureSettingsFromEnvironment(env);
  }
  return {
    enabled: true,
    model:
      AI_FEATURES[feature].kind === "text"
        ? env.CONCLAVE_ASSISTANT_MODEL || AI_FEATURES[feature].model
        : AI_FEATURES[feature].model,
    maxOutputTokens: AI_GENERATION_LIMITS.outputTokens,
    researchTokens: AI_GENERATION_LIMITS.researchTokens,
    timeoutMs:
      feature === "transcription" ? 30_000 : AI_GENERATION_LIMITS.timeoutMs,
    searchEnabled: feature === "assistant" || feature === "games",
    maxSearchUses: 10,
    reasoningEffort: "default",
    verbosity: "default",
    instructions: "",
    ...settings[feature],
  };
}

export function roomAiFeatureSettingsFromEnvironment(
  env: AiEnvironment,
): RoomAiFeatureSettings {
  try {
    return parseRoomAiFeatureSettings(
      JSON.parse(env.CONCLAVE_AI_SETTINGS || "{}") as unknown,
    );
  } catch {
    return {};
  }
}
