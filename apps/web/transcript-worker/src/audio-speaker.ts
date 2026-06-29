import type { TranscriptSpeaker } from "@conclave/meeting-core/transcript-types";

export const isSameTranscriptAudioSpeaker = (
  left: TranscriptSpeaker,
  right: TranscriptSpeaker,
): boolean => left.userId === right.userId && left.source === right.source;

export const canCommitPendingAudioForSpeaker = (
  latestSpeaker: TranscriptSpeaker | null,
  requestedSpeaker: TranscriptSpeaker,
): boolean =>
  !latestSpeaker || isSameTranscriptAudioSpeaker(latestSpeaker, requestedSpeaker);
