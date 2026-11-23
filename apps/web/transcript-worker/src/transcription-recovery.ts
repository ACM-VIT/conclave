import type {
  TranscriptSpeaker,
} from "@conclave/meeting-core/transcript-types";
import {
  TRANSCRIPTION_RECOVERY_DELAYS_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS,
  TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES,
  TRANSCRIPTION_RECOVERY_MAX_EVENTS,
} from "./constants";

export type BufferedTranscriptAudioEvent =
  | {
      type: "chunk";
      audio: string;
      speaker: TranscriptSpeaker;
      sampleCount: number;
      createdAt: number;
    }
  | {
      type: "commit" | "clear";
      speaker: TranscriptSpeaker;
      createdAt: number;
    };

const eventBytes = (event: BufferedTranscriptAudioEvent): number =>
  event.type === "chunk" ? event.audio.length : 0;

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

/**
 * Audio and turn events that arrive while no provider is connected. It
 * shares the room's one replay audio budget with the audio lines already
 * hold, which `heldElsewhere` reports, and lets its oldest events go first.
 */
export class TranscriptRecoveryAudioBuffer {
  private events: BufferedTranscriptAudioEvent[] = [];
  private bytes = 0;
  private droppedEvents = 0;

  constructor(private readonly heldElsewhere: () => number = () => 0) {}

  enqueue(event: BufferedTranscriptAudioEvent, now = Date.now()): void {
    this.events.push(event);
    this.bytes += eventBytes(event);
    this.prune(now);
  }

  enqueueMany(events: BufferedTranscriptAudioEvent[], now = Date.now()): void {
    for (const event of events) {
      this.events.push(event);
      this.bytes += eventBytes(event);
    }
    this.prune(now);
  }

  drain(): BufferedTranscriptAudioEvent[] {
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    return events;
  }

  reset(): void {
    this.events = [];
    this.bytes = 0;
    this.droppedEvents = 0;
  }

  consumeDroppedEventCount(): number {
    const count = this.droppedEvents;
    this.droppedEvents = 0;
    return count;
  }

  private prune(now: number): void {
    const cutoff = now - TRANSCRIPTION_RECOVERY_MAX_AUDIO_AGE_MS;
    const budget = TRANSCRIPTION_RECOVERY_MAX_AUDIO_BYTES - this.heldElsewhere();
    while (
      this.events.length > 0 &&
      (this.events.length > TRANSCRIPTION_RECOVERY_MAX_EVENTS ||
        this.bytes > budget ||
        (this.events[0]?.createdAt ?? now) < cutoff)
    ) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= eventBytes(removed);
      this.droppedEvents += 1;
    }
  }
}

