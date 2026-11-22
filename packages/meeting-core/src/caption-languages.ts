import type { TranscriptTranscriptionProvider } from "@conclave/ai/models";

export interface CaptionLanguage {
  code: string;
  label: string;
  openai: boolean;
  sarvam: boolean;
}

/**
 * One table for every caption language, keyed by the code clients pick and
 * show. Providers' own codes, such as Sarvam's "od-IN" or a deployment
 * language like "ta-IN", map to these through captionLanguageCode().
 */
export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = [
  { code: "en", label: "English", openai: true, sarvam: true },
  { code: "hi", label: "Hindi", openai: true, sarvam: true },
  { code: "bn", label: "Bengali", openai: true, sarvam: true },
  { code: "gu", label: "Gujarati", openai: true, sarvam: true },
  { code: "kn", label: "Kannada", openai: true, sarvam: true },
  { code: "ml", label: "Malayalam", openai: true, sarvam: true },
  { code: "mr", label: "Marathi", openai: true, sarvam: true },
  { code: "pa", label: "Punjabi", openai: true, sarvam: true },
  { code: "ta", label: "Tamil", openai: true, sarvam: true },
  { code: "te", label: "Telugu", openai: true, sarvam: true },
  { code: "ur", label: "Urdu", openai: true, sarvam: true },
  { code: "od", label: "Odia", openai: false, sarvam: true },
  { code: "as", label: "Assamese", openai: false, sarvam: true },
  { code: "ne", label: "Nepali", openai: false, sarvam: true },
  { code: "kok", label: "Konkani", openai: false, sarvam: true },
  { code: "ks", label: "Kashmiri", openai: false, sarvam: true },
  { code: "sd", label: "Sindhi", openai: false, sarvam: true },
  { code: "sa", label: "Sanskrit", openai: false, sarvam: true },
  { code: "sat", label: "Santali", openai: false, sarvam: true },
  { code: "mni", label: "Manipuri", openai: false, sarvam: true },
  { code: "brx", label: "Bodo", openai: false, sarvam: true },
  { code: "mai", label: "Maithili", openai: false, sarvam: true },
  { code: "doi", label: "Dogri", openai: false, sarvam: true },
  { code: "ar", label: "Arabic", openai: true, sarvam: false },
  { code: "zh", label: "Chinese", openai: true, sarvam: false },
  { code: "fr", label: "French", openai: true, sarvam: false },
  { code: "de", label: "German", openai: true, sarvam: false },
  { code: "id", label: "Indonesian", openai: true, sarvam: false },
  { code: "it", label: "Italian", openai: true, sarvam: false },
  { code: "ja", label: "Japanese", openai: true, sarvam: false },
  { code: "ko", label: "Korean", openai: true, sarvam: false },
  { code: "pt", label: "Portuguese", openai: true, sarvam: false },
  { code: "ru", label: "Russian", openai: true, sarvam: false },
  { code: "es", label: "Spanish", openai: true, sarvam: false },
  { code: "tr", label: "Turkish", openai: true, sarvam: false },
  { code: "vi", label: "Vietnamese", openai: true, sarvam: false },
];

export const captionLanguagesFor = (
  provider: TranscriptTranscriptionProvider,
): readonly CaptionLanguage[] =>
  CAPTION_LANGUAGES.filter((language) =>
    provider === "sarvam" ? language.sarvam : language.openai,
  );

/**
 * The picker code for a code a provider or session reports: "ta-IN" and
 * "ta" are Tamil. A code the table does not know stays as it is, and none,
 * or Sarvam's "unknown", means auto-detect.
 */
export const captionLanguageCode = (
  code: string | null | undefined,
): string | undefined => {
  const trimmed = code?.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") return undefined;
  const base = trimmed.toLowerCase().split("-")[0];
  return CAPTION_LANGUAGES.find((language) => language.code === base)?.code ?? trimmed;
};

/**
 * The exact code a provider is sent for a language picked from the table:
 * Sarvam takes the regional code ("hi-IN"), OpenAI the language code.
 */
export const captionProviderCode = (
  provider: TranscriptTranscriptionProvider,
  code: string,
): string => (provider === "sarvam" ? `${code}-IN` : code);

/** What to call a reported code: its language, or the code itself; undefined is auto-detect. */
export const captionLanguageLabel = (
  code: string | null | undefined,
): string | undefined => {
  const normalized = captionLanguageCode(code);
  if (!normalized) return undefined;
  return CAPTION_LANGUAGES.find((language) => language.code === normalized)?.label ?? normalized;
};
