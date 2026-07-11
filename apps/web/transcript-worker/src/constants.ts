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
// Auto-minutes debounce: regenerate once the room has been quiet for this long
// after the last finalized segment, so we never rewrite minutes mid-sentence.
export const MINUTES_QUIET_DEBOUNCE_MS = 7_000;
// Hard cap so a continuous monologue still refreshes minutes periodically even
// if the quiet window never arrives.
export const MINUTES_MAX_WAIT_MS = 45_000;
// Like Codex context compaction, periodically replace the larger incremental
// working memory with a bounded canonical summary before it becomes unwieldy.
export const MINUTES_COMPACTION_INTERVAL_MS = 12 * 60 * 1000;
// Don't auto-generate minutes until there's enough spoken content to summarize;
// below this we keep the "cooking up minutes" placeholder instead of echoing the
// transcript back as a summary.
export const MINUTES_MIN_WORDS = 24;
export const MAX_CLIENT_MESSAGE_BYTES = 192 * 1024;
export const MAX_AUDIO_CHUNK_BASE64_BYTES = 48 * 1024;
export const SFU_RELAY_DISCONNECT_SUPPRESSION_MS = 15000;
export const TRANSCRIPT_CONTROLLER_RECONNECT_GRACE_MS = 2 * 60 * 1000;
export const TRANSCRIPT_SFU_RELAY_RECOVERY_GRACE_MS = 15_000;
export const TRANSCRIPT_SFU_RELAY_RECOVERY_ATTEMPTS = 8;
export const TRANSCRIPTION_CONNECT_TIMEOUT_MS = 10_000;
export const TRANSCRIPTION_COMMIT_ACK_TIMEOUT_MS = 45_000;
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
export const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
export const OPENAI_REALTIME_TRANSCRIPTION_INTENT = "transcription";
