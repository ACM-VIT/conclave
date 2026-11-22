import type { TranscriptTranscriptionProvider } from "@conclave/ai/models";
import {
  CAPTION_LANGUAGES,
  captionLanguageLabel,
  captionLanguagesFor,
} from "@conclave/meeting-core/caption-languages";

export {
  CAPTION_LANGUAGES,
  captionLanguageCode,
  captionLanguageLabel,
  captionLanguagesFor,
  captionProviderCode,
} from "@conclave/meeting-core/caption-languages";

export const DEFAULT_CAPTION_LANGUAGE = "en";
const STORAGE_KEY = "conclave:captions-language";

export function captionLanguageFor(
  provider: TranscriptTranscriptionProvider,
  preferred: string,
): string {
  return captionLanguagesFor(provider).some(({ code }) => code === preferred)
    ? preferred
    : DEFAULT_CAPTION_LANGUAGE;
}

/**
 * The label for "nobody picked a language": the worker's default for the
 * provider, Auto-detect when that default detects the language, or plain
 * Default for a worker that does not say.
 */
export function defaultCaptionLanguageLabel(
  defaultLanguage: string | null | undefined,
): string {
  if (defaultLanguage === undefined) return "Default";
  const label = captionLanguageLabel(defaultLanguage);
  return label ? `Default (${label})` : "Auto-detect";
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
