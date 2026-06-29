export type TranscriptOpenAiKeySource = "controller" | "global";

export type TranscriptOpenAiKeyResolution =
  | {
      ok: true;
      apiKey: string;
      source: TranscriptOpenAiKeySource;
    }
  | {
      ok: false;
      message: string;
    };

const normalizeOpenAiApiKey = (value: string | undefined): string =>
  value?.trim() || "";

const isPlausibleOpenAiApiKey = (value: string): boolean =>
  value.startsWith("sk-");

export const hasGlobalOpenAiApiKey = (env: {
  OPENAI_API_KEY?: string;
}): boolean => Boolean(normalizeOpenAiApiKey(env.OPENAI_API_KEY));

export const resolveTranscriptOpenAiApiKey = (options: {
  providedApiKey?: string;
  globalApiKey?: string;
}): TranscriptOpenAiKeyResolution => {
  const providedApiKey = normalizeOpenAiApiKey(options.providedApiKey);
  if (providedApiKey) {
    if (!isPlausibleOpenAiApiKey(providedApiKey)) {
      return { ok: false, message: "A valid OpenAI API key is required." };
    }
    return { ok: true, apiKey: providedApiKey, source: "controller" };
  }

  const globalApiKey = normalizeOpenAiApiKey(options.globalApiKey);
  if (globalApiKey) {
    if (!isPlausibleOpenAiApiKey(globalApiKey)) {
      return {
        ok: false,
        message: "The shared OpenAI API key is misconfigured.",
      };
    }
    return { ok: true, apiKey: globalApiKey, source: "global" };
  }

  return { ok: false, message: "A valid OpenAI API key is required." };
};
