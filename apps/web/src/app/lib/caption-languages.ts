import type { TranscriptTranscriptionProvider } from "@conclave/ai/models";

interface CaptionLanguage {
  code: string;
  label: string;
  sarvam: boolean;
}

export const CAPTION_LANGUAGES: readonly CaptionLanguage[] = [
  { code: "en", label: "English", sarvam: true },
  { code: "hi", label: "Hindi", sarvam: true },
  { code: "bn", label: "Bengali", sarvam: true },
  { code: "gu", label: "Gujarati", sarvam: true },
  { code: "kn", label: "Kannada", sarvam: true },
  { code: "ml", label: "Malayalam", sarvam: true },
  { code: "mr", label: "Marathi", sarvam: true },
  { code: "pa", label: "Punjabi", sarvam: true },
  { code: "ta", label: "Tamil", sarvam: true },
  { code: "te", label: "Telugu", sarvam: true },
  { code: "ur", label: "Urdu", sarvam: true },
  { code: "ar", label: "Arabic", sarvam: false },
  { code: "zh", label: "Chinese", sarvam: false },
  { code: "fr", label: "French", sarvam: false },
  { code: "de", label: "German", sarvam: false },
  { code: "id", label: "Indonesian", sarvam: false },
  { code: "it", label: "Italian", sarvam: false },
  { code: "ja", label: "Japanese", sarvam: false },
  { code: "ko", label: "Korean", sarvam: false },
  { code: "pt", label: "Portuguese", sarvam: false },
  { code: "ru", label: "Russian", sarvam: false },
  { code: "es", label: "Spanish", sarvam: false },
  { code: "tr", label: "Turkish", sarvam: false },
  { code: "vi", label: "Vietnamese", sarvam: false },
];

export const DEFAULT_CAPTION_LANGUAGE = "en";
const STORAGE_KEY = "conclave:captions-language";

export function captionLanguagesFor(
  provider: TranscriptTranscriptionProvider,
): readonly CaptionLanguage[] {
  return provider === "sarvam"
    ? CAPTION_LANGUAGES.filter((language) => language.sarvam)
    : CAPTION_LANGUAGES;
}

export function captionLanguageFor(
  provider: TranscriptTranscriptionProvider,
  preferred: string,
): string {
  return captionLanguagesFor(provider).some(({ code }) => code === preferred)
    ? preferred
    : DEFAULT_CAPTION_LANGUAGE;
}

export function captionLanguageLabel(code: string | undefined): string {
  return (
    CAPTION_LANGUAGES.find((language) => language.code === code)?.label ??
    code ??
    ""
  );
}

/**
 * The label for "nobody picked a language": the worker's default for the
 * provider, Auto-detect when that default detects the language, or plain
 * Default for a worker that does not say.
 */
export function defaultCaptionLanguageLabel(
  defaultLanguage: string | null | undefined,
): string {
  if (defaultLanguage === null) return "Auto-detect";
  if (defaultLanguage === undefined) return "Default";
  return `Default (${captionLanguageLabel(defaultLanguage)})`;
}

/** The language this browser last picked, or null when it never picked one. */
export function readCaptionLanguage(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return CAPTION_LANGUAGES.some(({ code }) => code === stored) ? stored : null;
  } catch {
    return null;
  }
}

export function saveCaptionLanguage(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {}
}
