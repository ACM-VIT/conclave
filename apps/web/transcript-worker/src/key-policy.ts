import {
  AI_PROVIDERS,
  getProviderApiKey,
  getResponseProvider,
  isProviderApiKey,
  type AiEnvironment,
  type AiProvider,
  type TranscriptTranscriptionProvider,
} from "@conclave/ai/models";
import type { TranscriptProviderKeyAvailability } from "@conclave/meeting-core/transcript-models";

type TranscriptProviderKeySource = "controller" | "global";

export type TranscriptProviderKeyResolution =
  | {
      ok: true;
      apiKey: string;
      source: TranscriptProviderKeySource;
    }
  | {
      ok: false;
      message: string;
    };

export type TranscriptOpenAiKeyResolution = TranscriptProviderKeyResolution;

type TranscriptProviderKeyEnv = AiEnvironment;

const normalizeProviderApiKey = (value: string | undefined): string =>
  value?.trim() || "";

const providerLabel = (provider: AiProvider): string =>
  AI_PROVIDERS[provider].label;

const globalProviderKey = (
  env: TranscriptProviderKeyEnv,
  provider: AiProvider,
): string | undefined => getProviderApiKey(env, provider);

export const hasGlobalOpenAiApiKey = (env: TranscriptProviderKeyEnv): boolean =>
  Boolean(normalizeProviderApiKey(env.OPENAI_API_KEY));

export const hasGlobalTranscriptProviderApiKey = (
  env: TranscriptProviderKeyEnv,
  provider: AiProvider,
): boolean =>
  Boolean(normalizeProviderApiKey(globalProviderKey(env, provider)));

export const getGlobalTranscriptProviderKeyAvailability = (
  env: TranscriptProviderKeyEnv,
): TranscriptProviderKeyAvailability => ({
  openai: hasGlobalTranscriptProviderApiKey(env, "openai"),
  sarvam: hasGlobalTranscriptProviderApiKey(env, "sarvam"),
  anthropic: hasGlobalTranscriptProviderApiKey(env, "anthropic"),
});

export const resolveTranscriptProviderApiKey = (options: {
  provider: AiProvider;
  providedApiKey?: string;
  globalApiKey?: string;
  missingMessage?: string;
  misconfiguredMessage?: string;
}): TranscriptProviderKeyResolution => {
  const label = providerLabel(options.provider);
  const missingMessage =
    options.missingMessage ?? `A valid ${label} API key is required.`;
  const misconfiguredMessage =
    options.misconfiguredMessage ??
    `The shared ${label} API key is misconfigured.`;
  const providedApiKey = normalizeProviderApiKey(options.providedApiKey);
  if (providedApiKey) {
    if (!isProviderApiKey(options.provider, providedApiKey)) {
      return { ok: false, message: missingMessage };
    }
    return { ok: true, apiKey: providedApiKey, source: "controller" };
  }

  const globalApiKey = normalizeProviderApiKey(options.globalApiKey);
  if (globalApiKey) {
    if (!isProviderApiKey(options.provider, globalApiKey)) {
      return { ok: false, message: misconfiguredMessage };
    }
    return { ok: true, apiKey: globalApiKey, source: "global" };
  }

  return { ok: false, message: missingMessage };
};

export const resolveTranscriptOpenAiApiKey = (options: {
  providedApiKey?: string;
  globalApiKey?: string;
}): TranscriptOpenAiKeyResolution => {
  return resolveTranscriptProviderApiKey({
    provider: "openai",
    providedApiKey: options.providedApiKey,
    globalApiKey: options.globalApiKey,
    missingMessage: "A valid OpenAI API key is required.",
    misconfiguredMessage: "The shared OpenAI API key is misconfigured.",
  });
};

export const resolveTranscriptResponseApiKey = (options: {
  env: AiEnvironment;
  model: string;
  transcriptionProvider: TranscriptTranscriptionProvider;
  transcriptionApiKey?: string;
  assistantApiKey?: string;
}): TranscriptProviderKeyResolution => {
  const provider = getResponseProvider(options.model);
  return resolveTranscriptProviderApiKey({
    provider,
    providedApiKey:
      options.assistantApiKey ||
      (provider === options.transcriptionProvider
        ? options.transcriptionApiKey
        : undefined),
    globalApiKey: getProviderApiKey(options.env, provider),
    missingMessage: `A valid ${AI_PROVIDERS[provider].label} API key is required for Ask and Minutes.`,
  });
};
