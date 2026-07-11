import type {
  TranscriptProviderKeyAvailability,
  TranscriptTranscriptionProvider,
} from "@conclave/meeting-core/transcript-models";

type TranscriptOpenAiKeySource = "controller" | "global";

export type TranscriptProviderKeyResolution =
  | {
      ok: true;
      apiKey: string;
      source: TranscriptOpenAiKeySource;
    }
  | {
      ok: false;
      message: string;
    };

export type TranscriptOpenAiKeyResolution = TranscriptProviderKeyResolution;

type TranscriptProviderKeyEnv = {
  OPENAI_API_KEY?: string;
  SARVAM_API_KEY?: string;
};

const normalizeProviderApiKey = (value: string | undefined): string =>
  value?.trim() || "";

const isPlausibleOpenAiApiKey = (value: string): boolean =>
  value.startsWith("sk-");

const providerLabel = (provider: TranscriptTranscriptionProvider): string =>
  provider === "sarvam" ? "Sarvam" : "OpenAI";

const globalProviderKey = (
  env: TranscriptProviderKeyEnv,
  provider: TranscriptTranscriptionProvider,
): string | undefined =>
  provider === "sarvam" ? env.SARVAM_API_KEY : env.OPENAI_API_KEY;

const isPlausibleProviderApiKey = (
  provider: TranscriptTranscriptionProvider,
  value: string,
): boolean => (provider === "openai" ? isPlausibleOpenAiApiKey(value) : true);

export const hasGlobalOpenAiApiKey = (env: TranscriptProviderKeyEnv): boolean =>
  Boolean(normalizeProviderApiKey(env.OPENAI_API_KEY));

export const hasGlobalTranscriptProviderApiKey = (
  env: TranscriptProviderKeyEnv,
  provider: TranscriptTranscriptionProvider,
): boolean => Boolean(normalizeProviderApiKey(globalProviderKey(env, provider)));

export const getGlobalTranscriptProviderKeyAvailability = (
  env: TranscriptProviderKeyEnv,
): TranscriptProviderKeyAvailability => ({
  openai: hasGlobalTranscriptProviderApiKey(env, "openai"),
  sarvam: hasGlobalTranscriptProviderApiKey(env, "sarvam"),
});

export const resolveTranscriptProviderApiKey = (options: {
  provider: TranscriptTranscriptionProvider;
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
    if (!isPlausibleProviderApiKey(options.provider, providedApiKey)) {
      return { ok: false, message: missingMessage };
    }
    return { ok: true, apiKey: providedApiKey, source: "controller" };
  }

  const globalApiKey = normalizeProviderApiKey(options.globalApiKey);
  if (globalApiKey) {
    if (!isPlausibleProviderApiKey(options.provider, globalApiKey)) {
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
