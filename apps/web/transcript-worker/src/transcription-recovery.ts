import { TRANSCRIPTION_RECOVERY_DELAYS_MS } from "./constants";

export const isRetryableTranscriptionFailure = (message: string): boolean => {
  if (
    /invalid (?:api )?key|unauthori[sz]ed|forbidden|authentication|permission denied|\b(?:400|401|403|404|422)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return /disconnect|connection|network|socket|stream failed|timed? out|timeout|temporar|unavailable|try again|rate limit|too many requests|maximum duration|session expired|\b429\b|\b5\d\d\b/i.test(
    message,
  );
};

export const transcriptionRecoveryDelayMs = (attempt: number): number =>
  TRANSCRIPTION_RECOVERY_DELAYS_MS[
    Math.min(
      Math.max(0, Math.floor(attempt)),
      TRANSCRIPTION_RECOVERY_DELAYS_MS.length - 1,
    )
  ] ?? 0;
