import { AI_ENDPOINTS } from "@conclave/ai/models";
import {
  DEFAULT_TRANSCRIPT_QA_MODEL,
  DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL,
} from "@conclave/meeting-core/transcript-models";

export const DEFAULT_TRANSCRIPT_MODEL: string =
  DEFAULT_TRANSCRIPT_TRANSCRIPTION_MODEL;
export const DEFAULT_QA_MODEL: string = DEFAULT_TRANSCRIPT_QA_MODEL;
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_TRANSCRIPTION_LOCALE = "en-IN";
export const DEFAULT_TRANSCRIPTION_DELAY = "medium";
export const DEFAULT_TRANSCRIPTION_LOCALIZATION_PROMPT =
  "Locale: Indian English. Expect Indian accents, Hinglish code-switching, Hindi proper nouns, Indian names, college or team names, acronyms, and technical terms. Preserve spoken wording without expanding or correcting domain terms unless the audio makes it clear.";
export const DEFAULT_IDLE_TTL_MS = 20 * 60 * 1000;
export const DEFAULT_RECOVERY_RETENTION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_MAX_SEGMENTS = 500;
const TRANSCRIPT_PCM_SAMPLE_RATE = 24_000;
const MIN_OPENAI_COMMIT_AUDIO_MS = 100;
export const MIN_OPENAI_COMMIT_AUDIO_SAMPLES = Math.ceil(
  (TRANSCRIPT_PCM_SAMPLE_RATE * MIN_OPENAI_COMMIT_AUDIO_MS) / 1000,
);
export const MINUTES_QUIET_DEBOUNCE_MS = 7_000;
export const MINUTES_MAX_WAIT_MS = 45_000;
export const MINUTES_COMPACTION_INTERVAL_MS = 12 * 60 * 1000;
export const MINUTES_MIN_WORDS = 24;
export const MAX_CLIENT_MESSAGE_BYTES = 192 * 1024;
export const MAX_AUDIO_CHUNK_BASE64_BYTES = 48 * 1024;
export const SFU_RELAY_DISCONNECT_SUPPRESSION_MS = 15000;
export const TRANSCRIPT_CONTROLLER_RECONNECT_GRACE_MS = 2 * 60 * 1000;
export const TRANSCRIPT_SFU_RELAY_RECOVERY_GRACE_MS = 15_000;
export const TRANSCRIPT_SFU_RELAY_RECOVERY_ATTEMPTS = 8;
export const TRANSCRIPTION_CONNECT_TIMEOUT_MS = 10_000;
export const TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS = 45_000;
export const TRANSCRIPTION_PROVIDER_DRAIN_MS = 10_000;
/** How long a line a provider accepted waits for its final before it ends as its words or a gap. */
export const TRANSCRIPTION_LINE_DEADLINE_MS = 30_000;
/** Shown in place of a line our side heard speech in that its provider never finished. */
export const TRANSCRIPTION_GAP_MARKER = "[Some speech here was not captioned]";
/** How long audio no line owns is kept for a late speech signal to claim; it is never replayed on its own. */
export const UNOWNED_AUDIO_KEPT_MS = 3_000;
// Sequence numbers reserved for a replaced provider's late lines, so speech
// from before a language switch sorts ahead of the new provider's.
export const TRANSCRIPTION_DRAIN_SEQUENCE_BLOCK = 64;
export const TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS = 2 * 60 * 1000;
export const TRANSCRIPTION_RECOVERY_MAX_EVENTS = 2_000;
export const TRANSCRIPTION_RECOVERY_DELAYS_MS = [
  0,
  250,
  750,
  1_500,
  3_000,
  5_000,
  8_000,
  10_000,
] as const;
export const OPENAI_REALTIME_URL = AI_ENDPOINTS.openai.realtime;
export const OPENAI_REALTIME_TRANSCRIPTION_INTENT = "transcription";
